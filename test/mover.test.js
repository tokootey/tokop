'use strict';

/* Mover reservas de auto o de fecha, e intercambiar los autos de dos reservas. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { ensureAdmin } = require('../src/app');
const { seed } = require('../src/seed');
const R = require('../src/reservations');
const { fmtLocal } = require('../src/util');

function setup() {
  const db = openDb(':memory:');
  ensureAdmin(db);
  seed(db);
  const car = (plate) => db.prepare('SELECT id, category_id FROM vehicles WHERE plate = ?').get(plate);
  const customer = db.prepare('SELECT id FROM customers ORDER BY id').get().id;
  const at = (n) => {
    const d = new Date();
    d.setHours(10, 0, 0, 0);
    d.setDate(d.getDate() + n);
    return fmtLocal(d);
  };
  const book = (plate, from, to, status = 'confirmada') => {
    const v = car(plate);
    return R.createReservation(db, { customer_id: customer, category_id: v.category_id, vehicle_id: v.id, pickup_at: at(from), return_at: at(to), status, allow_overbooking: true });
  };
  return { db, car, at, book };
}
const plateOf = (db, id) => R.getReservation(db, id).vehicle_plate;

test('intercambiar: cada reserva se queda con el auto de la otra, con sus fechas y su precio', () => {
  const { db, book } = setup();
  const a = book('AF123BC', 20, 25);
  const b = book('AF456DE', 22, 27);
  R.swapVehicles(db, a.id, b.id, null);
  const [na, nb] = [R.getReservation(db, a.id), R.getReservation(db, b.id)];
  assert.equal(na.vehicle_plate, 'AF456DE');
  assert.equal(nb.vehicle_plate, 'AF123BC');
  assert.deepEqual([na.pickup_at, na.return_at, na.total], [a.pickup_at, a.return_at, a.total]);
  assert.deepEqual([nb.pickup_at, nb.return_at, nb.total], [b.pickup_at, b.return_at, b.total]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reservation_log WHERE action = 'vehiculo_intercambiado'").get().n, 2);
});

test('intercambiar: no se pisa con una tercera reserva, y no toca nada si falla', () => {
  const { db, book } = setup();
  const a = book('AF123BC', 20, 30);
  const b = book('AF456DE', 22, 24);
  book('AF456DE', 26, 28); // el otro auto está ocupado en otra parte de las fechas de "a"
  assert.throws(() => R.swapVehicles(db, a.id, b.id, null), /AF456DE no está libre/);
  assert.equal(plateOf(db, a.id), 'AF123BC');
  assert.equal(plateOf(db, b.id), 'AF456DE');
});

test('intercambiar: rechaza otra categoría, un auto ya entregado y reservas sin auto', () => {
  const { db, book, car } = setup();
  const a = book('AF123BC', 20, 25);
  assert.throws(() => R.swapVehicles(db, a.id, book('AE321HI', 20, 25).id, null), /misma categoría/);
  const out = book('AF456DE', 20, 25);
  R.checkout(db, out.id, { out_km: 30000, out_fuel: 8 }, null);
  assert.throws(() => R.swapVehicles(db, a.id, out.id, null), /ya entregado/);
  const none = R.createReservation(db, { customer_id: a.customer_id, category_id: car('AF123BC').category_id, pickup_at: a.pickup_at, return_at: a.return_at, status: 'pendiente', allow_overbooking: true });
  assert.throws(() => R.swapVehicles(db, a.id, none.id, null), /auto asignado/);
});

test('opciones para mover: autos libres e intercambios posibles, sin el auto actual', () => {
  const { db, book } = setup();
  const a = book('AF123BC', 20, 25);
  const b = book('AF456DE', 22, 24);
  const o = R.moveOptions(db, a.id);
  assert.ok(o.free.some((v) => v.plate === 'AG789FG'), 'el tercer auto de la categoría está libre');
  assert.ok(!o.free.some((v) => ['AF123BC', 'AF456DE'].includes(v.plate)));
  assert.deepEqual(o.swaps.map((s) => [s.plate, s.reservation_id]), [['AF456DE', b.id]]);
  // Con dos reservas en el mismo auto dentro de esas fechas, no hay intercambio simple.
  book('AF456DE', 24, 25);
  assert.deepEqual(R.moveOptions(db, a.id).swaps, []);
});

test('mover a otro auto y a otros días, y no sobre una reserva ocupada', () => {
  const { db, book, car, at } = setup();
  const a = book('AF123BC', 20, 25);
  book('AF456DE', 30, 35);
  const moved = R.updateReservation(db, a.id, { vehicle_id: car('AG789FG').id, pickup_at: at(21), return_at: at(26) }, null);
  assert.equal(moved.vehicle_plate, 'AG789FG');
  assert.equal(moved.pickup_at, at(21));
  assert.throws(() => R.updateReservation(db, a.id, { vehicle_id: car('AF456DE').id, pickup_at: at(31), return_at: at(36) }, null), /no está disponible/);
});
