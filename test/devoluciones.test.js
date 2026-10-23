'use strict';

/* Política de devolución de dinero al cancelar: cálculo, registro y configuración por empresa. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, setSetting } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { seed } = require('../src/seed');
const { refundFor } = require('../src/refunds');
const { fmtLocal } = require('../src/util');
const R = require('../src/reservations');

const DEFAULTS = { refund_full_hours: '72', refund_partial_hours: '24', refund_partial_pct: '50' };
const NOW = new Date(2027, 0, 10, 12, 0);
const pickupIn = (hours) => ({ pickup_at: fmtLocal(new Date(NOW.getTime() + hours * 3600000)), balance: { paid: 1000 } });

test('cálculo: 100 % con 72 h o más, 50 % entre 72 y 24 h, nada con menos o si no se presenta', () => {
  const pct = (hours, reason) => refundFor(pickupIn(hours), DEFAULTS, NOW, reason).percent;
  assert.equal(pct(100), 100);
  assert.equal(pct(72), 100);
  assert.equal(pct(71.5), 50);
  assert.equal(pct(24), 50);
  assert.equal(pct(23.5), 0);
  assert.equal(pct(-5), 0); // ya pasó la hora de retiro
  assert.equal(pct(100, 'no_show'), 0);
  const r = refundFor(pickupIn(48), DEFAULTS, NOW);
  assert.deepEqual([r.paid, r.amount, r.hours_before, r.rule], [1000, 500, 48, 'entre 72 y 24 h antes']);
  // Sin pagos no hay nada que devolver.
  assert.equal(refundFor({ ...pickupIn(100), balance: { paid: 0 } }, DEFAULTS, NOW).amount, 0);
});

test('cálculo: respeta la política de cada empresa y corrige valores inválidos', () => {
  const custom = { refund_full_hours: '48', refund_partial_hours: '12', refund_partial_pct: '30' };
  assert.equal(refundFor(pickupIn(50), custom, NOW).percent, 100);
  assert.equal(refundFor(pickupIn(20), custom, NOW).amount, 300);
  assert.equal(refundFor(pickupIn(10), custom, NOW).percent, 0);
  // Vacíos o basura: se usan los valores por defecto. Parcial mayor que total: se recorta.
  assert.equal(refundFor(pickupIn(48), { refund_full_hours: '', refund_partial_hours: 'abc', refund_partial_pct: '' }, NOW).percent, 50);
  assert.equal(refundFor(pickupIn(30), { refund_full_hours: '24', refund_partial_hours: '48', refund_partial_pct: '50' }, NOW).percent, 100);
  // Un porcentaje mayor a 100 se recorta a 100: nunca se devuelve más de lo pagado.
  assert.equal(refundFor(pickupIn(30), { ...DEFAULTS, refund_partial_pct: '250' }, NOW).amount, 1000);
});

/* ---------- Desde la API: se muestra antes de cancelar y queda registrado ---------- */
let server;
let base;
let cookie;
let db;

async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/** Reserva confirmada que se retira dentro de `hours` horas, con un pago de 1000. */
async function paidReservation(hours) {
  const c = await call('POST', '/api/customers', { full_name: `Cliente ${hours} h` });
  const cat = db.prepare('SELECT id FROM categories ORDER BY id LIMIT 1').get().id;
  const br = db.prepare('SELECT id FROM branches ORDER BY id LIMIT 1').get().id;
  const at = (h) => fmtLocal(new Date(Date.now() + h * 3600000));
  const r = await call('POST', '/api/reservations', {
    customer_id: c.data.id,
    category_id: cat,
    pickup_branch_id: br,
    return_branch_id: br,
    pickup_at: at(hours),
    return_at: at(hours + 72),
    status: 'confirmada',
    allow_overbooking: true,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await call('POST', `/api/reservations/${r.data.id}/payments`, { kind: 'pago', method: 'efectivo', amount: 1000 })).status, 200);
  return r.data;
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
  assert.equal((await call('POST', '/api/auth/password', { current: 'admin123', password: 'Devolucion2026x' })).status, 200);
});

