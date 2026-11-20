'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { seed } = require('../src/seed');
const { fmtLocal } = require('../src/util');

// Ajustes payment_tools y agreed_price: precio acordado al crear, un cobro repartido entre alquiler y garantía,
// descuento de cargos de la garantía y anulación de movimientos del día.
test('precio acordado, pago repartido, descuento de la garantía y anular un pago', async () => {
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

    const d = new Date();
    const day = (n) => fmtLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 10, 0));
    const customer = (await call('POST', '/api/customers', { full_name: 'Prueba Pagos', phone: '+507 6000 0000' })).data;
    const category = db.prepare('SELECT id FROM categories WHERE daily_rate > 0 ORDER BY id LIMIT 1').get().id;
    const make = async (extra = {}) => (await call('POST', '/api/reservations', { customer_id: customer.id, category_id: category, pickup_at: day(5), return_at: day(8), status: 'confirmada', allow_overbooking: true, ...extra })).data;

    // Apagado (como en las demás agencias): la parte de garantía se ignora y no se puede descontar ni anular.
    const off = await make();
    const offPaid = (await call('POST', `/api/reservations/${off.id}/payments`, { kind: 'pago', method: 'yappy', amount: 100, deposit_part: 40 })).data;
    assert.deepEqual([offPaid.balance.paid, offPaid.balance.deposit_held, offPaid.payments.length], [100, 0, 1]);
    assert.equal((await call('POST', `/api/reservations/${off.id}/deposit-charge`, { concept: 'Panapass', amount: 10 })).status, 403);
    assert.equal((await call('POST', `/api/reservations/${off.id}/payments/${offPaid.payments[0].id}/void`, { reason: 'error' })).status, 403);

    assert.equal((await call('PUT', '/api/settings', { payment_tools: '1', agreed_price: '1' })).status, 200);

    // Precio acordado al crear: el total es el acordado y queda marcado como tal, con el de tarifa guardado aparte.
    const r = await make({ price_override: 300 });
    assert.equal(r.total, 300);
    assert.equal(r.pricing.source, 'acordado');
    assert.ok(r.pricing.calculated_total > 0);

    // Un cobro de 500 por Yappy: 300 de alquiler y 200 de garantía, en dos movimientos.
    const bad = await call('POST', `/api/reservations/${r.id}/payments`, { kind: 'pago', method: 'yappy', amount: 500, deposit_part: 600 });
    assert.equal(bad.status, 400);
    const paid = (await call('POST', `/api/reservations/${r.id}/payments`, { kind: 'pago', method: 'yappy', amount: 500, deposit_part: 200, reference: 'YP-1' })).data;
    assert.deepEqual([paid.balance.paid, paid.balance.deposit_held, paid.balance.pending], [300, 200, 0]);
    assert.deepEqual(paid.payments.map((p) => [p.kind, p.method, p.amount, p.reference]), [['pago', 'yappy', 300, 'YP-1'], ['garantia', 'yappy', 200, 'YP-1']]);
    // En la caja entra una sola vez: los 300 del alquiler (la garantía que no es efectivo no pasa por la caja).
    const cashOf = async () => (await call('GET', '/api/cash')).data.rows.filter((x) => x.reservation_id === r.id).map((x) => [x.kind, x.method, x.amount]);
    assert.deepEqual(await cashOf(), [['pago', 'yappy', 300]]);

    // Descuento de la garantía, cargo nuevo: suma el cargo, lo cobra de la garantía y la caja no cambia.
    assert.equal((await call('POST', `/api/reservations/${r.id}/deposit-charge`, { concept: 'Panapass', amount: 500 })).status, 400, 'no se descuenta más que la garantía retenida');
    assert.equal((await call('POST', `/api/reservations/${r.id}/deposit-charge`, { amount: 50 })).status, 400, 'pide el concepto');
    const c1 = (await call('POST', `/api/reservations/${r.id}/deposit-charge`, { concept: 'Panapass', detail: 'recargas', amount: 50 })).data;
    assert.deepEqual([c1.balance.due, c1.balance.paid, c1.balance.pending, c1.balance.deposit_held], [350, 350, 0, 150]);
    assert.equal(c1.charges.at(-1).description, 'Panapass: recargas');
    assert.deepEqual(await cashOf(), [['pago', 'yappy', 300]]);
    // "Ya figura en la reserva": no hay saldo pendiente, así que no hay nada que cobrar dos veces.
    assert.equal((await call('POST', `/api/reservations/${r.id}/deposit-charge`, { concept: 'Daños', amount: 20, existing: '1' })).status, 400);

    // Anular el pago de 300: pide motivo, deja de contar en el saldo y en la caja, y queda a la vista como anulado.
    const pay = c1.payments.find((p) => p.kind === 'pago' && p.method === 'yappy');
    assert.equal((await call('POST', `/api/reservations/${r.id}/payments/${pay.id}/void`, {})).status, 400);
    const v = (await call('POST', `/api/reservations/${r.id}/payments/${pay.id}/void`, { reason: 'importe mal cargado' })).data;
    assert.deepEqual([v.balance.paid, v.balance.pending, v.balance.deposit_held], [50, 300, 150]);
    assert.deepEqual(v.voided_payments.map((p) => [p.kind, p.amount, p.reason]), [['pago', 300, 'importe mal cargado']]);
    assert.deepEqual(await cashOf(), []);
    // Con saldo pendiente sí se puede cobrar de la garantía lo que ya figura, sin sumar otro cargo.
    const c2 = (await call('POST', `/api/reservations/${r.id}/deposit-charge`, { concept: 'Saldo del alquiler', amount: 100, existing: '1' })).data;
    assert.deepEqual([c2.balance.due, c2.balance.pending, c2.balance.deposit_held], [350, 200, 50]);

    // Anular un descuento de la garantía anula sus dos movimientos: la garantía vuelve y el pago sale.
    const ded = c2.payments.find((p) => p.kind === 'pago' && p.method === 'garantía' && p.amount === 100);
    const v2 = (await call('POST', `/api/reservations/${r.id}/payments/${ded.id}/void`, { reason: 'descuento equivocado' })).data;
    assert.deepEqual([v2.balance.pending, v2.balance.deposit_held, v2.voided_payments.length], [300, 150, 3]);

    // Un movimiento de otro día no se anula: se corrige con un movimiento contrario.
    const old = c2.payments.find((p) => p.kind === 'garantia');
    db.prepare("UPDATE payments SET created_at = '2020-01-01 12:00:00' WHERE id = ?").run(old.id);
    assert.equal((await call('POST', `/api/reservations/${r.id}/payments/${old.id}/void`, { reason: 'viejo' })).status, 409);
  } finally {
    server.close();
    db.close();
  }
});
