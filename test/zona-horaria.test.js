'use strict';

/* Zona horaria por agencia: sin el ajuste todo sigue con la hora del servidor; con el ajuste, la caja y los horarios van con la de la agencia. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./etapa2-helper');
const { fmtLocal, nowLocal, withZone, toAgency, fromAgency } = require('../src/util');

// Lo que marca un reloj de pared en esa zona, calculado aparte (sin usar el código que se prueba).
const wallIn = (zone, date) => date.toLocaleString('sv-SE', { timeZone: zone }).slice(0, 16).replace(' ', 'T');
// Una zona lejos de cualquier servidor nuestro, sin cambio de hora: la diferencia se ve seguro.
const ZONE = 'Asia/Tokyo';
const minutesApart = (a, b) => Math.abs(new Date(`${a}:00Z`) - new Date(`${b}:00Z`)) / 60000;

test('sin zona cargada, el reloj es el del servidor y las conversiones no cambian nada', () => {
  const d = new Date('2026-01-10T16:00:00Z');
  assert.equal(nowLocal(), fmtLocal(new Date()));
  assert.equal(toAgency(d), d);
  assert.equal(fromAgency(d), d);
  // Con una zona mal escrita tampoco se rompe: sigue la hora del servidor.
  withZone('No/Existe', () => assert.equal(toAgency(d), d));
  // Con una zona de verdad, ida y vuelta devuelve el mismo instante.
  withZone(ZONE, () => {
    assert.equal(fmtLocal(toAgency(d)), wallIn(ZONE, d));
    assert.equal(fromAgency(toAgency(d)).getTime(), d.getTime());
  });
});

test('zona horaria de la agencia: la caja corta el día a su medianoche y los horarios salen con su reloj', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const r = app.reserve({ status: 'pendiente' });
    // Un cobro a las 16:00 de hora universal: en Tokio ya es la 01:00 del día siguiente.
    const paidAt = new Date('2026-01-10T16:00:00Z');
    app.db.prepare("INSERT INTO payments (reservation_id, kind, method, amount, created_at) VALUES (?, 'pago', 'efectivo', 40, '2026-01-10 16:00:00')").run(r.id);
    const cash = async (date) => (await call('GET', `/api/cash?date=${date}`)).data.rows.map((p) => p.at);

    // Sin el ajuste (como todas las agencias hoy): el cobro cae en el día y la hora del servidor.
    const serverWall = fmtLocal(paidAt);
    assert.deepEqual(await cash(serverWall.slice(0, 10)), [serverWall]);

    // Una zona que no existe no se guarda.
    assert.equal((await call('PUT', '/api/settings', { timezone: 'Panama' })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { timezone: ZONE })).status, 200);

    // Con el ajuste: el mismo cobro pasa al día y la hora de la agencia.
    assert.deepEqual(await cash('2026-01-11'), ['2026-01-11T01:00']);
    assert.deepEqual(await cash('2026-01-10'), []);

    // Un horario que anota el servidor después de un pedido con datos (cambio de estado): va con el reloj de la agencia.
    const done = await call('POST', `/api/reservations/${r.id}/status`, { status: 'confirmada' });
    assert.equal(done.status, 200);
    const stamped = app.db.prepare('SELECT updated_at FROM reservations WHERE id = ?').get(r.id).updated_at;
    assert.ok(minutesApart(stamped, wallIn(ZONE, new Date())) <= 1, `${stamped} vs ${wallIn(ZONE, new Date())}`);

    // Al vaciarlo vuelve la hora del servidor.
    await call('PUT', '/api/settings', { timezone: '' });
    assert.deepEqual(await cash(serverWall.slice(0, 10)), [serverWall]);
  } finally {
    app.close();
  }
});
