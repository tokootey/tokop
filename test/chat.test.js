'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { openDb, setSetting } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { seed } = require('../src/seed');
const { fmtLocal } = require('../src/util');

let db;
let server;
let base;
let uploadsDir;

async function call(method, p, body, headers = {}) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const day = (n, h = 10) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(h, 0, 0, 0);
  return fmtLocal(d);
};

test.before(async () => {
  db = openDb(':memory:');
  ensureAdmin(db);
  seed(db);
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-'));
  server = createApp(db, { uploadsDir }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

test('desactivado no responde nada', async () => {
  setSetting(db, 'chat_enabled', '0');
  assert.equal((await call('GET', '/api/public/chat/config')).status, 403);
  setSetting(db, 'chat_enabled', '1');
});

test('la configuración pública no expone datos internos', async () => {
  setSetting(db, 'chat_whatsapp', '+54 9 2901 <b>123456');
  const r = await call('GET', '/api/public/chat/config');
  assert.equal(r.status, 200);
  assert.equal(r.data.whatsapp, '5492901123456', 'sólo números');
  assert.ok(r.data.branches.length >= 1);
  assert.deepEqual(Object.keys(r.data.branches[0]).sort(), ['code', 'name']);
  assert.ok(r.data.faq.some((f) => /Edad mínima/.test(f.q) && /21 años/.test(f.a)));
  assert.ok(!JSON.stringify(r.data).includes('api_key'));
});

test('cotiza disponibilidad y precio sin mostrar cuántos autos quedan', async () => {
  const r = await call('POST', '/api/public/chat/quote', { pickup_at: day(30), return_at: day(33), pickup_branch: 'USH' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.options.length > 0);
  const o = r.data.options[0];
  assert.equal(o.days, 3);
  assert.ok(o.total > 0);
  assert.equal(o.available, undefined);
  assert.ok(r.data.options.every((x, i, a) => i === 0 || a[i - 1].total <= x.total), 'ordenadas por precio');
  assert.equal((await call('POST', '/api/public/chat/quote', { pickup_at: day(-2), return_at: day(1) })).status, 400, 'fecha pasada');
  assert.equal((await call('POST', '/api/public/chat/quote', { pickup_at: day(5), return_at: day(4) })).status, 400, 'devolución antes del retiro');
  assert.equal((await call('POST', '/api/public/chat/quote', { pickup_at: 'mañana' })).status, 400);
});

test('el pedido entra como reserva pendiente desde la web', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n;
  const r = await call('POST', '/api/public/chat/book', { pickup_at: day(40), return_at: day(44), pickup_branch: 'USH', category: 'B', name: 'Lucía Chat', email: 'lucia.chat@example.com', phone: '+56 9 1234 5678', notes: 'Llego tarde', doc_number: 'P123', birth_date: '1991-02-03', address: 'Calle 9', license_number: 'LIC7', license_expiry: '2099-01-01' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.code, /^R-/);
  const res = db.prepare('SELECT r.*, c.full_name, c.email, cat.code AS cat FROM reservations r JOIN customers c ON c.id = r.customer_id JOIN categories cat ON cat.id = r.category_id WHERE r.code = ?').get(r.data.code);
  assert.equal(res.status, 'pendiente');
  assert.equal(res.source, 'web');
  assert.equal(res.cat, 'B');
  assert.equal(res.full_name, 'Lucía Chat');
  // Lo que el cliente completó al reservar queda en su ficha: con eso alcanza para entregar.
  const c = db.prepare('SELECT doc_number, birth_date, address, license_number, license_expiry FROM customers WHERE id = ?').get(res.customer_id);
  assert.deepEqual({ ...c }, { doc_number: 'P123', birth_date: '1991-02-03', address: 'Calle 9', license_number: 'LIC7', license_expiry: '2099-01-01' });
  assert.match(res.notes, /link de reservas/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, before + 1);
});

test('auto de consulta: en la web se ofrece por WhatsApp, sin precio y sin reserva', async () => {
  const range = { pickup_at: day(70), return_at: day(72), pickup_branch: 'USH' };
  const catB = db.prepare("SELECT id FROM categories WHERE code = 'B'").get().id;
  db.prepare('UPDATE vehicles SET web_inquiry = 1 WHERE category_id = ?').run(catB);
  try {
    const b = (await call('POST', '/api/public/chat/quote', range)).data.options.find((o) => o.code === 'B');
    assert.equal(b.inquiry_only, true);
    assert.equal(b.total, null);
    const book = await call('POST', '/api/public/chat/book', { ...range, category: 'B', name: 'Quiere Pagar', phone: '+507 6000 0002' });
    assert.equal(book.status, 409);
  } finally {
    db.prepare('UPDATE vehicles SET web_inquiry = 0').run();
  }
  const again = (await call('POST', '/api/public/chat/quote', range)).data.options.find((o) => o.code === 'B');
  assert.ok(again.total > 0 && !again.inquiry_only);
});

test('valida los datos y descarta robots', async () => {
  const ok = { pickup_at: day(50), return_at: day(52), pickup_branch: 'USH', category: 'A' };
  assert.equal((await call('POST', '/api/public/chat/book', { ...ok, name: 'Al', email: 'a@b.co' })).status, 400, 'nombre corto');
  assert.equal((await call('POST', '/api/public/chat/book', { ...ok, name: 'Ana Pérez' })).status, 400, 'sin contacto');
  const before = db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n;
  const bot = await call('POST', '/api/public/chat/book', { ...ok, name: 'Robot Spam', email: 'x@y.co', _gotcha: 'http://spam' });
  assert.equal(bot.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n, before, 'el robot no crea nada');
});

test('sólo responde a los sitios autorizados', async () => {
  const bad = await call('GET', '/api/public/chat/config', undefined, { Origin: 'https://sitio-ajeno.example' });
  assert.equal(bad.status, 403);
  const good = await call('GET', '/api/public/chat/config', undefined, { Origin: 'https://www.discoverushuaia.com.ar' });
  assert.equal(good.status, 200);
});

test('limita la cantidad de pedidos por persona', async () => {
  const ok = { pickup_at: day(60), return_at: day(62), pickup_branch: 'USH', category: 'A', name: 'Muchos Pedidos', email: 'muchos@example.com' };
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await call('POST', '/api/public/chat/book', ok)).status);
  assert.ok(statuses.includes(429), statuses.join(','));
});

test('horario de retiro de la sucursal en el cotizador', async () => {
  const { pickupProblem, agencyNow } = require('../src/routes/chat');
  const b = { name: 'Aeropuerto', pickup_from: '08:00', late_after: '20:00', late_pickup_from: '09:00' };
  assert.match(pickupProblem(b, '2030-05-10T07:30', '2030-05-01T12:00'), /a partir de las 08:00/);
  assert.equal(pickupProblem(b, '2030-05-10T08:00', '2030-05-01T12:00'), null);
  // Reserva hecha a las 20:30: mañana recién desde las 9, y tampoco esta misma noche.
  assert.match(pickupProblem(b, '2030-05-02T08:30', '2030-05-01T20:30'), /a partir de las 09:00/);
  assert.match(pickupProblem(b, '2030-05-01T22:00', '2030-05-01T20:30'), /a partir de las 09:00/);
  assert.equal(pickupProblem(b, '2030-05-02T09:00', '2030-05-01T20:30'), null);
  assert.equal(pickupProblem(b, '2030-05-03T08:30', '2030-05-01T20:30'), null, 'pasado mañana vale el horario normal');
  assert.equal(pickupProblem(b, '2030-05-02T08:30', '2030-05-01T19:59'), null, 'antes de las 20 no hay tope');
  assert.match(pickupProblem(b, '2030-05-01T08:30', '2030-05-01T02:00'), /09:00/, 'de madrugada, hoy desde las 9');
  assert.equal(pickupProblem({ name: 'Sin horario' }, '2030-05-10T03:00', '2030-05-01T23:00'), null);
  assert.equal(agencyNow('PA', new Date('2030-05-02T01:30:00Z')), '2030-05-01T20:30', 'hora de Panamá, no la del servidor');

  db.prepare("UPDATE branches SET pickup_from = '08:00' WHERE code = 'USH'").run();
  const early = await call('POST', '/api/public/chat/quote', { pickup_at: day(30, 7), return_at: day(33), pickup_branch: 'USH' });
  assert.equal(early.status, 400);
  assert.match(early.data.error, /08:00/);
  assert.equal((await call('POST', '/api/public/chat/quote', { pickup_at: day(30, 8), return_at: day(33), pickup_branch: 'USH' })).status, 200);
  db.prepare("UPDATE branches SET pickup_from = NULL WHERE code = 'USH'").run();
});
