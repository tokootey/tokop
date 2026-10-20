'use strict';

/*
 * Varias empresas en una instalación: cada agencia ve y toca sólo sus datos.
 * Se arma una instalación "vieja" (una sola base, con datos), se le agrega el registro de empresas
 * y se da de alta una segunda empresa desde la API, como lo haría el administrador.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, getSetting } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { openPlatform } = require('../src/platform');
const { seed } = require('../src/seed');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-multi-'));
const dbFile = path.join(dir, 'rentacar.db');
let server;
let base;
let platform;
const A = { email: 'admin@rentacar.local', password: 'Ushuaia2026Segura' };
const B = { email: 'duenio@patagonia.test', password: 'Patagonia2026Segura' };

async function call(cookie, method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  const res = await call(null, 'POST', '/api/auth/login', { email, password });
  return { ...res, cookie: res.status === 200 ? res.headers.get('set-cookie').split(';')[0] : null };
}

/** Entra con la contraseña inicial y la cambia, como en el primer ingreso. */
async function firstLogin(email, initial, password) {
  const l = await login(email, initial);
  assert.equal(l.status, 200, JSON.stringify(l.data));
  assert.equal((await call(l.cookie, 'POST', '/api/auth/password', { current: initial, password })).status, 200);
  return l.cookie;
}

let cookieA;
let cookieB;
let companyB;

