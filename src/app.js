'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { DEFAULT_PASSWORD, login, logout, requireUser, requirePasswordChanged, changePassword, hashPassword, verifyPassword } = require('./auth');
const { securityHeaders, httpsRedirect, sameOrigin } = require('./security');
const { catalogRoutes } = require('./routes/catalog');
const { operationsRoutes } = require('./routes/operations');
const { adminRoutes } = require('./routes/admin');
const { publicRoutes } = require('./routes/public');
const { webformRoutes } = require('./routes/webform');
const { chatRoutes } = require('./routes/chat');
const { fileRoutes } = require('./routes/files');
const { importRoutes } = require('./routes/importer');
const { HttpError, fail } = require('./util');
const { backupStatus } = require('./backup');
const { COMPANY_FIELDS } = require('./owner-book');

/** Crea el usuario administrador inicial si no hay ninguno. */
function ensureAdmin(db) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) {
    // Instalaciones anteriores: quien siga con la contraseña de fábrica tiene que cambiarla.
    for (const u of db.prepare('SELECT id, password_hash FROM users WHERE must_change_password = 0').all()) {
      if (verifyPassword(DEFAULT_PASSWORD, u.password_hash)) db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(u.id);
    }
    return null;
  }
  const email = (process.env.ADMIN_EMAIL || 'admin@rentacar.local').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD;
  // Con la contraseña de fábrica, el primer ingreso obliga a cambiarla.
  db.prepare("INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES ('Administrador', ?, ?, 'admin', ?)").run(
    email,
    hashPassword(password),
    password === DEFAULT_PASSWORD ? 1 : 0,
  );
  return { email, password };
}

// TRUST_PROXY=1 (Render, Nginx): cantidad de proxies delante. Un número tiene que pasarse como número,
// si no Express lo toma como una dirección IP y no confía en ningún proxy.
function trustProxy(app) {
  const tp = process.env.TRUST_PROXY;
  if (tp) app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? true : tp);
}

function errorHandler(err, _req, res, _next) {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'El archivo es demasiado grande (máximo 20 MB)' });
  if (err instanceof SyntaxError) return res.status(400).json({ error: 'JSON inválido' });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err.status === 400 || err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Pedido inválido' });
  if (/UNIQUE constraint/i.test(err.message)) return res.status(409).json({ error: 'Ya existe un registro con ese código / dato único' });
  if (/FOREIGN KEY/i.test(err.message)) return res.status(409).json({ error: 'Referencia inválida o registro en uso' });
  // El detalle queda en el registro del servidor; al navegador no se le muestran datos internos.
  console.error(err);
  res.status(500).json({ error: 'Error interno. Si se repite, avisale al administrador.' });
}

/**
 * La API de una empresa: todas las rutas trabajan sólo con la base `db` de esa empresa.
 * `company` y `platform` existen sólo en una instalación con varias empresas.
 */
function companyApi(db, { uploadsDir, company, platform }) {
  const app = express();
  app.disable('x-powered-by');
  trustProxy(app);
  const prefix = company ? `${company.id}.` : '';
  const emailTaken = platform ? (email) => platform.emailTaken(email, company.id) : () => false;

  app.use('/api/public/webform', webformRoutes(db));
  app.use('/api/public/chat', chatRoutes(db));
  app.use('/api/public/v1', publicRoutes(db));

  app.post('/api/auth/login', sameOrigin, (req, res) => res.json(login(db, req, res, prefix)));
  const auth = requireUser(db);
  // La empresa va con el usuario: la pantalla la usa para armar los códigos del sitio web y la pestaña "Empresas".
  const companyInfo = (req) =>
    company
      ? {
          company: { slug: company.slug, name: company.name, principal: company.principal },
          platform_admin: isFlotyOwner(req.user, company),
          // Dueño declarado en FLOTY_OWNERS: ve solo el panel administrativo, sin las pantallas del rent a car.
          owner_mode: isFlotyOwner(req.user, company) && flotyOwners().length > 0,
        }
      : {};
  app.get('/api/auth/me', auth, (req, res) => res.json({ ...req.user, ...companyInfo(req) }));
  app.post('/api/auth/logout', sameOrigin, auth, (req, res) => {
    logout(db, req, res);
    res.json({ ok: true });
  });
  app.post('/api/auth/password', sameOrigin, auth, (req, res) => {
    changePassword(db, req);
    res.json({ ok: true });
  });
  const guarded = [sameOrigin, auth, requirePasswordChanged];
  if (platform) app.use('/api/platform', guarded, platformRoutes(platform, company));
  app.use(
    '/api',
    guarded,
    catalogRoutes(db),
    operationsRoutes(db),
    fileRoutes(db, uploadsDir),
    adminRoutes(db, { emailTaken, publicQuery: company && !company.principal ? `?empresa=${company.slug}` : '' }),
    importRoutes(db),
  );
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Ruta inexistente')));
  app.use(errorHandler);
  return app;
}