test.after(() => server.close());

test('cancelar: muestra antes cuánto se devuelve y después queda registrado en la reserva', async () => {
  const r = await paidReservation(24 * 5);
  const preview = await call('GET', `/api/reservations/${r.id}/refund`);
  assert.deepEqual([preview.data.percent, preview.data.amount], [100, 1000]);

  const res = await call('POST', `/api/reservations/${r.id}/status`, { status: 'cancelada', reason: 'Cambio de planes' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.data.status, res.data.refund.percent, res.data.refund.amount], ['cancelada', 100, 1000]);
  const entry = res.data.log.find((l) => l.action === 'devolucion_calculada');
  assert.deepEqual(JSON.parse(entry.detail), { porcentaje: 100, devolver: 1000, pagado: 1000, regla: '72 h o más antes' });

  // Con 48 h de anticipación, la mitad.
  const r2 = await paidReservation(48);
  assert.equal((await call('POST', `/api/reservations/${r2.id}/status`, { status: 'cancelada' })).data.refund.amount, 500);
  // "No se presentó" recién cuando pasó la hora de retiro; antes, se cancela.
  const r3 = await paidReservation(24 * 5);
  const early = await call('POST', `/api/reservations/${r3.id}/status`, { status: 'no_show' });
  assert.equal(early.status, 409);
  assert.match(early.data.error, /hora de retiro/);
  db.prepare('UPDATE reservations SET pickup_at = ? WHERE id = ?').run(fmtLocal(new Date(Date.now() - 3600000)), r3.id);
  // Si no se presenta, nada (y también queda registrado).
  const ns = await call('POST', `/api/reservations/${r3.id}/status`, { status: 'no_show' });
  assert.equal(ns.data.refund.amount, 0);
  assert.ok(ns.data.log.some((l) => l.action === 'devolucion_calculada'));
});

test('Ajustes: la política se guarda por empresa y se validan los valores', async () => {
  assert.equal((await call('PUT', '/api/settings', { refund_partial_pct: '150' })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { refund_full_hours: '24', refund_partial_hours: '48' })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { refund_full_hours: '-1' })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { refund_full_hours: '48', refund_partial_hours: '12', refund_partial_pct: '30', refund_terms: 'Texto propio' })).status, 200);
  const s = (await call('GET', '/api/settings')).data;
  assert.deepEqual([s.refund_full_hours, s.refund_partial_hours, s.refund_partial_pct, s.refund_terms], ['48', '12', '30', 'Texto propio']);
  const r = await paidReservation(20);
  assert.equal((await call('GET', `/api/reservations/${r.id}/refund`)).data.amount, 300);
});

test('varias empresas: cada una cancela con su propia política', (t) => {
  const { openPlatform } = require('../src/platform');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-devol-'));
  const dbFile = path.join(dir, 'rentacar.db');
  const platform = openPlatform(openDb(dbFile), dbFile);
  t.after(() => {
    platform.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const a = platform.principal();
  const b = platform.get(platform.create({ name: 'Estricta SA', country: 'AR', admin_email: 'x@estricta.test' }).company.id);
  setSetting(b.db, 'refund_full_hours', '240'); // la empresa B sólo devuelve todo con 10 días de anticipación
  setSetting(b.db, 'refund_partial_pct', '0');
  const cancelIn = (c, hours) => {
    seed(c.db);
    const id = c.db.prepare("SELECT id FROM reservations WHERE status = 'confirmada' ORDER BY id LIMIT 1").get().id;
    c.db.prepare('UPDATE reservations SET pickup_at = ? WHERE id = ?').run(fmtLocal(new Date(Date.now() + hours * 3600000)), id);
    R.addPayment(c.db, id, { kind: 'pago', method: 'efectivo', amount: 1000 }, null);
    return R.changeStatus(c.db, id, 'cancelada', null).refund;
  };
  assert.equal(cancelIn(a, 100).percent, 100);
  assert.equal(cancelIn(b, 100).percent, 0);
});
