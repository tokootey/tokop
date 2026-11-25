'use strict';

/* Clientes importados: con muchos, la lista se pide de a pocos; y se pueden completar aunque traigan un teléfono o una licencia viejos. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./etapa2-helper');

test('clientes importados: lista con límite y se completan aunque tengan licencia vencida o teléfono corto', async () => {
  const app = await start();
  try {
    const admin = await app.as('admin');
    const ins = app.db.prepare('INSERT INTO customers (full_name, phone, license_number, license_expiry) VALUES (?, ?, ?, ?)');
    const old = Number(ins.run('Importado Viejo', '61234', 'L1', '2020-01-01').lastInsertRowid);
    for (let i = 0; i < 30; i++) ins.run(`Importado ${i}`, null, null, null);

    const total = (await admin('GET', '/api/customers')).data.length;
    assert.ok(total > 30);
    assert.equal((await admin('GET', '/api/customers?limit=10')).data.length, 10);
    assert.deepEqual((await admin('GET', '/api/customers?q=Viejo&limit=10')).data.map((c) => c.id), [old]);

    // Completar el domicilio sin tocar lo que ya traía: se guarda.
    const row = (await admin('GET', `/api/customers/${old}`)).data;
    assert.equal((await admin('PUT', `/api/customers/${old}`, { ...row, address: 'Calle 50' })).status, 200);
    // Escribir un teléfono o una licencia vencida nuevos sigue sin dejar.
    assert.equal((await admin('PUT', `/api/customers/${old}`, { ...row, phone: '6999' })).status, 400);
    assert.equal((await admin('PUT', `/api/customers/${old}`, { ...row, license_expiry: '2021-01-01' })).status, 400);
    assert.equal((await admin('POST', '/api/customers', { full_name: 'Nuevo', license_expiry: '2020-01-01' })).status, 400);
  } finally {
    app.close();
  }
});
