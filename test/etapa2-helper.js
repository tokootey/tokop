'use strict';

/* Base vacía con dos sucursales, una categoría y autos propios, para las pruebas de la segunda etapa de Ancon. */
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { fmtLocal } = require('../src/util');
const { hashPassword } = require('../src/auth');
const R = require('../src/reservations');

const at = (days, hour = 10) => {
  const d = new Date();
  return fmtLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, hour, 0));
};

async function start() {
  const db = openDb(':memory:');
  ensureAdmin(db);
  db.exec(`INSERT INTO branches (id, code, name) VALUES (1, 'TOC', 'Tocumen'), (2, 'CEN', 'Centro');
    INSERT INTO categories (id, code, name, daily_rate, km_per_day, extra_km_rate) VALUES (1, 'ECO', 'Económico', 50, 100, 2), (2, 'SUV', 'Camioneta', 90, 100, 2);
    INSERT INTO vehicles (id, plate, brand, model, category_id, branch_id, km, fuel) VALUES
      (1, 'AA0001', 'Kia', 'Picanto', 1, 1, 1000, 8), (2, 'AA0002', 'Kia', 'Rio', 1, 2, 2000, 8), (3, 'AA0003', 'Kia', 'Sportage', 2, 1, 3000, 8);`);
  const server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  /** Un usuario con su sesión: `as('admin')`, `as('operador')`… devuelve su `call`. */
  const sessions = {};
  const as = async (role) => {
    if (sessions[role]) return sessions[role];
    const email = `${role}@prueba.local`;
    db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(role, email, hashPassword('Clave2026Segura'), role);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Clave2026Segura' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    sessions[role] = async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let data = text;
      try {
        data = JSON.parse(text);
      } catch {
        // CSV u otro texto: queda como vino.
      }
      return { status: res.status, data };
    };
    return sessions[role];
  };

  let n = 0;
  /** Reserva confirmada con la ficha del cliente completa (sin ella no se entrega). */
  const reserve = (over = {}) => {
    n += 1;
    const c = db
      .prepare(
        `INSERT INTO customers (full_name, doc_type, doc_number, phone, email, address, birth_date, license_number, license_expiry)
         VALUES (?, 'Cédula', ?, '+507 6000 0000', ?, 'Calle 50', '1990-01-01', ?, '2035-01-01')`,
      )
      .run(over.name || `Cliente ${n}`, `8-${n}`, `c${n}@prueba.local`, `L${n}`);
    return R.createReservation(
      db,
      { customer_id: Number(c.lastInsertRowid), category_id: 1, vehicle_id: 1, pickup_branch_id: 1, return_branch_id: 1, pickup_at: at(0, 8), return_at: at(3, 8), status: 'confirmada', ...over },
      1,
    );
  };
  /** Un auto entregado: alquiler en curso. */
  const rent = (over = {}) => R.checkout(db, reserve(over).id, { out_at: over.out_at || at(0, 9) }, 1);

  return {
    db,
    as,
    reserve,
    rent,
    close: () => {
      server.closeAllConnections();
      server.close();
      db.close();
    },
  };
}

module.exports = { start, at };
