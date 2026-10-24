'use strict';

/*
 * Entrega y devolución en un hotel: la agencia la marca al reservar (con o sin los datos) y,
 * si faltan, el cliente los completa con el link de su reserva.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { seed } = require('../src/seed');
const { normalizeHotel } = require('../src/hotel');

let server;
let base;
let cookie;
let db;

async function call(method, url, body, auth = true) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie: cookie } : {}) },
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
  assert.equal((await call('POST', '/api/auth/password', { current: 'admin123', password: 'HotelEntrega2026' })).status, 200);
});

test.after(() => server.close());

test('normalizar: sin entrega ni devolución en hotel no se guarda nada; los textos se recortan', () => {
  assert.equal(normalizeHotel({ name: 'Arakur' }), null);
  assert.equal(normalizeHotel(null), null);
  const h = normalizeHotel({ deliver: 'on', name: '  Arakur ', room: '204', notes: 'x'.repeat(900) });
  assert.deepEqual([h.deliver, h.return, h.name, h.label, h.notes.length], [1, 0, 'Arakur', 'Arakur · hab. 204', 500]);
  assert.equal(normalizeHotel({ return: true }).label, 'a confirmar');
});

test('reserva con entrega en hotel sin datos: el cliente los completa con su link', async () => {
  const cust = await call('POST', '/api/customers', { full_name: 'Laura Gómez', phone: '+5491155550000' });
  const cat = db.prepare('SELECT id FROM categories ORDER BY id LIMIT 1').get().id;
  const created = await call('POST', '/api/reservations', {
    customer_id: cust.data.id,
    category_id: cat,
    pickup_branch_id: 1,
    return_branch_id: 1,
    pickup_at: '2027-03-10T10:00',
    return_at: '2027-03-13T10:00',
    status: 'confirmada',
    hotel: { deliver: true, return: true },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const r = created.data;
  assert.equal(r.pickup_branch_name, 'Hotel: a confirmar');
  assert.equal(r.hotel_missing, true);
  assert.ok(r.hotel_token && r.hotel_token.length >= 20);

  // El cliente abre su link (sin usuario) y completa.
  const page = await call('GET', `/api/public/hotel/${r.hotel_token}`, undefined, false);
  assert.equal(page.status, 200);
  assert.deepEqual([page.data.code, page.data.first_name, page.data.hotel.deliver], [r.code, 'Laura', 1]);
  assert.equal((await call('POST', `/api/public/hotel/${r.hotel_token}`, { name: 'Arakur' }, false)).status, 400, 'falta la dirección');
  const saved = await call('POST', `/api/public/hotel/${r.hotel_token}`, { name: 'Hotel Arakur', address: 'Cerro Alarken s/n', room: '204', deliver: 0, return: 0 }, false);
  assert.equal(saved.status, 200);

  const after = (await call('GET', `/api/reservations/${r.id}`)).data;
  assert.equal(after.pickup_branch_name, 'Hotel: Hotel Arakur · hab. 204');
  assert.equal(after.return_branch_name, 'Hotel: Hotel Arakur · hab. 204', 'el cliente no puede sacar la entrega en hotel');
  assert.equal(after.hotel_missing, false);
  assert.ok(after.log.some((l) => l.action === 'hotel_completado_por_cliente'));
  // En el listado y en Hoy también figura el hotel.
  const list = (await call('GET', '/api/reservations?status=confirmada')).data;
  assert.equal(list.find((x) => x.id === r.id).pickup_branch_name, 'Hotel: Hotel Arakur · hab. 204');

  // La agencia cambia: solo la entrega en el hotel; la devolución vuelve a la sucursal.
  const staff = await call('POST', `/api/reservations/${r.id}/hotel`, { ...after.hotel, return: false });
  assert.equal(staff.data.return_branch_name, db.prepare('SELECT name FROM branches WHERE id = 1').get().name);

  // Link inventado, o reserva cancelada: ya no sirve.
  assert.equal((await call('GET', '/api/public/hotel/inventado123', undefined, false)).status, 404);
  await call('POST', `/api/reservations/${r.id}/status`, { status: 'cancelada' });
  assert.equal((await call('GET', `/api/public/hotel/${r.hotel_token}`, undefined, false)).status, 404);
});
