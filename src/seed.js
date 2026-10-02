'use strict';

/**
 * Carga datos de ejemplo (sucursales, categorías, flota, adicionales, clientes y reservas)
 * para probar el sistema. Uso: npm run seed  (no hace nada si ya hay categorías cargadas).
 */
const { openDb } = require('./db');
const { ensureAdmin } = require('./app');
const { createReservation, checkout, addPayment } = require('./reservations');
const { fmtLocal } = require('./util');

function seed(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n > 0) return false;

  const ins = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);

  const aep = ins(
    "INSERT INTO branches (code, name, address, aliases) VALUES ('USH', 'Aeropuerto Ushuaia', 'Aeropuerto Internacional Malvinas Argentinas', 'aeropuerto,airport,aeropuerto internacional')",
  );
  const cen = ins(
    "INSERT INTO branches (code, name, address, aliases) VALUES ('CEN', 'Oficina Centro', '25 de Mayo 260, Piso 2, Of. 9, Ushuaia', 'oficina,centro,ushuaia centro')",
  );
  ins("INSERT INTO branches (code, name, address, aliases) VALUES ('HTL', 'Entrega en hotel', 'Hoteles de Ushuaia', 'hotel,a domicilio')");

  const cats = {};
  for (const [code, name, daily, weekly, deposit, km, kmRate, seats, tr, aliases] of [
    ['A', 'Económico (Fiat Mobi o similar)', 35000, 210000, 300000, 300, 250, 4, 'Manual', 'economico,chico,auto chico'],
    ['B', 'Compacto (Chevrolet Onix o similar)', 42000, 252000, 350000, 300, 300, 5, 'Manual', 'compacto,mediano'],
    ['C', 'Sedán (Toyota Corolla o similar)', 58000, 350000, 450000, 0, 0, 5, 'Automática', 'sedan,automatico'],
    ['D', 'SUV (Jeep Renegade o similar)', 75000, 450000, 600000, 0, 0, 5, 'Automática', 'suv,camioneta'],
    ['P', 'Pick-up 4x4 (Toyota Hilux o similar)', 90000, 540000, 700000, 0, 0, 5, 'Manual', 'pick-up,pickup,4x4,hilux'],
  ]) {
    cats[code] = ins(
      'INSERT INTO categories (code, name, daily_rate, weekly_rate, deposit, km_per_day, extra_km_rate, seats, transmission, aliases) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      code, name, daily, weekly, deposit, km, kmRate, seats, tr, aliases,
    );
  }

  for (const [code, name, price, type, max] of [
    ['GPS', 'GPS', 5000, 'dia', 35000],
    ['SILLA', 'Silla para bebé', 6000, 'dia', 40000],
    ['COND', 'Conductor adicional', 8000, 'dia', 60000],
    ['FULL', 'Seguro sin franquicia', 15000, 'dia', 0],
    ['CAD', 'Cadenas para nieve', 7000, 'dia', 42000],
    ['LIMP', 'Lavado / limpieza especial', 12000, 'fijo', 0],
  ]) ins('INSERT INTO extras (code, name, price, charge_type, max_price) VALUES (?, ?, ?, ?, ?)', code, name, price, type, max);

  const y = new Date().getFullYear();
  ins('INSERT INTO seasons (name, start_date, end_date, multiplier) VALUES (?, ?, ?, ?)', 'Temporada alta verano (cruceros)', `${y}-12-15`, `${y + 1}-02-28`, 1.3);
  ins('INSERT INTO seasons (name, start_date, end_date, multiplier) VALUES (?, ?, ?, ?)', 'Temporada de nieve', `${y}-07-01`, `${y}-08-31`, 1.25);

  const fleet = [
    ['AF123BC', 'Fiat', 'Mobi', 2023, 'Blanco', 'A', aep, 15200],
    ['AF456DE', 'Fiat', 'Mobi', 2023, 'Gris', 'A', cen, 22100],
    ['AG789FG', 'Renault', 'Kwid', 2024, 'Rojo', 'A', aep, 8300],
    ['AE321HI', 'Chevrolet', 'Onix', 2022, 'Negro', 'B', aep, 41000],
    ['AF654JK', 'Chevrolet', 'Onix', 2023, 'Blanco', 'B', cen, 30500],
    ['AG987LM', 'Volkswagen', 'Polo', 2024, 'Azul', 'B', aep, 9900],
    ['AF111NO', 'Toyota', 'Corolla', 2023, 'Gris', 'C', aep, 27000],
    ['AG222PQ', 'Toyota', 'Corolla', 2024, 'Blanco', 'C', cen, 12000],
    ['AF333RS', 'Jeep', 'Renegade', 2023, 'Rojo', 'D', aep, 35500],
    ['AG444TU', 'Volkswagen', 'Taos', 2024, 'Negro', 'D', aep, 7600],
    ['AE555VW', 'Toyota', 'Hilux', 2022, 'Blanco', 'P', cen, 61000],
  ];
  const vids = {};
  for (const [plate, brand, model, year, color, cat, branch, km] of fleet) {
    vids[plate] = ins(
      'INSERT INTO vehicles (plate, brand, model, year, color, category_id, branch_id, km, fuel, insurance_expiry, vtv_expiry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 8, ?, ?)',
      plate, brand, model, year, color, cats[cat], branch, km, `${y + 1}-03-31`, `${y + 1}-06-30`,
    );
  }

  const cust = [
    ['María González', '30111222', 'maria.gonzalez@example.com', '+54 9 11 5555-1111', 'LIC-30111222'],
    ['Juan Pérez', '28999888', 'juan.perez@example.com', '+54 9 11 5555-2222', 'LIC-28999888'],
    ['Lucía Fernández', '35444333', 'lucia.f@example.com', '+54 9 2901 55-3333', 'LIC-35444333'],
    ['Carlos Rodríguez', '25777666', 'carlos.r@example.com', '+54 9 2901 55-4444', null],
  ].map(([n, doc, email, phone, lic]) =>
    ins(
      'INSERT INTO customers (full_name, doc_type, doc_number, email, phone, license_number, license_expiry) VALUES (?, ?, ?, ?, ?, ?, ?)',
      n, 'DNI', doc, email, phone, lic, lic ? `${y + 3}-01-01` : null,
    ),
  );

  const at = (days, hour) => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return fmtLocal(d);
  };

  const r1 = createReservation(db, {
    customer_id: cust[0], category_id: cats.B, vehicle_id: vids.AE321HI, pickup_branch_id: aep, return_branch_id: aep,
    pickup_at: at(-2, 10), return_at: at(3, 10), status: 'confirmada', extras: [{ extra_id: 1, quantity: 1 }],
  });
  checkout(db, r1.id, { out_km: 41000, out_fuel: 8 });
  addPayment(db, r1.id, { amount: r1.total, method: 'tarjeta' });
  addPayment(db, r1.id, { amount: 350000, method: 'tarjeta', kind: 'garantia', reference: 'Preautorización' });

  createReservation(db, {
    customer_id: cust[1], category_id: cats.C, vehicle_id: vids.AF111NO, pickup_branch_id: aep, return_branch_id: cen,
    pickup_at: at(0, 15), return_at: at(5, 15), status: 'confirmada',
  });
  createReservation(db, {
    customer_id: cust[2], category_id: cats.D, pickup_branch_id: cen, return_branch_id: cen,
    pickup_at: at(2, 9), return_at: at(9, 9), status: 'pendiente', extras: [{ extra_id: 2, quantity: 1 }, { extra_id: 4, quantity: 1 }],
  });
  createReservation(db, {
    customer_id: cust[3], category_id: cats.A, pickup_branch_id: aep, return_branch_id: aep,
    pickup_at: at(4, 12), return_at: at(6, 12), status: 'pendiente', notes: 'Falta licencia del cliente',
  });

  ins("INSERT INTO maintenance (vehicle_id, kind, description, start_date, km, cost, status) VALUES (?, 'service', 'Service 60.000 km', date('now'), 61000, 180000, 'abierto')", vids.AE555VW);
  db.prepare("UPDATE vehicles SET status = 'mantenimiento' WHERE id = ?").run(vids.AE555VW);
  return true;
}

if (require.main === module) {
  const db = openDb();
  const admin = ensureAdmin(db);
  console.log(seed(db) ? 'Datos de ejemplo cargados.' : 'Ya había datos: no se cargó nada.');
  if (admin) console.log(`Usuario inicial: ${admin.email} / ${admin.password}`);
}

module.exports = { seed };
