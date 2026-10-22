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

/** Pedido entrando por otra dirección (fetch no deja cambiar el encabezado Host). */
function viaHost(host, method, url, body, cookie) {
  const http = require('node:http');
  const data = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${url}`,
      { method, headers: { Host: host, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, data: json, cookie: (res.headers['set-cookie'] || [''])[0].split(';')[0] });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('cada empresa entra por su subdominio o por su dominio propio', async () => {
  process.env.FLOTY_DOMAIN = 'floty.test';
  try {
    const sub = `${companyB.slug}.floty.test`;
    // El subdominio alcanza para saber la empresa: el asistente no necesita ?empresa=.
    assert.equal((await viaHost(sub, 'GET', '/api/public/chat/config')).data.company, 'Patagonia Autos');
    assert.notEqual((await viaHost('floty.test', 'GET', '/api/public/chat/config')).data.company, 'Patagonia Autos');

    // En la dirección de una empresa sólo entran sus usuarios, y una sesión de otra empresa no sirve ahí.
    const loginB = await viaHost(sub, 'POST', '/api/auth/login', B);
    assert.equal(loginB.status, 200);
    assert.equal((await viaHost(sub, 'GET', '/api/auth/me', undefined, loginB.cookie)).data.company.slug, companyB.slug);
    assert.equal((await viaHost(sub, 'POST', '/api/auth/login', A)).status, 401);
    assert.equal((await viaHost(sub, 'GET', '/api/auth/me', undefined, cookieA)).status, 401);

    // La pantalla Empresas muestra la dirección de cada una.
    const list = (await call(cookieA, 'GET', '/api/platform/companies')).data;
    assert.equal(list.find((c) => c.slug === companyB.slug).address, `https://${sub}`);

    // El dueño de Floty entra por app.<dominio> (el dominio a secas es la página web): ahí va a la principal.
    assert.equal(list.find((c) => c.principal).address, 'https://app.floty.test');
    assert.equal(platform.byHost('app.floty.test'), null);
    const loginApp = await viaHost('app.floty.test', 'POST', '/api/auth/login', A);
    assert.equal(loginApp.status, 200);
    assert.equal((await viaHost('app.floty.test', 'GET', '/api/auth/me', undefined, loginApp.cookie)).data.company.principal, true);
    // Una agencia que se llame "App" o "www" no puede quedarse con esas direcciones.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-reservados-'));
    const other = openPlatform(openDb(path.join(tmp, 'rentacar.db')), path.join(tmp, 'rentacar.db'));
    assert.equal(other.create({ name: 'App', country: 'AR', admin_email: 'duenio@app-agencia.test' }).company.slug, 'app-2');
    assert.equal(other.create({ name: 'WWW', country: 'AR', admin_email: 'duenio@www-agencia.test' }).company.slug, 'www-2');
    other.close();
    fs.rmSync(tmp, { recursive: true, force: true });

    // Dominio propio: se valida, no puede repetirse ni ser de Floty, y después también lleva a la empresa.
    const put = (domain, cookie = cookieA) => call(cookie, 'PUT', `/api/platform/companies/${companyB.id}/domain`, { domain });
    assert.equal((await put('no es un dominio')).status, 400);
    assert.equal((await put('otra.floty.test')).status, 400);
    assert.equal((await put('reservas.patagonia.test', cookieB)).status, 403);
    const ok = await put('Reservas.Patagonia.test');
    assert.equal(ok.status, 200);
    assert.equal(ok.data.address, 'https://reservas.patagonia.test');
    assert.equal((await viaHost('reservas.patagonia.test', 'GET', '/api/public/chat/config')).data.company, 'Patagonia Autos');
    assert.equal(platform.byHost('reservas.patagonia.test:443').id, companyB.id);
    assert.equal((await put('')).data.domain, null);
    assert.equal(platform.byHost('reservas.patagonia.test'), null);
  } finally {
    delete process.env.FLOTY_DOMAIN;
  }
  // Sin FLOTY_DOMAIN no hay subdominios: todo sigue como antes.
  assert.equal(platform.byHost(`${companyB.slug}.floty.test`), null);
});

