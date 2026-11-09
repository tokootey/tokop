'use strict';

/* La agencia maneja sola sus precios: promociones por días y precio final de cada reserva. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, setSetting } = require('../src/db');
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
  setSetting(db, 'prices_include_tax', '1');
  const car = db.prepare("SELECT id, category_id FROM vehicles WHERE plate = 'AF123BC'").get();
  const customer = db.prepare('SELECT id FROM customers ORDER BY id').get().id;
  const rate = db.prepare('SELECT daily_rate FROM categories WHERE id = ?').get(car.category_id).daily_rate;
  const promo = (from, to, promoRate, category = car.category_id) =>
    db.prepare("INSERT INTO promotions (name, category_id, start_date, end_date, promo_rate) VALUES ('Promo', ?, ?, ?, ?)").run(category, from, to, promoRate);
  return { db, car, customer, rate, promo };
}

test('promoción: esos días salen al precio de promo y el cotizador muestra la tarifa como precio anterior', () => {
  const { db, car, rate, promo } = setup();
  const range = { category_id: car.category_id, ...TRIP };
  const normal = computeQuote(db, range);
  assert.equal(normal.promo, null);

  promo('2099-05-01', '2099-05-31', rate / 2);
  const all = computeQuote(db, range);
  assert.equal(all.total, normal.total / 2);
  assert.equal(all.promo.days, 3);
  assert.equal(all.promo.before_total, normal.total);
});

test('promoción: solo cuenta los días que caen adentro, del auto elegido', () => {
  const { db, car, rate, promo } = setup();
  const range = { category_id: car.category_id, ...TRIP };
  const normal = computeQuote(db, range);
  const other = db.prepare('SELECT id FROM categories WHERE id <> ? ORDER BY id').get(car.category_id).id;
  promo('2099-05-01', '2099-05-31', 1, other);
  assert.equal(computeQuote(db, range).promo, null, 'la promo de otro auto no cambia nada');

  promo('2099-05-10', '2099-05-10', rate / 2);
  const oneDay = computeQuote(db, range);
  assert.equal(oneDay.promo.days, 1);
  assert.equal(oneDay.total, normal.total - rate / 2);
});

test('promoción: el precio fijado no suma temporada ni demanda, y pausada no se aplica', () => {
  const { db, car, rate, promo } = setup();
  const range = { category_id: car.category_id, ...TRIP };
  db.prepare("INSERT INTO seasons (name, start_date, end_date, multiplier) VALUES ('Alta', '2099-05-01', '2099-05-31', 2)").run();
  const high = computeQuote(db, range);
  assert.equal(high.total, rate * 6);

  promo('2099-05-01', '2099-05-31', rate / 2);
  const fixed = computeQuote(db, { ...range, dynamic_pct: 20 });
  assert.equal(fixed.total, (rate / 2) * 3);
  assert.equal(fixed.season_extra, 0);
  assert.equal(fixed.dynamic_extra, 0);

  db.prepare('UPDATE promotions SET active = 0').run();
  assert.equal(computeQuote(db, range).total, rate * 6);
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
