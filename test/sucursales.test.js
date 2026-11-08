'use strict';

/* Selector de sucursal: Hoy, el calendario, las reservas y los autos muestran solo la elegida. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { seed, seedChoferes, seedHistory, seedSimulaciones } = require('../src/seed');
const C = require('../src/choferes');
const R = require('../src/reservations');
const { fmtLocal } = require('../src/util');

async function withApp(db, fn) {
  const server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!cookie && res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    await call('POST', '/api/auth/login', { email: 'admin@rentacar.local', password: 'admin123' });
    await call('POST', '/api/auth/password', { current: 'admin123', password: 'Ushuaia2026Segura' });
    await fn((p) => call('GET', p).then((r) => r.data));
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test('con una sucursal elegida, cada pantalla trae solo lo de esa sucursal', async () => {
  const db = openDb(':memory:');
  ensureAdmin(db);
  seed(db);
  assert.equal(seedSimulaciones(db), true);
  seedHistory(db);
  const id = (code) => db.prepare('SELECT id FROM branches WHERE code = ?').get(code).id;
  const [air, center] = [id('USH'), id('CEN')];

  await withApp(db, async (get) => {
    const all = await get('/api/dashboard');
    const atCenter = await get(`/api/dashboard?branch=${center}`);
    const atAir = await get(`/api/dashboard?branch=${air}`);

    const plates = (list) => list.map((r) => r.vehicle_plate);
    assert.ok(plates(all.returns_today).includes('AF654JK') && plates(all.returns_today).includes('AF123BC'));
    assert.deepEqual(plates(atCenter.returns_today), ['AF654JK']);
    assert.deepEqual(plates(atAir.returns_today), ['AF123BC']);
    assert.deepEqual(plates(atCenter.overdue), ['AF456DE']);
    assert.deepEqual(plates(atAir.overdue), []);
    assert.equal(atCenter.fleet.total + atAir.fleet.total, all.fleet.total, 'cada auto cuenta en una sola sucursal');
    assert.deepEqual(atCenter.alerts.documents.map((d) => d.plate), ['AE555VW']);
    assert.deepEqual(atAir.alerts.documents.map((d) => d.plate), ['AG444TU']);
    assert.ok(atCenter.month_revenue < all.month_revenue);

    // Un pedido que sale del aeropuerto y vuelve al centro es de las dos.
    const pending = (d) => plates(d.pending);
    assert.ok(pending(atAir).includes('AG987LM') && pending(atCenter).includes('AG987LM'));

    const res = await get(`/api/reservations?branch=${center}&status=en_curso`);
    assert.deepEqual(res.map((r) => r.vehicle_plate).sort(), ['AF456DE', 'AF654JK']);
    const found = await get(`/api/reservations?branch=${air}&q=Blanco`);
    assert.deepEqual(found, [], 'el filtro también vale junto con la búsqueda');

    const cars = await get(`/api/vehicles?branch=${center}`);
    assert.ok(cars.length > 0 && cars.every((v) => v.branch_id === center));
    assert.deepEqual((await get(`/api/vehicles?branch=${air}&q=AF456DE`)), []);
    assert.deepEqual((await get(`/api/vehicles?branch=${center}&q=AF456DE`)).map((v) => v.plate), ['AF456DE']);

    // Calendario: los autos de la sucursal y el que viene de otra para devolverse acá.
    const from = fmtLocal(new Date()).slice(0, 10);
    const plan = await get(`/api/planning?from=${from}&days=14&branch=${center}`);
    const shown = plan.vehicles.map((v) => v.plate);
    assert.ok(shown.includes('AF456DE'), 'auto de la sucursal');
    assert.ok(shown.includes('AG987LM'), 'auto de otra sucursal que vuelve por esta');
    assert.ok(!shown.includes('AG444TU'), 'auto de otra sucursal sin nada que ver');
    assert.ok(plan.reservations.every((r) => r.pickup_branch_id === center || r.return_branch_id === center || plan.vehicles.some((v) => v.id === r.vehicle_id)));

    // Sin sucursal o con un valor raro, se ve todo como siempre.
    assert.equal((await get('/api/vehicles')).length, all.fleet.total);
    assert.equal((await get('/api/dashboard?branch=1%20OR%201=1')).fleet.total, all.fleet.total);
  });
});

test('demo de autos para trabajo: una segunda base con sus choferes y su deuda aparte', () => {
  const db = openDb(':memory:');
  ensureAdmin(db);
  seedChoferes(db);
  assert.equal(seedSimulaciones(db), true);
  assert.equal(seedSimulaciones(db), false, 'no se carga dos veces');
  const today = fmtLocal(new Date()).slice(0, 10);
  const base = db.prepare("SELECT id FROM branches WHERE code = 'AVE'").get().id;
  const there = C.dashboardChoferes(db, R.getReservation, today, base);
  assert.deepEqual(there.owing.map((o) => o.customer_name), ['Nicolás Vega']);
  assert.deepEqual(there.license_expired, []);
  const every = C.dashboardChoferes(db, R.getReservation, today);
  assert.ok(every.owing.some((o) => o.customer_name === 'Ramiro Díaz') && every.owing.some((o) => o.customer_name === 'Nicolás Vega'));
});