test('Panel de Floty: con FLOTY_OWNERS sólo el dueño maneja empresas y dominios', async () => {
  // Otro administrador de la empresa principal (por ejemplo, alguien del mostrador con permisos de admin).
  const other = { email: 'encargado@rentacar.local', password: 'Mostrador2026Clave' };
  assert.equal((await call(cookieA, 'POST', '/api/users', { name: 'Encargado', email: other.email, password: 'Inicial2026Clave', role: 'admin' })).status, 201);
  const cookieOther = await firstLogin(other.email, 'Inicial2026Clave', other.password);
  process.env.FLOTY_OWNERS = ` ${A.email.toUpperCase()} , dueno@floty.test`;
  try {
    assert.equal((await call(cookieA, 'GET', '/api/auth/me')).data.platform_admin, true);
    assert.equal((await call(cookieA, 'GET', '/api/platform/companies')).status, 200);
    for (const cookie of [cookieOther, cookieB]) {
      assert.equal((await call(cookie, 'GET', '/api/auth/me')).data.platform_admin, false);
      assert.equal((await call(cookie, 'GET', '/api/platform/companies')).status, 403);
      assert.equal((await call(cookie, 'PUT', `/api/platform/companies/${companyB.id}/domain`, { domain: 'robado.test' })).status, 403);
      assert.equal((await call(cookie, 'POST', '/api/platform/companies', { name: 'Trucha', country: 'AR', admin_name: 'X', admin_email: 'x@trucha.test' })).status, 403);
    }
  } finally {
    delete process.env.FLOTY_OWNERS;
  }
  // Sin la variable, como antes: cualquier administrador de la principal (nunca los de una agencia).
  assert.equal((await call(cookieOther, 'GET', '/api/platform/companies')).status, 200);
  assert.equal((await call(cookieB, 'GET', '/api/platform/companies')).status, 403);
});

test('Panel de Floty administrativo: uso de cada agencia, prueba de su dirección y modo dueño', async () => {
  // Sin FLOTY_OWNERS no hay modo dueño: una instalación de una sola agencia sigue viendo su rent a car.
  assert.equal((await call(cookieA, 'GET', '/api/auth/me')).data.owner_mode, false);
  process.env.FLOTY_OWNERS = A.email;
  process.env.FLOTY_DOMAIN = 'floty.invalid'; // .invalid nunca existe: la prueba de la dirección tiene que fallar
  try {
    assert.equal((await call(cookieA, 'GET', '/api/auth/me')).data.owner_mode, true);
    assert.equal((await call(cookieB, 'GET', '/api/auth/me')).data.owner_mode, false);

    const ov = await call(cookieA, 'GET', '/api/platform/overview');
    assert.equal(ov.status, 200);
    assert.equal(typeof ov.data.backups.enabled, 'boolean');
    const b = ov.data.companies.find((c) => c.id === companyB.id);
    assert.equal(b.admin_email, B.email);
    assert.equal(b.address, `https://${companyB.slug}.floty.invalid`);
    assert.ok(b.last_login, 'ya entró al cambiar la contraseña');
    assert.ok(b.vehicles >= 1 && b.reservations_30d >= 0);

    const check = await call(cookieA, 'POST', `/api/platform/companies/${companyB.id}/check`);
    assert.equal(check.status, 200);
    assert.equal(check.data.ok, false);
    assert.ok(check.data.reason);

    for (const url of ['/api/platform/overview', `/api/platform/companies/${companyB.id}/check`]) {
      assert.equal((await call(cookieB, url.endsWith('check') ? 'POST' : 'GET', url)).status, 403);
    }
  } finally {
    delete process.env.FLOTY_OWNERS;
    delete process.env.FLOTY_DOMAIN;
  }
  // Sin dominio de Floty la agencia no tiene dirección para probar.
  assert.equal((await call(cookieA, 'POST', `/api/platform/companies/${companyB.id}/check`)).data.ok, null);
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
