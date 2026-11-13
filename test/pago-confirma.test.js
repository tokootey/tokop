'use strict';

/* Una reserva pendiente que queda paga entera se confirma sola. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./etapa2-helper');

test('pago completo confirma la reserva pendiente; la seña y la garantía no', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const r = app.reserve({ name: 'Ana', status: 'pendiente' });
    const pay = async (body) => (await call('POST', `/api/reservations/${r.id}/payments`, body)).data;

    assert.equal((await pay({ kind: 'garantia', method: 'tarjeta', amount: r.total + 500 })).status, 'pendiente');
    assert.equal((await pay({ kind: 'pago', method: 'efectivo', amount: r.total / 2 })).status, 'pendiente');
    const paid = await pay({ kind: 'pago', method: 'efectivo', amount: r.total / 2 });
    assert.equal(paid.status, 'confirmada');
    assert.equal(paid.balance.pending, 0);
    const actions = app.db.prepare('SELECT action FROM reservation_log WHERE reservation_id = ?').all(r.id).map((l) => l.action);
    assert.ok(actions.includes('confirmada'));
  } finally {
    app.close();
  }
});
