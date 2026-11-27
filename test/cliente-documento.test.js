'use strict';

/* El cliente se reconoce por su documento, escrito con o sin guiones, puntos o espacios (pedido de Ancon). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./etapa2-helper');
const { setSetting } = require('../src/db');

test('documento: se encuentra con o sin guiones, no se duplica y el teléfono no identifica al cliente', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const post = (body) => call('POST', '/api/customers', body);
    const found = async (q) => (await call('GET', `/api/customers?q=${encodeURIComponent(q)}`)).data.map((c) => c.full_name);
    setSetting(app.db, 'pro_features', '1'); // "un cliente por documento" es de las funciones en prueba

    const ana = (await post({ full_name: 'Ana Guiones', doc_number: '8-999-7777', phone: '+507 6000 1111' })).data;
    // Buscar: como está guardado, sin guiones, con puntos; y un cliente guardado sin guiones se encuentra escribiéndolos.
    for (const q of ['8-999-7777', '89997777', '8.999.7777', '8 999 7777']) assert.deepEqual(await found(q), ['Ana Guiones'], q);
    await post({ full_name: 'Beto Pegado', doc_number: 'pe123456' });
    assert.deepEqual(await found('PE-12-3456'), ['Beto Pegado']);
    // Las reservas también se encuentran por el documento sin guiones.
    const r = app.reserve();
    app.db.prepare('UPDATE reservations SET customer_id = ? WHERE id = ?').run(ana.id, r.id);
    assert.deepEqual((await call('GET', '/api/reservations?q=89997777')).data.map((x) => x.id), [r.id]);

    // Cargarlo de nuevo con otro formato: no se duplica, y la respuesta trae su ficha para elegirlo.
    const again = await post({ full_name: 'Ana Otra Vez', doc_number: '89997777' });
    assert.equal(again.status, 409);
    assert.match(again.data.error, /Ya hay un cliente con ese documento: Ana Guiones/);
    assert.equal(again.data.details.customer.id, ana.id);
    assert.equal(again.data.details.customer.phone, '+507 6000 1111');
    // Editarlo sin tocarle el documento se puede; ponerle a otro ese documento, no.
    assert.equal((await call('PUT', `/api/customers/${ana.id}`, { doc_number: '8-999-7777', phone: '+507 6000 2222' })).status, 200);
    const beto = app.db.prepare("SELECT id FROM customers WHERE full_name = 'Beto Pegado'").get().id;
    assert.equal((await call('PUT', `/api/customers/${beto}`, { doc_number: '8 999 7777' })).status, 409);

    // Dos clientes pueden compartir el teléfono: lo que los distingue es el documento.
    const hijo = await post({ full_name: 'Hijo de Ana', doc_number: '8-111-2222', phone: '+507 6000 2222' });
    assert.equal(hijo.status, 201);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM customers WHERE phone = '+507 6000 2222'").get().n, 2);
  } finally {
    await app.close();
  }
});
