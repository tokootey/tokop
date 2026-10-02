'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { openDb, getSetting } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { seed } = require('../src/seed');
const { passwordProblem } = require('../src/auth');

let db;
let server;
let base;
let admin; // cookie del administrador
let uploadsDir;
const ADMIN_PW = 'Ushuaia2026Segura';

async function req(method, p, { body, cookie, headers = {}, raw } = {}) {
  const res = await fetch(base + p, {
    method,
    redirect: 'manual',
    headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

async function login(email, password) {
  const r = await req('POST', '/api/auth/login', { body: { email, password } });
  return { ...r, cookie: r.status === 200 ? r.headers.get('set-cookie').split(';')[0] : null, setCookie: r.headers.get('set-cookie') };
}

/** Crea un usuario, inicia sesión y hace el cambio de contraseña obligatorio. */
async function userSession(email, role = 'operador') {
  const r = await req('POST', '/api/users', { cookie: admin, body: { name: email, email, password: 'Inicial2026x', role } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const l = await login(email, 'Inicial2026x');
  assert.equal((await req('POST', '/api/auth/password', { cookie: l.cookie, body: { current: 'Inicial2026x', password: 'Propia2026xyz' } })).status, 200);
  return l.cookie;
}

test.before(async () => {
  db = openDb(':memory:');
  ensureAdmin(db);
  seed(db);
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seg-'));
  server = createApp(db, { uploadsDir }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const l = await login('admin@rentacar.local', 'admin123');
  admin = l.cookie;
  assert.equal((await req('POST', '/api/auth/password', { cookie: admin, body: { current: 'admin123', password: ADMIN_PW } })).status, 200);
});

test.after(() => {
  server.close();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

test('encabezados de seguridad en las pantallas y en la API', async () => {
  const page = await req('GET', '/');
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-powered-by'), null);
  const api = await req('GET', '/api/reservations', { cookie: admin });
  assert.equal(api.headers.get('cache-control'), 'no-store');
});

test('la sesión es una cookie HttpOnly y SameSite=Strict; el token no queda en la base ni en la respuesta', async () => {
  const l = await login('admin@rentacar.local', ADMIN_PW);
  assert.equal(l.status, 200);
  assert.match(l.setCookie, /HttpOnly/i);
  assert.match(l.setCookie, /SameSite=Strict/i);
  assert.match(l.setCookie, /Path=\//);
  assert.equal(l.data.token, undefined);
  const value = l.cookie.split('=')[1];
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token = ?').get(value).n, 0, 'el token se guarda hasheado');
  // Sin cookie no hay acceso, y el viejo encabezado Bearer ya no sirve.
  assert.equal((await req('GET', '/api/customers')).status, 401);
  assert.equal((await req('GET', '/api/customers', { headers: { Authorization: `Bearer ${value}` } })).status, 401);
  // Salir invalida la sesión.
  assert.equal((await req('POST', '/api/auth/logout', { cookie: l.cookie })).status, 200);
  assert.equal((await req('GET', '/api/customers', { cookie: l.cookie })).status, 401);
});

test('bloqueo tras 5 intentos fallidos, aunque después se use la contraseña correcta', async () => {
  await userSession('bloqueo@x.com');
  for (let i = 0; i < 5; i++) assert.equal((await login('bloqueo@x.com', 'mal' + i)).status, 401);
  const blocked = await login('bloqueo@x.com', 'Propia2026xyz');
  assert.equal(blocked.status, 429);
  const actions = db.prepare("SELECT action FROM audit_log WHERE email = 'bloqueo@x.com'").all().map((a) => a.action);
  assert.ok(actions.includes('login_fallido'));
  assert.ok(actions.includes('login_bloqueado'));
});

test('contraseñas débiles rechazadas', async () => {
  assert.ok(passwordProblem('corta1'));
  assert.ok(passwordProblem('soloLetrasLargas'));
  assert.ok(passwordProblem('admin12345'));
  assert.ok(passwordProblem('juanperez2026', 'juanperez@x.com'));
  assert.equal(passwordProblem('Glaciar-Martial-77'), null);
  const r = await req('POST', '/api/users', { cookie: admin, body: { name: 'X', email: 'debil@x.com', password: '12345678', role: 'operador' } });
  assert.equal(r.status, 400);
});

test('usuario nuevo: no puede usar la app hasta cambiar la contraseña', async () => {
  await req('POST', '/api/users', { cookie: admin, body: { name: 'Nuevo', email: 'nuevo@x.com', password: 'Inicial2026x', role: 'operador' } });
  const l = await login('nuevo@x.com', 'Inicial2026x');
  assert.equal(l.data.must_change_password, true);
  const blocked = await req('GET', '/api/reservations', { cookie: l.cookie });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.details.code, 'password_change_required');
  assert.equal((await req('POST', '/api/auth/password', { cookie: l.cookie, body: { current: 'mala', password: 'Propia2026xyz' } })).status, 400);
  assert.equal((await req('POST', '/api/auth/password', { cookie: l.cookie, body: { current: 'Inicial2026x', password: 'Inicial2026x' } })).status, 400);
  assert.equal((await req('POST', '/api/auth/password', { cookie: l.cookie, body: { current: 'Inicial2026x', password: 'Propia2026xyz' } })).status, 200);
  assert.equal((await req('GET', '/api/reservations', { cookie: l.cookie })).status, 200);
});

test('desactivar a un usuario cierra sus sesiones', async () => {
  const cookie = await userSession('baja@x.com');
  const u = db.prepare("SELECT id FROM users WHERE email = 'baja@x.com'").get();
  assert.equal((await req('PUT', `/api/users/${u.id}`, { cookie: admin, body: { active: 0 } })).status, 200);
  assert.equal((await req('GET', '/api/customers', { cookie })).status, 401);
});

test('protección CSRF: se rechazan pedidos que modifican datos desde otro sitio', async () => {
  const evil = await req('POST', '/api/customers', { cookie: admin, headers: { Origin: 'https://sitio-malicioso.com' }, body: { full_name: 'X' } });
  assert.equal(evil.status, 403);
  const cross = await req('POST', '/api/customers', { cookie: admin, headers: { 'Sec-Fetch-Site': 'cross-site' }, body: { full_name: 'X' } });
  assert.equal(cross.status, 403);
  const ok = await req('POST', '/api/customers', { cookie: admin, headers: { Origin: base }, body: { full_name: 'Propio' } });
  assert.equal(ok.status, 201);
  // Leer sigue funcionando (no modifica nada).
  assert.equal((await req('GET', '/api/customers', { cookie: admin, headers: { Origin: 'https://otro.com' } })).status, 200);
});

test('permisos: un operador no borra clientes ni ve el registro de actividad; el administrador anonimiza', async () => {
  const op = await userSession('mostrador@x.com');
  const c = (await req('POST', '/api/customers', { cookie: op, body: { full_name: 'Ana Privada', doc_number: '40111222', email: 'ana@x.com', phone: '123', license_number: 'L1' } })).data;
  assert.equal((await req('DELETE', `/api/customers/${c.id}`, { cookie: op })).status, 403);
  assert.equal((await req('POST', `/api/customers/${c.id}/anonymize`, { cookie: op })).status, 403);
  assert.equal((await req('GET', '/api/audit', { cookie: op })).status, 403);

  // Una solicitud del sitio web con sus datos queda en la bandeja; al anonimizar también se borra.
  const r = (
    await req('POST', '/api/reservations', { cookie: op, body: { customer_id: c.id, category_id: 1, pickup_at: '2027-09-01T10:00', return_at: '2027-09-03T10:00', notes: 'DNI 40111222' } })
  ).data;
  db.prepare("INSERT INTO quote_inbox (external_id, payload, status, reservation_id) VALUES ('x', ?, 'procesada', ?)").run(JSON.stringify({ nombre: 'Ana Privada' }), r.id);

  const anon = await req('POST', `/api/customers/${c.id}/anonymize`, { cookie: admin });
  assert.equal(anon.status, 200);
  assert.equal(anon.data.full_name, `Cliente anonimizado #${c.id}`);
  for (const f of ['doc_number', 'email', 'phone', 'license_number']) assert.equal(anon.data[f], null);
  assert.equal(db.prepare('SELECT notes FROM reservations WHERE id = ?').get(r.id).notes, null);
  assert.equal(db.prepare('SELECT payload FROM quote_inbox WHERE reservation_id = ?').get(r.id).payload, '{}');
  assert.equal(db.prepare('SELECT total FROM reservations WHERE id = ?').get(r.id).total > 0, true, 'los importes se conservan');
  const log = (await req('GET', '/api/audit', { cookie: admin })).data;
  assert.ok(log.some((a) => a.action === 'cliente_anonimizado'));
});

test('fotos: se verifica el contenido real y se sirven aisladas', async () => {
  const fake = await req('POST', '/api/reservations/1/files?stage=entrega', { cookie: admin, headers: { 'Content-Type': 'image/png' }, raw: Buffer.from('<script>alert(1)</script>') });
  assert.equal(fake.status, 415);
  const html = await req('POST', '/api/reservations/1/files', { cookie: admin, headers: { 'Content-Type': 'text/html' }, raw: Buffer.from('<h1>x</h1>') });
  assert.equal(html.status, 415);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  const up = await req('POST', '/api/reservations/1/files?stage=entrega&name=../../etc/passwd', { cookie: admin, headers: { 'Content-Type': 'image/jpeg' }, raw: jpeg });
  assert.equal(up.status, 201);
  assert.ok(!up.data.name.includes('/'), 'el nombre no puede tener rutas');
  const got = await req('GET', `/api/files/${up.data.id}`, { cookie: admin });
  assert.match(got.headers.get('content-security-policy'), /sandbox/);
  assert.equal(got.headers.get('cache-control'), 'private, no-store');
  assert.equal((await req('GET', `/api/files/${up.data.id}`)).status, 401);
});

test('API del cotizador: la clave sólo se acepta en el encabezado', async () => {
  const key = getSetting(db, 'api_key');
  assert.equal((await req('GET', `/api/public/v1/catalog?api_key=${key}`)).status, 401);
  assert.equal((await req('GET', '/api/public/v1/catalog', { headers: { 'X-API-Key': key } })).status, 200);
  assert.equal((await req('GET', '/api/public/v1/catalog', { headers: { 'X-API-Key': key.slice(0, -1) + 'x' } })).status, 401);
});

test('formulario web: exige venir del sitio autorizado y recorta campos enormes', async () => {
  const form = (extra = {}) =>
    new URLSearchParams({
      nombre: 'Prueba Larga',
      email: 'larga@example.com',
      vehiculo: 'SUV',
      fecha_retiro: '10/11/2027',
      fecha_devolucion: '12/11/2027',
      comentarios: 'x'.repeat(5000),
      ...extra,
    });
  const h = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'X-Requested-With': 'fetch' };
  assert.equal((await req('POST', '/api/public/webform', { headers: h, raw: form().toString() })).status, 403, 'sin Origin');
  assert.equal((await req('POST', '/api/public/webform', { headers: { ...h, Origin: 'https://otro.com' }, raw: form().toString() })).status, 403);
  const ok = await req('POST', '/api/public/webform', { headers: { ...h, Origin: 'https://www.discoverushuaia.com.ar' }, raw: form().toString() });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const stored = JSON.parse(db.prepare('SELECT payload FROM quote_inbox ORDER BY id DESC LIMIT 1').get().payload);
  assert.equal(stored.comentarios.length, 1000);
  // Un error interno no se le muestra al público.
  const bad = await req('POST', '/api/public/webform', { headers: { ...h, Origin: 'https://www.discoverushuaia.com.ar' }, raw: form({ vehiculo: 'Nave espacial' }).toString() });
  assert.equal(bad.status, 202);
  assert.equal(bad.data.message, undefined);
});

test('detrás de un proxy: redirige a https, activa HSTS y marca la cookie como Secure', async () => {
  process.env.TRUST_PROXY = '1';
  const s2 = createApp(db, { uploadsDir }).listen(0);
  await new Promise((r) => s2.once('listening', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  try {
    const http = await fetch(`${b2}/`, { redirect: 'manual', headers: { 'X-Forwarded-Proto': 'http' } });
    assert.equal(http.status, 301);
    assert.match(http.headers.get('location'), /^https:\/\//);
    const https = await fetch(`${b2}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ email: 'admin@rentacar.local', password: ADMIN_PW }),
    });
    assert.equal(https.status, 200);
    assert.match(https.headers.get('set-cookie'), /Secure/);
    assert.match(https.headers.get('strict-transport-security'), /max-age=31536000/);
  } finally {
    delete process.env.TRUST_PROXY;
    s2.close();
  }
});

test('instalación anterior con la contraseña de fábrica: obliga a cambiarla al reiniciar', () => {
  const { hashPassword } = require('../src/auth');
  db.prepare("INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES ('Viejo', 'viejo@x.com', ?, 'admin', 0)").run(hashPassword('admin123'));
  ensureAdmin(db);
  assert.equal(db.prepare("SELECT must_change_password AS m FROM users WHERE email = 'viejo@x.com'").get().m, 1);
});
