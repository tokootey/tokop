'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { seed } = require('../src/seed');
const { fmtLocal } = require('../src/util');

// Link de reservas: el pedido del cliente entra como pendiente y aparece en Hoy para confirmarlo.
test('el pedido del link aparece en Hoy para confirmar y sale al confirmarlo', async () => {
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
    const d = new Date();
    const day = (n) => fmtLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 10, 0));
    const quote = await call('POST', '/api/public/chat/quote', { pickup_at: day(20), return_at: day(23) });
    assert.equal(quote.status, 200, JSON.stringify(quote.data));
    const cat = quote.data.options[0].code;
    const book = await call('POST', '/api/public/chat/book', { pickup_at: day(20), return_at: day(23), category: cat, name: 'Turista Link', phone: '+1 555 123 4567' });
    assert.equal(book.status, 201, JSON.stringify(book.data));
    const saved = db.prepare('SELECT id, status, source, notes FROM reservations WHERE code = ?').get(book.data.code);
    assert.equal(saved.status, 'pendiente');
    assert.equal(saved.source, 'web');
    assert.match(saved.notes, /link de reservas/);

    await call('POST', '/api/auth/login', { email: 'admin@rentacar.local', password: 'admin123' });
    assert.equal((await call('POST', '/api/auth/password', { current: 'admin123', password: 'Ushuaia2026Segura' })).status, 200);
    const dash = (await call('GET', '/api/dashboard')).data;
    const row = dash.pending.find((r) => r.id === saved.id);
    assert.ok(row, 'el pedido está en "Para confirmar"');
    assert.equal(row.customer_name, 'Turista Link');
    assert.equal(row.customer_phone, '+1 555 123 4567');
    assert.equal(row.source, 'web');
    assert.ok('category_name' in row && 'pickup_at' in row && 'return_at' in row);
    assert.ok(dash.pending.every((r) => r.status === 'pendiente'));
    assert.equal(dash.pending.length, dash.pending_confirmation);

    assert.equal((await call('POST', `/api/reservations/${saved.id}/status`, { status: 'confirmada' })).status, 200);
    assert.ok(!(await call('GET', '/api/dashboard')).data.pending.some((r) => r.id === saved.id), 'ya no queda para confirmar');
  } finally {
    server.close();
    db.close();
  }
});
