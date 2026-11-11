'use strict';

/* Recordatorio al cliente 12 horas antes de la entrega: automático con WhatsApp conectado, o desde Hoy. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, setSetting } = require('../src/db');
const { ensureAdmin } = require('../src/app');
const { seed } = require('../src/seed');
const R = require('../src/reservations');
const M = require('../src/reminders');
const { fmtLocal } = require('../src/util');

function setup() {
  const db = openDb(':memory:');
  ensureAdmin(db);
  seed(db);
  db.prepare("UPDATE reservations SET status = 'cancelada'").run(); // solo cuentan las de esta prueba
  const car = db.prepare("SELECT id, category_id FROM vehicles WHERE plate = 'AF123BC'").get();
  const customer = db.prepare("SELECT id FROM customers WHERE phone <> '' ORDER BY id").get().id;
  const inHours = (h) => fmtLocal(new Date(Date.now() + h * 3600000));
  const book = (h, status = 'confirmada') =>
    R.createReservation(db, { customer_id: customer, category_id: car.category_id, pickup_at: inHours(h), return_at: inHours(h + 48), status, allow_overbooking: true });
  return { db, book };
}
const connect = (db) => {
  for (const [k, v] of Object.entries({ wa_phone_id: '12345', wa_token: 'tok', wa_template: 'floty_aviso', reminder_auto: '1' })) setSetting(db, k, v);
};
const fakeMeta = (ok = true) => {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok, status: ok ? 200 : 400, json: async () => (ok ? { messages: [{ id: 'm1' }] } : { error: { message: 'plantilla rechazada' } }) };
  };
  return { calls, restore: () => (global.fetch = original) };
};

test('recordatorio: entran las confirmadas que salen en las próximas 12 horas', () => {
  const { db, book } = setup();
  const soon = book(5);
  book(20); // todavía falta
  book(3, 'pendiente'); // sin confirmar no se recuerda
  const list = M.pending(db);
  assert.deepEqual(list.map((r) => r.id), [soon.id]);
  assert.match(list[0].text, /^Hola \S+! Te recordamos que (hoy|el \d\d\/\d\d) a las \d\d:\d\d retirás tu auto/);
  assert.match(list[0].text, new RegExp(soon.code));
});

test('recordatorio automático: sale una sola vez y solo con la opción activada y WhatsApp conectado', async () => {
  const { db, book } = setup();
  const r = book(5);
  const meta = fakeMeta();
  try {
    assert.equal(await M.sendDue(db), 0, 'apagado no manda');
    connect(db);
    assert.equal(await M.sendDue(db), 1);
    assert.equal(await M.sendDue(db), 0, 'no lo repite');
    assert.equal(meta.calls.length, 1);
    assert.equal(meta.calls[0].template.name, 'floty_aviso');
    assert.deepEqual(M.pending(db), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reservation_log WHERE reservation_id = ? AND action = 'recordatorio_enviado'").get(r.id).n, 1);
  } finally {
    meta.restore();
  }
});

test('recordatorio automático: si WhatsApp lo rechaza, no insiste y queda en Hoy para mandarlo a mano', async () => {
  const { db, book } = setup();
  const r = book(5);
  connect(db);
  const meta = fakeMeta(false);
  try {
    assert.equal(await M.sendDue(db), 0);
    assert.equal(await M.sendDue(db), 0);
    assert.equal(meta.calls.length, 1, 'un solo intento');
    assert.deepEqual(M.pending(db).map((x) => [x.id, x.reminder_at]), [[r.id, 'error']]);
  } finally {
    meta.restore();
  }
});

test('recordatorio desde Hoy: sin WhatsApp conectado queda anotado y sale de la lista', async () => {
  const { db, book } = setup();
  const r = book(5);
  assert.deepEqual(await M.sendOne(db, r.id, null), { ok: true, api: false });
  assert.deepEqual(M.pending(db), []);
  await assert.rejects(() => M.sendOne(db, r.id, null), /ya no tiene un recordatorio/);
});
