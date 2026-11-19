'use strict';

/* Entrega no presencial: la agencia la marca al modificar la reserva y con ella aparece la pre-entrega en Documentación. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./etapa2-helper');

test('entrega no presencial: se marca y se desmarca al modificar la reserva', async () => {
  const app = await start();
  try {
    const admin = await app.as('admin');
    const r = app.reserve();
    const flag = () => app.db.prepare('SELECT express FROM reservations WHERE id = ?').get(r.id).express;
    assert.equal(flag(), 0);

    assert.equal((await admin('PUT', `/api/reservations/${r.id}`, { express: true })).status, 200);
    assert.equal(flag(), 1);
    assert.equal((await admin('GET', `/api/reservations/${r.id}`)).data.express, 1);

    // Modificar otra cosa no la cambia.
    assert.equal((await admin('PUT', `/api/reservations/${r.id}`, { notes: 'Retira en el hotel' })).status, 200);
    assert.equal(flag(), 1);

    assert.equal((await admin('PUT', `/api/reservations/${r.id}`, { express: false })).status, 200);
    assert.equal(flag(), 0);
  } finally {
    app.close();
  }
});

test('entrega no presencial: se puede marcar al crear la reserva', async () => {
  const app = await start();
  try {
    const r = app.reserve({ express: true });
    assert.equal(app.db.prepare('SELECT express FROM reservations WHERE id = ?').get(r.id).express, 1);
    assert.equal(app.db.prepare('SELECT express FROM reservations WHERE id = ?').get(app.reserve({ vehicle_id: 2 }).id).express, 0);
  } finally {
    app.close();
  }
});
