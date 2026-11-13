'use strict';

/* Reglas de precio que carga cada agencia: tramos de días, fin de semana y feriados (con interruptor), km en alquileres cortos, horas de más y recargo por sucursal. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./etapa2-helper');
const { setSetting } = require('../src/db');
const { computeQuote, computeReturnCharges } = require('../src/pricing');

// 2030-01-04 es viernes; 2030-01-07, lunes.
const quote = (db, from, to, over = {}) => computeQuote(db, { category_id: 1, pickup_branch_id: 2, return_branch_id: 2, pickup_at: from, return_at: to, ...over });

test('sin cargar nada, el precio sale como siempre', async () => {
  const app = await start();
  try {
    const q = quote(app.db, '2030-01-04T10:00', '2030-01-10T10:00');
    assert.deepEqual([q.days, q.base, q.branch_fee, q.extra_hours_fee, q.km_included], [6, 300, 0, 0, 600]);
  } finally {
    app.close();
  }
});

test('tramos de días, fin de semana y feriados', async () => {
  const app = await start();
  try {
    const { db } = app;
    db.exec('UPDATE categories SET rate_6 = 45, rate_10 = 40, weekend_rate = 60, holiday_rate = 80 WHERE id = 1');
    // Tramos: de 6 a 9 días y desde 10, sin importar el día de retiro.
    assert.equal(quote(db, '2030-01-07T10:00', '2030-01-10T10:00').base, 150);
    assert.equal(quote(db, '2030-01-07T10:00', '2030-01-13T10:00').base, 270);
    assert.equal(quote(db, '2030-01-07T10:00', '2030-01-17T10:00').base, 400);

    // Fin de semana: apagado no cambia nada; prendido, retirando viernes por hasta 5 días.
    assert.equal(quote(db, '2030-01-04T10:00', '2030-01-06T10:00').base, 100);
    setSetting(db, 'weekend_rates_on', '1');
    assert.equal(quote(db, '2030-01-04T10:00', '2030-01-06T10:00').base, 120);
    assert.equal(quote(db, '2030-01-04T10:00', '2030-01-09T10:00').base, 300, 'viernes por 5 días: fin de semana');
    assert.equal(quote(db, '2030-01-07T10:00', '2030-01-09T10:00').base, 100, 'retirando lunes: tarifa normal');
    assert.equal(quote(db, '2030-01-04T10:00', '2030-01-10T10:00').base, 270, 'desde 6 días manda el tramo');

    // Feriados: sólo el día feriado, y sólo con el interruptor prendido.
    setSetting(db, 'holidays', '8/1/2030');
    assert.equal(quote(db, '2030-01-07T10:00', '2030-01-10T10:00').base, 150);
    setSetting(db, 'holiday_rates_on', '1');
    assert.equal(quote(db, '2030-01-07T10:00', '2030-01-10T10:00').base, 180);
  } finally {
    app.close();
  }
});

test('recargo por sucursal: una vez por alquiler y gratis desde los días cargados', async () => {
  const app = await start();
  try {
    const { db } = app;
    db.exec('UPDATE branches SET fee = 25, fee_free_days = 3 WHERE id = 1');
    const at = (from, to, pickup, ret) => quote(db, from, to, { pickup_branch_id: pickup, return_branch_id: ret });
    assert.equal(at('2030-01-07T10:00', '2030-01-09T10:00', 1, 1).branch_fee, 25, 'retira y devuelve ahí: una sola vez');
    assert.equal(at('2030-01-07T10:00', '2030-01-09T10:00', 2, 1).branch_fee, 25);
    assert.equal(at('2030-01-07T10:00', '2030-01-09T10:00', 2, 2).branch_fee, 0);
    assert.equal(at('2030-01-07T10:00', '2030-01-10T10:00', 1, 1).branch_fee, 0, 'desde 3 días no se cobra');
    db.exec('UPDATE branches SET fee_free_days = 0 WHERE id = 1');
    assert.deepEqual(at('2030-01-07T10:00', '2030-01-17T10:00', 1, 2).branch_fees, [{ name: 'Tocumen', amount: 25 }], 'con 0 se cobra siempre');
  } finally {
    app.close();
  }
});

test('horas de más por hora y límite de km sólo en alquileres cortos', async () => {
  const app = await start();
  try {
    const { db } = app;
    setSetting(db, 'grace_hours', '3');
    // Sin precio por hora: pasada la tolerancia es un día más.
    assert.equal(quote(db, '2030-01-07T10:00', '2030-01-09T15:00').days, 3);
    setSetting(db, 'late_hour_fee', '12.5');
    let q = quote(db, '2030-01-07T10:00', '2030-01-09T15:00');
    assert.deepEqual([q.days, q.extra_hours, q.extra_hours_fee], [2, 2, 25], '5 horas con 3 de cortesía: 2 por hora');
    q = quote(db, '2030-01-07T10:00', '2030-01-09T13:00');
    assert.deepEqual([q.days, q.extra_hours_fee], [2, 0], 'dentro de la cortesía no se cobra');
    q = quote(db, '2030-01-07T10:00', '2030-01-09T18:00');
    assert.deepEqual([q.days, q.extra_hours_fee], [3, 0], 'a la quinta hora de más es un día entero');

    // Km: el límite rige hasta 2 días; desde 3 son libres.
    setSetting(db, 'km_limit_max_days', '2');
    assert.equal(quote(db, '2030-01-07T10:00', '2030-01-09T10:00').km_included, 200);
    assert.equal(quote(db, '2030-01-07T10:00', '2030-01-10T10:00').km_included, null);
    const r = { category_id: 1, days: 3, total: 150, return_at: '2030-01-10T10:00' };
    const back = (inAt, days = 3) => computeReturnCharges(db, { ...r, days }, { out_km: 1000, out_fuel: 8 }, { in_km: 3000, in_fuel: 8, in_at: inAt });
    assert.deepEqual([back('2030-01-10T10:00').km_allowed, back('2030-01-10T10:00').km_excess], [null, 0]);
    assert.equal(back('2030-01-10T10:00', 2).km_excess, 1800);

    // Devolución tarde: 5 horas con 3 de cortesía son 2 horas por hora; 9 horas, un día.
    let c = back('2030-01-10T15:00');
    assert.deepEqual([c.late_days, c.late_hours, c.lines], [0, 2, [{ concept: 'Horas adicionales (2)', amount: 25 }]]);
    c = back('2030-01-10T19:00');
    assert.deepEqual([c.late_days, c.late_hours, c.total], [1, 0, 50]);
  } finally {
    app.close();
  }
});
