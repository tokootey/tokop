'use strict';

/* Con las funciones a pedido: no se entrega ni se recibe un auto sin km, combustible y al menos una foto. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./etapa2-helper');
const { setSetting } = require('../src/db');

const photo = (db, id, stage) =>
  db.prepare("INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path, created_at) VALUES (?, ?, 'frente.jpg', 'image/jpeg', 1, 'x', '2026-01-01T00:00')").run(id, stage);

test('entrega y devolución piden km, combustible y fotos; sin las funciones a pedido, no', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const libre = app.reserve({ name: 'Sin funciones', vehicle_id: 2 });
    assert.equal((await call('POST', `/api/reservations/${libre.id}/checkout`, {})).status, 200, 'apagado no cambia nada');

    setSetting(app.db, 'pro_features', '1');
    const r = app.reserve({ name: 'Ana' });
    const out = (body) => call('POST', `/api/reservations/${r.id}/checkout`, body);
    const km = app.db.prepare('SELECT km FROM vehicles WHERE id = 1').get().km;

    assert.match((await out({ out_km: km, out_fuel: 8 })).data.error, /fotos/);
    photo(app.db, r.id, 'entrega');
    assert.match((await out({ out_fuel: 8 })).data.error, /kilometraje/);
    assert.match((await out({ out_km: km, out_fuel: '' })).data.error, /kilometraje/);
    assert.equal((await out({ out_km: km, out_fuel: 8 })).data.status, 'en_curso');

    const back = (body) => call('POST', `/api/reservations/${r.id}/checkin`, body);
    assert.match((await back({ in_km: km + 100, in_fuel: 8 })).data.error, /fotos/, 'las fotos de la entrega no sirven para la devolución');
    photo(app.db, r.id, 'devolucion');
    assert.match((await back({ in_km: km + 100 })).data.error, /kilometraje/);
    assert.equal((await back({ in_km: km + 100, in_fuel: 8 })).data.status, 'finalizada');
  } finally {
    app.close();
  }
});
