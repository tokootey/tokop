'use strict';

/* Alertas de la flota: seguro, cédula de circulación y service con un mes de anticipación, y service por kilómetros. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, at } = require('./etapa2-helper');

test('avisa el seguro y el service un mes antes, y el service por kilómetros', async () => {
  const app = await start();
  try {
    const call = await app.as('operador');
    const day = (n) => at(n).slice(0, 10);
    const put = (id, body) => call('PUT', `/api/vehicles/${id}`, body);
    const alerts = async (qs = '') => (await call('GET', `/api/dashboard${qs}`)).data.alerts;

    assert.deepEqual((await alerts()).documents, []);
    // Auto 1: la póliza vence en 29 días → avisa. Auto 2: en 31 días → todavía no.
    await put(1, { insurance_expiry: day(29) });
    await put(2, { insurance_expiry: day(31) });
    assert.deepEqual((await alerts()).documents.map((v) => v.plate), ['AA0001']);
    // El service con fecha avisa igual, un mes antes; también la cédula de circulación.
    await put(2, { service_due: day(20) });
    await put(3, { registration_expiry: day(5) });
    const docs = (await alerts()).documents;
    assert.deepEqual(docs.map((v) => [v.plate, v.service_due, v.registration_expiry]), [['AA0001', null, null], ['AA0002', day(20), null], ['AA0003', null, day(5)]]);
    // Un vencimiento ya pasado sigue avisando hasta que se actualiza.
    await put(1, { insurance_expiry: day(-3) });
    assert.ok((await alerts()).documents.some((v) => v.plate === 'AA0001'));
    // Por sucursal: el auto 2 está en la sucursal 2.
    assert.deepEqual((await alerts('?branch=2')).documents.map((v) => v.plate), ['AA0002']);

    // Service por kilómetros, también en alquiler por días: cada 5.000 km, avisa cuando faltan 500 o menos.
    await put(3, { service_every_km: 5000, km: 4400 });
    assert.deepEqual((await alerts()).service_km, []);
    await put(3, { km: 4600 });
    assert.deepEqual((await alerts()).service_km.map((v) => [v.plate, v.next_service_km]), [['AA0003', 5000]]);
  } finally {
    app.close();
  }
});
