'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { seed } = require('../src/seed');
const { fmtLocal } = require('../src/util');

// Pantalla Hoy: cuánto debe cada cliente que sale hoy y cuántos autos salen y vuelven mañana.
test('el panel trae lo que debe cada cliente y lo de mañana', async () => {
  const db = openDb(':memory:');
  ensureAdmin(db);
  seed(db);
  const server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) });
    if (!cookie && res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    await call('POST', '/api/auth/login', { email: 'admin@rentacar.local', password: 'admin123' });
    assert.equal((await call('POST', '/api/auth/password', { current: 'admin123', password: 'Ushuaia2026Segura' })).status, 200);
    const before = (await call('GET', '/api/dashboard')).data;

    const d = new Date();
    const day = (n, h) => fmtLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, h, 30));
    const customer = (await call('POST', '/api/customers', { full_name: 'Prueba Hoy', phone: '+54 9 2901 555123' })).data;
    const category = db.prepare('SELECT id FROM categories WHERE daily_rate > 0 ORDER BY id LIMIT 1').get().id;
    // Una que sale hoy (a las 23:30, para que no quede en el pasado) con una seña, y otra que sale mañana.
    const today = (await call('POST', '/api/reservations', { customer_id: customer.id, category_id: category, pickup_at: day(0, 23), return_at: day(2, 23), status: 'confirmada', allow_overbooking: true })).data;
    await call('POST', `/api/reservations/${today.id}/payments`, { kind: 'pago', amount: 1000 });
    await call('POST', '/api/reservations', { customer_id: customer.id, category_id: category, pickup_at: day(1, 10), return_at: day(3, 10), status: 'confirmada', allow_overbooking: true });

    const after = (await call('GET', '/api/dashboard')).data;
    const row = after.pickups_today.find((r) => r.id === today.id);
    assert.ok(row, 'la reserva de hoy aparece en "Salen hoy"');
    assert.equal(row.total, today.total);
    assert.equal(row.paid, 1000);
    assert.equal(row.customer_phone, '+54 9 2901 555123');
    assert.ok('category_name' in row && 'vehicle_brand' in row);
    assert.equal(after.tomorrow.pickups, before.tomorrow.pickups + 1);
    assert.equal(typeof after.tomorrow.returns, 'number');
  } finally {
    server.close();
    db.close();
  }
});
