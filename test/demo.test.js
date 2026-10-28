'use strict';

/* Modo demo (DEMO_DATA=1): datos de muestra con un mes de movimiento y un usuario de prueba. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { ensureAdmin } = require('../src/app');
const { seedDemo } = require('../src/seed');
const { verifyPassword } = require('../src/auth');
const { computeStats } = require('../src/routes/stats');

test('demo: carga reservas pasadas, en curso y por venir, y el usuario de prueba', () => {
  const db = openDb(':memory:');
  ensureAdmin(db);
  assert.equal(seedDemo(db, { email: 'Demo@Floty.test', password: 'Muestra2026x' }), true);
  const by = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM reservations GROUP BY status').all().map((r) => [r.status, r.n]));
  assert.ok(by.finalizada >= 9 && by.en_curso >= 2 && by.confirmada >= 5 && by.pendiente >= 2, JSON.stringify(by));
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get('demo@floty.test');
  assert.ok(u && u.role === 'admin' && !u.must_change_password && verifyPassword('Muestra2026x', u.password_hash));
  const t = new Date();
  const ymd = (d) => d.toISOString().slice(0, 10);
  const s = computeStats(db, { from: ymd(new Date(t.getTime() - 30 * 86400000)), to: ymd(new Date(t.getTime() + 15 * 86400000)) });
  assert.ok(s.totals.collected > 0 && s.totals.net > 0);
  // Un reinicio sobre la misma base no duplica nada.
  assert.equal(seedDemo(db, { email: 'demo@floty.test', password: 'Muestra2026x' }), false);
});
