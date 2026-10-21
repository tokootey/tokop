'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { openDb, getSetting, setSetting, COUNTRY_PRESETS } = require('./db');
const { hashPassword, passwordProblem } = require('./auth');
const { fail } = require('./util');

/**
 * Varias empresas en una sola instalación.
 *
 * Cada empresa tiene su propia base SQLite (reservas, flota, clientes, usuarios, tarifas y configuración):
 * los datos quedan separados por construcción, no por un filtro en cada consulta.
 * El registro de empresas vive en "empresas.db", al lado de la base principal.
 *
 * La base que ya existía pasa a ser la empresa 1 ("principal") tal cual está, sin mover nada.
 * Los administradores de la empresa principal son los que dan de alta las demás.
 */
const PRINCIPAL_ID = 1;

/**
 * Subdominios que nunca son de una agencia: "app" es la entrada del dueño de Floty (app.flotyapp.com.ar)
 * y los demás quedan para la página web y servicios propios.
 */
const RESERVED = new Set(['app', 'www', 'api', 'admin', 'panel', 'mail', 'email', 'blog', 'ayuda', 'soporte', 'floty', 'principal']);

/** "Reservas.SuAgencia.com.ar:443" → "reservas.suagencia.com.ar" ('' si no hay). */
const normHost = (h) =>
  String(h || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/:].*$/, '')
    .replace(/\.$/, '');

