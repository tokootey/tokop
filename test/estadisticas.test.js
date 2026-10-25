'use strict';

/* Estadísticas (qué autos y categorías se piden, seguros, daños) y seguros que carga cada agencia. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { seed } = require('../src/seed');

let server;
let base;
let cookie;
let db;

async function call(method, url, body, c = cookie) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: c },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function login(email, password) {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return res.headers.get('set-cookie').split(';')[0];
}

test.before(async () => {
  db = openDb(':memory:');
  ensureAdmin(db);
  seed(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = await login('admin@rentacar.local', 'admin123');
  assert.equal((await call('POST', '/api/auth/password', { current: 'admin123', password: 'Estadistica2026x' })).status, 200);
});

test.after(() => server.close());

const extra = (code) => db.prepare('SELECT * FROM extras WHERE code = ?').get(code);

test('seguros: la agencia los carga con precio y franquicia; se elige uno solo por reserva', async () => {
  const created = await call('POST', '/api/extras', { code: 'ORO', name: 'Seguro Oro', price: 9000, charge_type: 'dia', kind: 'seguro', deductible: 150000 });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.deepEqual([created.data.kind, created.data.deductible], ['seguro', 150000]);

  const cat = db.prepare("SELECT id FROM categories WHERE code = 'B'").get().id;
  const q = await call('POST', '/api/quote', { category_id: cat, pickup_at: '2027-05-10T10:00', return_at: '2027-05-12T10:00', extras: [{ extra_id: created.data.id }] });
  const line = q.data.extras.find((x) => x.name === 'Seguro Oro');
  assert.deepEqual([line.amount, line.kind, line.deductible], [18000, 'seguro', 150000]);

  const two = await call('POST', '/api/quote', { category_id: cat, pickup_at: '2027-05-10T10:00', return_at: '2027-05-12T10:00', extras: [{ extra_id: created.data.id }, { extra_id: extra('FULL').id }] });
  assert.equal(two.status, 400);
  assert.match(two.data.error, /un solo seguro/);
});

test('estadísticas: demanda por categoría y por auto, seguros y daños; solo administradores', async () => {
  // Una reserva con seguro total que vuelve con daños.
  const cust = await call('POST', '/api/customers', { full_name: 'Cliente Stats', license_number: 'L9', license_expiry: '2035-01-01' });
  const cat = db.prepare("SELECT id FROM categories WHERE code = 'C'").get().id;
  const t = new Date();
  const d = (n) => new Date(t.getFullYear(), t.getMonth(), t.getDate() + n, 10).toISOString().slice(0, 16);
  const r = await call('POST', '/api/reservations', {
    customer_id: cust.data.id, category_id: cat, pickup_branch_id: 1, return_branch_id: 1,
    pickup_at: d(-3), return_at: d(-1), status: 'confirmada', allow_overbooking: true, extras: [{ extra_id: extra('FULL').id }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const v = (await call('GET', `/api/reservations/${r.data.id}/available-vehicles`)).data[0];
  assert.equal((await call('POST', `/api/reservations/${r.data.id}/checkout`, { vehicle_id: v.id, out_km: v.km, out_fuel: 8, out_at: d(-3) })).status, 200);
  assert.equal((await call('POST', `/api/reservations/${r.data.id}/checkin`, { in_km: v.km + 100, in_fuel: 8, in_at: d(-1), damage_charge: 50000 })).status, 200);

  const s = await call('GET', '/api/stats');
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.ok(s.data.totals.requested >= 5);
  assert.ok(s.data.totals.revenue > 0);
  const c = s.data.categories.find((x) => x.code === 'C');
  assert.ok(c.requested >= 2 && c.fleet === 2 && c.occupancy >= 0);
  assert.ok(s.data.vehicles.some((x) => x.id === v.id && x.rentals >= 1));
  assert.ok(s.data.insurance.some((x) => x.name.startsWith('Cobertura total') && x.times >= 1));
  assert.ok(s.data.totals.with_insurance >= 1);
  const dmg = s.data.damages.find((x) => x.code === r.data.code);
  assert.equal(dmg && dmg.amount, 50000);
  assert.ok(s.data.shop.length >= 1, 'el service de ejemplo cuenta en el taller');

  // Un período sin nada.
  const empty = (await call('GET', '/api/stats?from=2001-01-01&to=2001-01-31')).data;
  assert.deepEqual([empty.totals.requested, empty.totals.revenue, empty.damages.length], [0, 0, 0]);

  // Un operador no ve los ingresos.
  assert.equal((await call('POST', '/api/users', { name: 'Mostrador', email: 'mostrador@stats.test', password: 'Inicial2026Clave', role: 'operador' })).status, 201);
  let op = await login('mostrador@stats.test', 'Inicial2026Clave');
  await call('POST', '/api/auth/password', { current: 'Inicial2026Clave', password: 'Atencion2026Clave' }, op);
  op = await login('mostrador@stats.test', 'Atencion2026Clave');
  assert.equal((await call('GET', '/api/stats', undefined, op)).status, 403);
});
