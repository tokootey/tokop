'use strict';

/* Demo: un año de movimiento para que Estadísticas se vea como en una agencia que ya trabaja. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { ensureAdmin } = require('../src/app');
const { seed, seedChoferes, seedHistory } = require('../src/seed');
const { computeStats } = require('../src/routes/stats');

const pad = (n) => String(n).padStart(2, '0');
const prevMonth = () => {
  const t = new Date();
  const first = new Date(t.getFullYear(), t.getMonth() - 1, 1);
  const last = new Date(t.getFullYear(), t.getMonth(), 0);
  return { from: `${first.getFullYear()}-${pad(first.getMonth() + 1)}-01`, to: `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}` };
};

for (const [mode, load] of [['turismo', seed], ['choferes', seedChoferes]]) {
  test(`historial de la demo (${mode}): el mes pasado tiene alquileres cobrados y gastos, y los autos de hoy no cambian`, () => {
    const db = openDb(':memory:');
    ensureAdmin(db);
    load(db);
    const cars = db.prepare('SELECT id, km, status FROM vehicles ORDER BY id').all();
    const before = db.prepare('SELECT id, status FROM reservations ORDER BY id').all();
    seedHistory(db);

    assert.deepEqual(db.prepare('SELECT id, km, status FROM vehicles ORDER BY id').all(), cars);
    assert.deepEqual(db.prepare(`SELECT id, status FROM reservations WHERE id <= ${before.at(-1).id} ORDER BY id`).all(), before, 'los datos de ejemplo quedan igual');
    const s = computeStats(db, prevMonth());
    assert.ok(s.totals.rentals >= 4, `alquileres el mes pasado: ${s.totals.rentals}`);
    assert.ok(s.cash.income > 0 && s.cash.expenses > 0 && s.cash.net > 0);
    // Cada alquiler del historial quedó devuelto y pagado.
    const owing = db
      .prepare(
        `SELECT COUNT(*) AS n FROM reservations r JOIN contracts c ON c.reservation_id = r.id WHERE r.id > ? AND r.status = 'finalizada'
         AND c.final_total > (SELECT COALESCE(SUM(CASE WHEN kind = 'pago' THEN amount WHEN kind = 'devolucion' THEN -amount ELSE 0 END), 0) FROM payments WHERE reservation_id = r.id) + 1`,
      )
      .get(before.at(-1).id).n;
    assert.equal(owing, 0);
  });
}