function openPlatform(principalDb, principalFile) {
  const dir = path.dirname(path.resolve(principalFile));
  const reg = new DatabaseSync(path.join(dir, 'empresas.db'));
  reg.exec(`CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    db_file TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  // Dominio propio de la empresa (reservas.suagencia.com.ar); vacío = sólo su subdominio de Floty.
  if (!reg.prepare('PRAGMA table_info(companies)').all().some((c) => c.name === 'domain')) reg.exec('ALTER TABLE companies ADD COLUMN domain TEXT');
  if (!reg.prepare('SELECT 1 FROM companies WHERE id = ?').get(PRINCIPAL_ID)) {
    reg
      .prepare('INSERT INTO companies (id, slug, name, db_file) VALUES (?, ?, ?, ?)')
      .run(PRINCIPAL_ID, 'principal', getSetting(principalDb, 'company_name') || 'Empresa principal', path.basename(principalFile));
  }

  // Las rutas de las bases se guardan relativas a la carpeta de datos: la instalación se puede mover.
  const fileOf = (c) => path.resolve(dir, c.db_file);
  const open = new Map([[PRINCIPAL_ID, principalDb]]);
  const dbOf = (c) => {
    if (!open.has(c.id)) open.set(c.id, openDb(fileOf(c)));
    return open.get(c.id);
  };
  const withDb = (c) => (c ? { ...c, principal: c.id === PRINCIPAL_ID, db: dbOf(c) } : null);
  const all = () => reg.prepare('SELECT * FROM companies WHERE active = 1 ORDER BY id').all();
  // Dirección de cada empresa: su dominio propio o, si la instalación tiene FLOTY_DOMAIN, su subdominio.
  const addressOf = (c) => {
    const base = normHost(process.env.FLOTY_DOMAIN);
    if (c.domain) return `https://${c.domain}`;
    if (!base) return null;
    // El dominio a secas suele ser la página web de Floty: la empresa principal entra por app.<dominio>.
    return c.id === PRINCIPAL_ID ? `https://app.${base}` : `https://${c.slug}.${base}`;
  };

  const platform = {
    dir,
    principal: () => withDb(reg.prepare('SELECT * FROM companies WHERE id = ?').get(PRINCIPAL_ID)),
    get: (id) => withDb(reg.prepare('SELECT * FROM companies WHERE id = ? AND active = 1').get(Number(id))),
    bySlug: (slug) => withDb(reg.prepare('SELECT * FROM companies WHERE slug = ? AND active = 1').get(String(slug))),
    list: () => all().map((c) => ({ ...c, principal: c.id === PRINCIPAL_ID, address: addressOf(c) })),

    /**
     * Empresa por la dirección con la que se entra: su dominio propio, o su subdominio de Floty
     * (<código>.<FLOTY_DOMAIN>, por ejemplo andes.floty.app). Sin coincidencia: null (se usa la regla de siempre).
     */
    byHost(host) {
      const h = normHost(host);
      if (!h) return null;
      const own = reg.prepare('SELECT * FROM companies WHERE domain = ? AND active = 1').get(h);
      if (own) return withDb(own);
      const base = normHost(process.env.FLOTY_DOMAIN);
      if (!base || !h.endsWith(`.${base}`)) return null;
      const label = h.slice(0, -(base.length + 1));
      // app.<dominio> y los otros reservados no son de ninguna agencia: siguen la regla de siempre (la principal).
      return label.includes('.') || RESERVED.has(label) ? null : platform.bySlug(label);
    },

    /** Guarda (o borra, con vacío) el dominio propio de una empresa. */
    setDomain(id, domain) {
      const c = reg.prepare('SELECT * FROM companies WHERE id = ? AND active = 1').get(Number(id));
      if (!c) fail(404, 'Empresa inexistente');
      const d = normHost(domain);
      if (d && !/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) fail(400, 'El dominio no es válido (por ejemplo: reservas.suagencia.com.ar)');
      const base = normHost(process.env.FLOTY_DOMAIN);
      if (d && base && (d === base || d.endsWith(`.${base}`))) fail(400, 'Ese dominio es de Floty: cada empresa ya tiene su subdominio');
      if (d && reg.prepare('SELECT 1 FROM companies WHERE domain = ? AND id <> ?').get(d, c.id)) fail(409, 'Ese dominio ya lo usa otra empresa');
      reg.prepare('UPDATE companies SET domain = ? WHERE id = ?').run(d || null, c.id);
      return { id: c.id, domain: d || null, address: addressOf({ ...c, domain: d || null }) };
    },
    /** Todas las bases abiertas, con su archivo (para las copias de seguridad). */
    databases: () => all().map((c) => ({ company: c, db: dbOf(c), file: fileOf(c) })),

    /** Empresa del usuario con ese email (los emails son únicos en toda la instalación). */
    byEmail(email) {
      for (const c of all()) {
        if (dbOf(c).prepare('SELECT 1 FROM users WHERE email = ? AND active = 1').get(String(email))) return withDb(c);
      }
      return null;
    },

    // shortcut: recorre las empresas en cada pedido; si pasan de unas decenas, guardar las claves en el registro.
    byApiKey(key) {
      if (!key) return null;
      const k = Buffer.from(String(key));
      for (const c of all()) {
        const expected = Buffer.from(String(getSetting(dbOf(c), 'api_key') || ''));
        if (expected.length === k.length && crypto.timingSafeEqual(expected, k)) return withDb(c);
      }
      return null;
    },

    emailTaken(email, exceptId) {
      return all().some((c) => c.id !== exceptId && dbOf(c).prepare('SELECT 1 FROM users WHERE email = ?').get(String(email).toLowerCase()));
    },

    /** Alta de una empresa nueva con su primer administrador. Devuelve la contraseña inicial (se cambia al entrar). */
    create({ name, country, admin_name, admin_email }) {
      name = String(name || '').trim().slice(0, 120);
      const email = String(admin_email || '').trim().toLowerCase();
      if (!name) fail(400, 'Falta el nombre de la empresa');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'El email del administrador no es válido');
      if (platform.emailTaken(email)) fail(409, 'Ese email ya lo usa un usuario de otra empresa');
      const preset = COUNTRY_PRESETS[country] || COUNTRY_PRESETS.AR;

      const baseSlug =
        name
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40) || 'empresa';
      let slug = baseSlug;
      for (let i = 2; RESERVED.has(slug) || reg.prepare('SELECT 1 FROM companies WHERE slug = ?').get(slug); i++) slug = `${baseSlug}-${i}`;

      const dbFile = path.join('empresas', `${slug}.db`);
      if (fs.existsSync(path.resolve(dir, dbFile))) fail(409, 'Ya hay una base de datos con ese nombre en el servidor');
      const db = openDb(path.resolve(dir, dbFile));
      setSetting(db, 'company_name', name);
      setSetting(db, 'country', country in COUNTRY_PRESETS ? country : 'AR');
      for (const k of ['currency', 'locale', 'tax_name', 'tax_rate', 'tax_id_label']) setSetting(db, k, preset[k]);
      // Los valores de fábrica son de la agencia de Ushuaia: la empresa nueva los completa con los suyos.
      setSetting(db, 'jurisdiction', '');
      setSetting(db, 'jurisdiction_en', '');
      setSetting(db, 'webform_allowed_origins', '');
      setSetting(db, 'webform_enabled', '0'); // se activa cuando la empresa carga su sitio web autorizado

      let password;
      do password = `Rc${crypto.randomBytes(6).toString('base64url')}${crypto.randomInt(10, 99)}`;
      while (passwordProblem(password, email));
      db.prepare("INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES (?, ?, ?, 'admin', 1)").run(
        String(admin_name || 'Administrador').slice(0, 120),
        email,
        hashPassword(password),
      );
      const r = reg.prepare('INSERT INTO companies (slug, name, db_file) VALUES (?, ?, ?)').run(slug, name, dbFile.split(path.sep).join('/'));
      open.set(Number(r.lastInsertRowid), db);
      return { company: { id: Number(r.lastInsertRowid), slug, name, address: addressOf({ slug }) }, admin: { email, password } };
    },

    close() {
      for (const db of open.values()) db.close();
      reg.close();
    },

    /** Carpeta de fotos de cada empresa: la principal sigue usando la de siempre. */
    uploadsDir: (c, principalUploads) => (c.id === PRINCIPAL_ID ? principalUploads : path.join(dir, 'empresas', `${c.slug}-archivos`)),
  };
  return platform;
}

module.exports = { openPlatform, PRINCIPAL_ID };
