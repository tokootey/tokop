'use strict';

/* La agencia maneja sola sus precios: promociones por fechas y precio final de cada reserva. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { ensureAdmin } = require('../src/app');
const { seed } = require('../src/seed');
const { computeQuote } = require('../src/pricing');
const R = require('../src/reservations');

// Lejos de las temporadas de ejemplo, que se cargan cerca de la fecha de hoy.
const TRIP = { pickup_at: '2099-05-10T10:00', return_at: '2099-05-13T10:00' };

function setup() {
  const db = openDb(':memory:');
  ensureAdmin(db);
  seed(db);
  const car = db.prepare("SELECT id, category_id FROM vehicles WHERE plate = 'AF123BC'").get();
  const customer = db.prepare('SELECT id FROM customers ORDER BY id').get().id;
  const season = (multiplier) =>
    db.prepare("INSERT INTO seasons (name, start_date, end_date, multiplier) VALUES ('Prueba', '2099-05-01', '2099-05-31', ?)").run(multiplier);
  return { db, car, customer, season };
}

test('promoción: un multiplicador menor a 1 baja el precio y se combina con un recargo', () => {
  const { db, car, season } = setup();
  const range = { category_id: car.category_id, ...TRIP };
  const normal = computeQuote(db, range);
  assert.equal(normal.season_extra, 0);

  season(0.8);
  const promo = computeQuote(db, range);
  assert.equal(promo.season_extra, Math.round(normal.base * -20) / 100);
  assert.ok(promo.total < normal.total);

  season(1.5);
  const both = computeQuote(db, range);
  assert.equal(both.season_extra, Math.round(normal.base * 20) / 100, '1.5 × 0.8 = 20 % más');
});

test('precio final: reemplaza al calculado, se conserva al editar y se puede volver a las tarifas', () => {
  const { db, car, customer } = setup();
  const r = R.createReservation(db, { customer_id: customer, category_id: car.category_id, vehicle_id: car.id, ...TRIP, status: 'confirmada' });
  const calculated = r.total;

  const agreed = R.updateReservation(db, r.id, { price_override: 123.456 }, null);
  assert.equal(agreed.total, 123.46);
  assert.equal(agreed.pricing.source, 'acordado');
  assert.equal(agreed.pricing.calculated_total, calculated);

  assert.equal(R.updateReservation(db, r.id, { notes: 'Pasa a buscarlo', price_override: '' }, null).total, 123.46, 'dejarlo vacío no lo borra');
  assert.equal(R.updateReservation(db, r.id, { price_override: 0 }, null).total, 0, 'puede ser sin cargo');

  for (const bad of [-1, 'mucho']) {
    assert.throws(() => R.updateReservation(db, r.id, { price_override: bad }, null), /precio final/);
  }

  const back = R.updateReservation(db, r.id, { recalculate: true }, null);
  assert.equal(back.total, calculated);
  assert.equal(back.pricing.calculated_total, undefined);
});
