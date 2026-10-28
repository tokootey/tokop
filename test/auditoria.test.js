'use strict';

/* Arreglos de la auditoría de experiencia de uso: taller, reservas por delante, WhatsApp y datos para confirmar. */
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

test.before(async () => {
  db = openDb(':memory:');
  ensureAdmin(db);
  seed(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@rentacar.local', password: 'admin123' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('POST', '/api/auth/password', { current: 'admin123', password: 'Auditoria2026x' })).status, 200);
});

test.after(() => server.close());

const freeCar = (code) => db.prepare("SELECT v.* FROM vehicles v JOIN categories c ON c.id = v.category_id WHERE c.code = ? AND v.status = 'disponible' ORDER BY v.id").all(code);

test('H-015: mandar al taller sin costo se guarda (el costo es opcional)', async () => {
  const v = freeCar('A')[0];
  const r = await call('POST', '/api/maintenance', { vehicle_id: v.id, kind: 'service', start_date: '2027-01-10', km: null, cost: null, status: 'abierto' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.cost, 0);
  assert.equal(db.prepare('SELECT status FROM vehicles WHERE id = ?').get(v.id).status, 'mantenimiento');
  // La lista de autos dice qué se le hace y desde cuándo.
  const listed = (await call('GET', '/api/vehicles')).data.find((x) => x.id === v.id);
  assert.deepEqual([listed.shop_kind, listed.shop_since], ['service', '2027-01-10']);
  // Sacarlo también funciona sin costo.
  assert.equal((await call('PUT', `/api/maintenance/${r.data.id}`, { ...r.data, status: 'cerrado', end_date: '2027-01-11', cost: null })).status, 200);
});

test('H-016: un auto con reservas por delante que va al taller pasa sus reservas a otro libre', async () => {
  const [car, other] = freeCar('B');
  assert.ok(car && other, 'el ejemplo tiene dos autos B libres');
  const cust = (await call('POST', '/api/customers', { full_name: 'Cliente Taller', phone: '+54 9 2901 555777' })).data;
  const r = await call('POST', '/api/reservations', {
    customer_id: cust.id, category_id: car.category_id, vehicle_id: car.id, pickup_branch_id: 1, return_branch_id: 1,
    pickup_at: '2027-02-10T10:00', return_at: '2027-02-12T10:00', status: 'confirmada',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  // La pantalla encuentra la reserva por delante de ese auto.
  const ahead = (await call('GET', `/api/reservations?vehicle_id=${car.id}&status=pendiente,confirmada&from=2027-02-01`)).data;
  assert.ok(ahead.some((x) => x.id === r.data.id));
  // La lista de autos muestra la próxima salida.
  assert.equal((await call('GET', '/api/vehicles')).data.find((x) => x.id === car.id).next_out, '2027-02-10T10:00');

  assert.equal((await call('POST', '/api/maintenance', { vehicle_id: car.id, kind: 'reparacion', start_date: '2027-02-01', status: 'abierto' })).status, 201);
  const moved = (await call('POST', `/api/vehicles/${car.id}/release`, { reservation_ids: [r.data.id] })).data;
  assert.equal(moved.length, 1);
  assert.ok(moved[0].plate && moved[0].plate !== car.plate, 'quedó con otro auto de la misma categoría');
  const after = (await call('GET', `/api/reservations/${r.data.id}`)).data;
  assert.notEqual(after.vehicle_id, car.id);
  // Una reserva de otro auto no se toca.
  assert.deepEqual((await call('POST', `/api/vehicles/${car.id}/release`, { reservation_ids: [r.data.id] })).data, []);
});

test('H-009: el WhatsApp del cliente tiene que ser un número', async () => {
  for (const phone of ['hola', '123', '+54 9 2901 abc']) {
    const r = await call('POST', '/api/customers', { full_name: 'Mal cargado', phone });
    assert.equal(r.status, 400, phone);
    assert.match(r.data.error, /WhatsApp/);
  }
  assert.equal((await call('POST', '/api/customers', { full_name: 'Bien cargado', phone: '+54 9 (2901) 555-123' })).status, 201);
  assert.equal((await call('POST', '/api/customers', { full_name: 'Sin teléfono' })).status, 201);
});

test('H-002: los pedidos para confirmar traen sus notas, el auto y si falta la licencia', async () => {
  const cust = (await call('POST', '/api/customers', { full_name: 'Pedido Web' })).data;
  const cat = db.prepare("SELECT id FROM categories WHERE code = 'C'").get().id;
  const r = await call('POST', '/api/reservations', {
    customer_id: cust.id, category_id: cat, pickup_branch_id: 1, return_branch_id: 1,
    pickup_at: '2027-03-10T10:00', return_at: '2027-03-12T10:00', status: 'pendiente', notes: 'Falta licencia del cliente',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const p = (await call('GET', '/api/dashboard')).data.pending.find((x) => x.id === r.data.id);
  assert.equal(p.notes, 'Falta licencia del cliente');
  assert.equal(p.vehicle_plate, null);
  assert.equal(p.customer_license, null);
});