test.before(async () => {
  // Instalación anterior: una sola base con datos de ejemplo y su administrador.
  const old = openDb(dbFile);
  ensureAdmin(old);
  seed(old);
  old.close();

  const db = openDb(dbFile);
  platform = openPlatform(db, dbFile);
  server = createApp(db, { platform, uploadsDir: path.join(dir, 'uploads') }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookieA = await firstLogin(A.email, 'admin123', A.password);
});

test.after(() => {
  server.close();
  platform.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('la instalación anterior sigue igual: sus datos pasan a la empresa principal', async () => {
  assert.deepEqual(
    platform.list().map((c) => [c.id, c.slug, c.principal]),
    [[1, 'principal', true]],
  );
  const me = await call(cookieA, 'GET', '/api/auth/me');
  assert.equal(me.data.company.slug, 'principal');
  assert.equal(me.data.platform_admin, true);
  assert.ok((await call(cookieA, 'GET', '/api/reservations')).data.length > 0);
  assert.ok((await call(cookieA, 'GET', '/api/vehicles')).data.length > 0);
  // Una sesión de antes (cookie sin número de empresa) sigue entrando a la principal.
  const legacy = cookieA.replace(/^rc_session=\d+\./, 'rc_session=');
  assert.equal((await call(legacy, 'GET', '/api/auth/me')).data.email, A.email);
});

test('alta de empresa: sólo el administrador de la principal; nace vacía y con su país', async () => {
  const created = await call(cookieA, 'POST', '/api/platform/companies', { name: 'Patagonia Autos', country: 'CL', admin_name: 'Dueña', admin_email: B.email });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  companyB = created.data.company;
  assert.equal(companyB.slug, 'patagonia-autos');
  assert.equal(created.data.admin.email, B.email);
  cookieB = await firstLogin(B.email, created.data.admin.password, B.password);

  const me = await call(cookieB, 'GET', '/api/auth/me');
  assert.equal(me.data.company.slug, 'patagonia-autos');
  assert.equal(me.data.platform_admin, false);
  const settings = (await call(cookieB, 'GET', '/api/settings')).data;
  assert.equal(settings.company_name, 'Patagonia Autos');
  assert.equal(settings.currency, 'CLP');
  assert.equal(settings.tax_id_label, 'RUT');
  // La principal no cambió de país.
  assert.equal((await call(cookieA, 'GET', '/api/settings')).data.currency, 'ARS');

  for (const p of ['/api/reservations', '/api/vehicles', '/api/customers', '/api/categories', '/api/branches']) {
    assert.deepEqual((await call(cookieB, 'GET', p)).data, [], p);
  }
  // Una empresa que no es la principal no da de alta otras.
  assert.equal((await call(cookieB, 'POST', '/api/platform/companies', { name: 'Otra', admin_email: 'x@otra.test' })).status, 403);
  assert.equal((await call(cookieB, 'GET', '/api/platform/companies')).status, 403);
  // Un operador de la principal tampoco.
  assert.equal((await call(cookieA, 'POST', '/api/users', { name: 'Op', email: 'op@rentacar.local', password: 'Operador2026x', role: 'operador' })).status, 201);
  const op = await firstLogin('op@rentacar.local', 'Operador2026x', 'Operador2026y');
  assert.equal((await call(op, 'GET', '/api/platform/companies')).status, 403);
});

test('aislamiento: lo que carga una empresa no lo ve ni lo toca la otra', async () => {
  const branch = await call(cookieB, 'POST', '/api/branches', { code: 'SCL', name: 'Aeropuerto Santiago' });
  const cat = await call(cookieB, 'POST', '/api/categories', { code: 'A', name: 'Económico', daily_rate: 30000 });
  assert.equal(branch.status, 201);
  assert.equal(cat.status, 201);
  // La patente y el código ya existen en la principal: cada empresa tiene los suyos.
  const plateA = (await call(cookieA, 'GET', '/api/vehicles')).data[0].plate;
  const veh = await call(cookieB, 'POST', '/api/vehicles', { plate: plateA, category_id: cat.data.id, branch_id: branch.data.id, status: 'disponible' });
  assert.equal(veh.status, 201, JSON.stringify(veh.data));
  const cust = await call(cookieB, 'POST', '/api/customers', { full_name: 'Cliente Secreto de B', doc_number: '99888777' });
  const res = await call(cookieB, 'POST', '/api/reservations', {
    customer_id: cust.data.id,
    category_id: cat.data.id,
    pickup_branch_id: branch.data.id,
    return_branch_id: branch.data.id,
    pickup_at: '2027-02-01T10:00',
    return_at: '2027-02-04T10:00',
    status: 'confirmada',
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));

  // A no encuentra nada de B, ni buscando.
  const custA = (await call(cookieA, 'GET', '/api/customers?q=Secreto')).data;
  assert.deepEqual(custA, []);
  const resA = (await call(cookieA, 'GET', '/api/reservations?q=Secreto')).data;
  assert.deepEqual(resA, []);
  // Los números de registro se repiten entre empresas, pero cada una abre los suyos.
  const sameId = await call(cookieA, 'GET', `/api/reservations/${res.data.id}`);
  assert.notEqual(sameId.data.customer_name, 'Cliente Secreto de B');

  // Lo que modifica A no llega a B.
  const before = (await call(cookieB, 'GET', `/api/customers/${cust.data.id}`)).data;
  await call(cookieA, 'PUT', `/api/customers/${cust.data.id}`, { full_name: 'Pisado por A' });
  assert.equal((await call(cookieB, 'GET', `/api/customers/${cust.data.id}`)).data.full_name, before.full_name);

  // B no ve los clientes, autos ni usuarios de A.
  assert.equal((await call(cookieB, 'GET', '/api/customers')).data.length, 1);
  assert.equal((await call(cookieB, 'GET', '/api/vehicles')).data.length, 1);
  assert.deepEqual(
    (await call(cookieB, 'GET', '/api/users')).data.map((u) => u.email),
    [B.email],
  );
  // Tampoco su registro de actividad.
  const audit = (await call(cookieB, 'GET', '/api/audit')).data;
  assert.ok(audit.every((a) => !a.email || a.email === B.email), JSON.stringify(audit.map((a) => a.email)));
});

test('la cookie no se puede apuntar a otra empresa', async () => {
  // Cambiar el número de empresa delante del token no sirve: ese token no existe en la otra base.
  const forged = cookieB.replace(/^rc_session=\d+\./, 'rc_session=1.');
  assert.equal((await call(forged, 'GET', '/api/reservations')).status, 401);
  const forgedA = cookieA.replace(/^rc_session=\d+\./, `rc_session=${companyB.id}.`);
  assert.equal((await call(forgedA, 'GET', '/api/reservations')).status, 401);
});

test('emails únicos: un usuario no puede existir en dos empresas', async () => {
  const dup = await call(cookieB, 'POST', '/api/users', { name: 'Copia', email: A.email.toUpperCase(), password: 'Copiado2026x', role: 'admin' });
  assert.equal(dup.status, 409);
  const dup2 = await call(cookieA, 'POST', '/api/platform/companies', { name: 'Tercera', admin_email: B.email });
  assert.equal(dup2.status, 409);
});

test('API del cotizador y formulario web: cada empresa recibe lo suyo', async () => {
  const dbB = platform.get(companyB.id).db;
  const keyA = getSetting(platform.principal().db, 'api_key');
  const keyB = getSetting(dbB, 'api_key');
  assert.notEqual(keyA, keyB);
  const catA = await call(null, 'GET', '/api/public/v1/catalog', undefined, { 'X-API-Key': keyA });
  const catB = await call(null, 'GET', '/api/public/v1/catalog', undefined, { 'X-API-Key': keyB });
  assert.equal(catB.status, 200);
  assert.deepEqual(
    catB.data.categories.map((c) => c.name),
    ['Económico'],
  );
  assert.ok(catA.data.categories.length > 1);
  assert.equal((await call(null, 'GET', '/api/public/v1/catalog', undefined, { 'X-API-Key': 'rk_inventada' })).status, 401);

  // Formulario web: la empresa va en la dirección; el de una empresa nueva arranca apagado.
  const form = (q) =>
    fetch(`${base}/api/public/webform${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ nombre: 'Web', email: 'w@x.test', vehiculo: 'A', fecha_retiro: '2027-03-01', fecha_devolucion: '2027-03-03' }),
    });
  assert.equal((await form(`?empresa=${companyB.slug}`)).status, 403);
  assert.equal((await form('?empresa=no-existe')).status, 404);
  // Asistente: cada empresa lo prende por su cuenta y muestra su propio nombre.
  assert.equal((await call(null, 'GET', `/api/public/chat/config?empresa=${companyB.slug}`)).status, 403);
  assert.equal((await call(cookieB, 'PUT', '/api/settings', { chat_enabled: '1' })).status, 200);
  const chat = await call(null, 'GET', `/api/public/chat/config?empresa=${companyB.slug}`);
  assert.equal(chat.data.company, 'Patagonia Autos');
  assert.notEqual((await call(null, 'GET', '/api/public/chat/config')).data.company, 'Patagonia Autos');
});

test('cada empresa guarda su base en su propio archivo, y el registro sobrevive a un reinicio', () => {
  assert.ok(fs.existsSync(path.join(dir, 'empresas.db')));
  assert.ok(fs.existsSync(path.join(dir, 'empresas', `${companyB.slug}.db`)));
  const again = openPlatform(openDb(dbFile), dbFile);
  assert.deepEqual(
    again.list().map((c) => c.slug),
    ['principal', companyB.slug],
  );
  assert.equal(again.byEmail(B.email).id, companyB.id);
  again.close();
});
