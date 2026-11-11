'use strict';

/* Caja diaria: los movimientos de plata del día, por sucursal. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./etapa2-helper');
const { nowLocal } = require('../src/util');

test('caja diaria: la garantía en efectivo suma, su devolución resta y la de tarjeta no entra', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const a = app.reserve({ name: 'Ana' }); // retira en la sucursal 1
    const b = app.reserve({ name: 'Beto', vehicle_id: 2, pickup_branch_id: 2, return_branch_id: 2 });
    const pay = (r, body) => call('POST', `/api/reservations/${r.id}/payments`, body);
    await pay(a, { kind: 'pago', method: 'tarjeta', amount: 150, reference: 'Voucher 99' });
    await pay(a, { kind: 'garantia', method: 'efectivo', amount: 200 });
    await pay(a, { kind: 'devolucion_garantia', method: 'efectivo', amount: 200 });
    await pay(a, { kind: 'garantia', method: 'tarjeta', amount: 500 }); // preautorización: no es plata en la caja
    await pay(a, { kind: 'devolucion', method: 'efectivo', amount: 20 });
    await pay(b, { kind: 'pago', method: 'efectivo', amount: 80 });
    await pay(b, { kind: 'pago', method: 'efectivo', amount: 30, branch_id: 1 }); // lo cobraron en la sucursal 1
    // Un pago de ayer no entra en la caja de hoy.
    db_yesterday(app.db, a.id);

    const today = nowLocal().slice(0, 10);
    const all = (await call('GET', '/api/cash')).data;
    assert.equal(all.date, today);
    assert.deepEqual(all.rows.map((p) => p.amount), [150, 200, -200, -20, 80, 30]);
    assert.equal(all.total, 240);
    assert.equal(all.cash, 90);
    assert.deepEqual(all.by_method, [{ method: 'tarjeta', amount: 150 }, { method: 'efectivo', amount: 90 }]);
    const first = all.rows[0];
    assert.deepEqual([first.code, first.customer_name, first.method, first.reference, first.at.slice(0, 10)], [a.code, 'Ana', 'tarjeta', 'Voucher 99', today]);

    const one = (await call('GET', '/api/cash?branch=1')).data;
    assert.deepEqual(one.rows.map((p) => p.amount), [150, 200, -200, -20, 30]);
    assert.equal((await call('GET', `/api/cash?branch=2&date=${today}`)).data.total, 80);
    assert.equal((await call('GET', '/api/cash?date=2020-01-01')).data.rows.length, 0);
  } finally {
    app.close();
  }
});

function db_yesterday(db, reservationId) {
  const y = new Date(Date.now() - 36 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare("INSERT INTO payments (reservation_id, kind, method, amount, created_at) VALUES (?, 'pago', 'efectivo', 999, ?)").run(reservationId, y);
}

test('estadísticas: ganancias por sucursal (cobrado menos taller y gastos de sus autos)', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const a = app.reserve();
    const b = app.reserve({ vehicle_id: 2, pickup_branch_id: 2, return_branch_id: 2 });
    await call('POST', `/api/reservations/${a.id}/payments`, { kind: 'pago', amount: 300 });
    await call('POST', `/api/reservations/${b.id}/payments`, { kind: 'pago', amount: 100 });
    await call('POST', `/api/reservations/${b.id}/payments`, { kind: 'garantia', amount: 500 }); // la garantía no es ganancia
    const today = nowLocal().slice(0, 10);
    app.db.prepare("INSERT INTO maintenance (vehicle_id, kind, description, start_date, cost, status) VALUES (1, 'service', 'Aceite', ?, 40, 'cerrado')").run(today);
    app.db.prepare("INSERT INTO expenses (vehicle_id, date, kind, amount) VALUES (2, ?, 'combustible', 15), (NULL, ?, 'otro', 999)").run(today, today);

    const s = (await call('GET', `/api/stats?from=${today}&to=${today}`)).data;
    assert.deepEqual(
      s.branches.map((x) => [x.name, x.rentals, x.collected, x.costs, x.net]),
      [['Tocumen', 1, 300, 40, 260], ['Centro', 1, 100, 15, 85]],
    );
    assert.equal((await (await app.as('operador'))('GET', '/api/stats')).status, 403);
  } finally {
    app.close();
  }
});