/**
 * Dueño de Floty: quien maneja las empresas y sus dominios (el "Panel de Floty").
 * Con FLOTY_OWNERS (emails separados por coma) sólo esos usuarios; sin ella, cualquier administrador
 * de la empresa principal, como hasta ahora. Los administradores de las agencias nunca.
 */
const flotyOwners = () =>
  String(process.env.FLOTY_OWNERS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

function isFlotyOwner(user, company) {
  if (!user || !company || !company.principal || user.role !== 'admin') return false;
  const owners = flotyOwners();
  return owners.length === 0 || owners.includes(String(user.email).toLowerCase());
}

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));

/** Espacio del disco donde están los datos (en Render, el disco de 5 GB). */
function diskStatus(dir) {
  try {
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize;
    return { total, used: total - s.bfree * s.bsize };
  } catch {
    return null; // sistema sin statfs: el panel no muestra el disco
  }
}

/** Panel de Floty: alta de empresas y sus dominios. Sólo el dueño de Floty. */
function platformRoutes(platform, company) {
  const router = express.Router();
  router.use((req, _res, next) => next(isFlotyOwner(req.user, company) ? null : new HttpError(403, 'Sólo el dueño de Floty maneja las empresas')));
  router.get('/companies', (_req, res) =>
    res.json(platform.list().map(({ id, slug, name, created_at, principal, domain, address }) => ({ id, slug, name, created_at, principal, domain, address }))),
  );
  // Todo lo del panel en un pedido: cada agencia con su uso, ficha y abono, los vencimientos del dueño,
  // las copias de seguridad y el disco.
  const { book } = platform;
  router.get('/overview', (_req, res) =>
    res.json({
      floty_domain: process.env.FLOTY_DOMAIN || null,
      backups: backupStatus(),
      disk: diskStatus(platform.dir),
      reminders: book.reminders().map((r) => ({ ...r, payments: book.payments('reminder', r.id, 3) })),
      companies: platform.list().map((c) => ({
        ...pick(c, ['id', 'slug', 'name', 'created_at', 'principal', 'domain', 'address', ...COMPANY_FIELDS]),
        ...platform.stats(c.id),
        payments: book.payments('company', c.id, 6),
      })),
    }),
  );
  router.post('/reminders', (req, res) => res.status(201).json(book.addReminder(req.body)));
  router.put('/reminders/:id', (req, res) => res.json(book.updateReminder(req.params.id, req.body)));
  router.delete('/reminders/:id', (req, res) => res.json(book.removeReminder(req.params.id)));
  router.post('/reminders/:id/paid', (req, res) => res.json(book.payReminder(req.params.id, req.body)));
  router.put('/companies/:id/account', (req, res) => res.json(book.updateCompany(req.params.id, req.body)));
  router.post('/companies/:id/paid', (req, res) => res.json(book.payCompany(req.params.id, req.body)));
  // ¿La dirección de la agencia responde? Se prueba desde el servidor, como entraría un cliente.
  router.post('/companies/:id/check', async (req, res) => {
    const c = platform.list().find((x) => x.id === Number(req.params.id));
    if (!c) fail(404, 'Empresa inexistente');
    if (!c.address) return res.json({ ok: null, reason: 'Sin dirección propia todavía' });
    const started = Date.now();
    try {
      const r = await fetch(`${c.address}/api/health`, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
      res.json({ ok: r.ok, status: r.status, ms: Date.now() - started });
    } catch (err) {
      res.json({ ok: false, reason: err.name === 'TimeoutError' ? 'No contestó en 8 segundos' : 'No se pudo conectar' });
    }
  });
  router.post('/companies', (req, res) => res.status(201).json(platform.create(req.body || {})));
  router.put('/companies/:id/domain', (req, res) => res.json(platform.setDomain(req.params.id, (req.body || {}).domain)));
  return router;
}

/**
 * @param {object} [options]
 * @param {string} [options.uploadsDir] carpeta de fotos y documentos (por defecto, junto a la base de datos).
 * @param {object} [options.platform] registro de empresas (src/platform.js). Sin él, la app atiende una sola empresa
 *   con `db` (así funcionan la demo del navegador y las pruebas).
 */
function createApp(db, options = {}) {
  const uploadsDir =
    options.uploadsDir ||
    process.env.UPLOADS_DIR ||
    path.join(path.dirname(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'rentacar.db')), 'uploads');
  const { platform } = options;
  const app = express();
  app.disable('x-powered-by');
  trustProxy(app);
  app.use(httpsRedirect);
  app.use(securityHeaders);
  // Las importaciones de planillas traen más datos: su cuerpo se lee recién después de verificar la sesión.
  const json = express.json({ limit: '1mb' });
  app.use((req, res, next) => (req.path.startsWith('/api/import/') ? next() : json(req, res, next)));

  // CORS sólo para la API pública (el cotizador puede llamarla desde el navegador).
  app.use('/api/public', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // Huella de las pantallas al arrancar: si cambian en disco (se bajó una versión nueva encima),
  // este proceso quedó viejo y hay que reiniciarlo.
  const uiFile = path.join(__dirname, '..', 'public', 'app.js');
  const uiHash = () => {
    try {
      return require('node:crypto').createHash('sha1').update(require('node:fs').readFileSync(uiFile)).digest('hex');
    } catch {
      return null;
    }
  };
  const bootHash = uiHash();
  app.get('/api/health', (_req, res) => res.json({ ok: true, stale: bootHash !== uiHash() }));

  // Cada pedido va a la API de su empresa.
  const apis = new Map();
  const apiOf = (c) => {
    if (!apis.has(c.id)) apis.set(c.id, companyApi(c.db, { uploadsDir: platform.uploadsDir(c, uploadsDir), company: c, platform }));
    return apis.get(c.id);
  };
  const single = platform ? null : companyApi(db, { uploadsDir });
  const COOKIE_COMPANY = /(?:^|;\s*)rc_session=(\d+)\./;
  const companyFor = (req) => {
    // Entrando por la dirección de una empresa (su subdominio o su dominio propio), todo va a esa empresa:
    // un usuario o una sesión de otra no existen ahí.
    const byHost = platform.byHost(req.hostname);
    if (byHost) return byHost;
    const p = req.path;
    if (p === '/api/auth/login') return platform.byEmail(String((req.body && req.body.email) || '').trim().toLowerCase()) || platform.principal();
    if (p.startsWith('/api/public/v1/')) return platform.byApiKey(req.get('x-api-key')) || platform.principal();
    if (p.startsWith('/api/public/')) {
      // Formulario web y asistente: la empresa va en la dirección (?empresa=...); sin ella, la principal.
      if (!req.query.empresa) return platform.principal();
      return platform.bySlug(req.query.empresa) || fail(404, 'Empresa inexistente');
    }
    // Sesión: la cookie lleva el número de empresa delante del token. Las sesiones anteriores son de la principal.
    const m = String(req.get('cookie') || '').match(COOKIE_COMPANY);
    return (m && platform.get(m[1])) || platform.principal();
  };
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (single) return single(req, res, next);
    let c;
    try {
      c = companyFor(req);
    } catch (e) {
      return next(e);
    }
    apiOf(c)(req, res, next);
  });

  // Librerías para generar el contrato en PDF en el navegador (servidas desde la app: la política de seguridad no admite otros sitios).
  const vendor = {
    'jspdf.umd.min.js': path.join(path.dirname(require.resolve('jspdf')), 'jspdf.umd.min.js'),
    'jspdf.plugin.autotable.min.js': path.join(path.dirname(require.resolve('jspdf-autotable')), 'jspdf.plugin.autotable.min.js'),
  };
  app.get('/vendor/:file', (req, res, next) => (vendor[req.params.file] ? res.sendFile(vendor[req.params.file]) : next()));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use(errorHandler);

  return app;
}

module.exports = { createApp, ensureAdmin };
