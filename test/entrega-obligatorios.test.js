'use strict';

/* No se entrega ni se recibe un auto sin al menos una foto de esa etapa. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./etapa2-helper');

const photo = (db, id, stage) =>
  db.prepare("INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path, created_at) VALUES (?, ?, 'frente.jpg', 'image/jpeg', 1, 'x', '2026-01-01T00:00')").run(id, stage);

test('entrega y devolución piden fotos del auto', async () => {
  const app = await start();
  try {
    app.db.exec('DROP TRIGGER prueba_con_fotos');
    const call = await app.as('admin');
    const r = app.reserve({ name: 'Ana' });
    const out = () => call('POST', `/api/reservations/${r.id}/checkout`, {});
    const km = app.db.prepare('SELECT km FROM vehicles WHERE id = 1').get().km;

    assert.match((await out()).data.error, /fotos/);
    photo(app.db, r.id, 'entrega');
    assert.equal((await out()).data.status, 'en_curso');

    const back = () => call('POST', `/api/reservations/${r.id}/checkin`, { in_km: km + 100, in_fuel: 8 });
    assert.match((await back()).data.error, /fotos/, 'las fotos de la entrega no sirven para la devolución');
    photo(app.db, r.id, 'devolucion');
    assert.equal((await back()).data.status, 'finalizada');
  } finally {
    app.close();
  }
});
