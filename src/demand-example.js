'use strict';

const { getSetting, setSetting, COUNTRY_PRESETS } = require('./db');
const { computeQuote } = require('./pricing');
const { createReservation } = require('./reservations');
const { fail, fmtLocal } = require('./util');

/**
 * Caso de ejemplo para presentar los precios según disponibilidad: una agencia de Panamá con autos y reservas
 * ficticios, donde el mismo SUV sale a precio normal, +10 % o +20 % según las fechas.
 * Sólo se carga en una agencia vacía: nunca mezcla datos ficticios con los de un cliente.
 */
const KEY = 'demand_example';
const RULES = '50:10, 75:20';
const TRIP_DAYS = 3;
// [días desde hoy, etiqueta, cuántos SUV reservados de 4, cuántos compactos reservados de 4]
const SCENARIOS = [
  [21, 'Fechas tranquilas', 0, 0],
  [14, 'Se está llenando', 2, 1],
  [7, 'Casi sin autos', 3, 2],
];

function load(db) {
  const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  if (n('vehicles') || n('reservations') || n('customers')) fail(409, 'Esta agencia ya tiene datos: el ejemplo solo se carga en una agencia vacía');
  if (getSetting(db, 'business_mode') === 'choferes') fail(409, 'El ejemplo es para una agencia de alquiler turístico');
  const ins = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);
  const preset = COUNTRY_PRESETS.PA;
  const y = new Date().getFullYear();
  const at = (days) => {
    const d = new Date();
    d.setHours(10, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return fmtLocal(d);
  };

  setSetting(db, 'country', 'PA');
    for (const k of ['currency', 'locale', 'tax_name', 'tax_rate', 'tax_id_label']) setSetting(db, k, preset[k]);
    setSetting(db, 'pro_features', '1');
    setSetting(db, 'turnaround_minutes', '120');
    setSetting(db, 'dynamic_pricing_rules', RULES);
    setSetting(db, 'chat_enabled', '1');

    const airport = ins("INSERT INTO branches (code, name, address) VALUES ('PTY', 'Aeropuerto de Tocumen', 'Aeropuerto Internacional de Tocumen')");
    ins("INSERT INTO branches (code, name, address) VALUES ('PAC', 'Oficina Ciudad de Panamá', 'Ciudad de Panamá')");
    const category = (code, name, rate, deposit, seats, transmission) =>
      ins('INSERT INTO categories (code, name, daily_rate, weekly_rate, deposit, km_per_day, extra_km_rate, seats, transmission) VALUES (?, ?, ?, 0, ?, 0, 0, ?, ?)', code, name, rate, deposit, seats, transmission);
    const compact = category('EJC', 'Compacto', 35, 300, 5, 'Automático');
    const suv = category('EJS', 'SUV', 65, 500, 5, 'Automático');
    const pickup = category('EJP', 'Pickup 4x4', 85, 700, 5, 'Automático');
    const extra = (code, name, price, kind = 'adicional') =>
      db.prepare("INSERT OR IGNORE INTO extras (code, name, price, charge_type, max_price, kind) VALUES (?, ?, ?, 'dia', 0, ?)").run(code, name, price, kind);
    extra('EJG', 'GPS', 5);
    extra('EJB', 'Silla para bebé', 4);
    extra('EJT', 'Seguro total', 15, 'seguro');

    const cars = (prefix, brand, model, categoryId, count) =>
      Array.from({ length: count }, (_, i) =>
        ins(
          'INSERT INTO vehicles (plate, brand, model, year, color, category_id, branch_id, km, fuel, insurance_expiry, vtv_expiry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 8, ?, ?)',
          `${prefix}${100 + i}`, brand, model, y - 1, 'Blanco', categoryId, airport, 12000 + i * 900, `${y + 1}-03-31`, `${y + 1}-06-30`,
        ),
      );
    const suvs = cars('EJS', 'Toyota', 'RAV4', suv, 4);
    const compacts = cars('EJC', 'Hyundai', 'Accent', compact, 4);
    cars('EJP', 'Toyota', 'Hilux', pickup, 2);

    const customer = ins("INSERT INTO customers (full_name, doc_type, doc_number, phone, license_number, license_expiry) VALUES ('Cliente de ejemplo', 'Pasaporte', 'EJEMPLO', '+507 6000 0000', 'EJEMPLO', ?)", `${y + 3}-01-01`);
    const book = (categoryId, vehicleId, from) =>
      createReservation(db, { customer_id: customer, category_id: categoryId, vehicle_id: vehicleId, pickup_branch_id: airport, return_branch_id: airport, pickup_at: at(from), return_at: at(from + TRIP_DAYS), status: 'confirmada', notes: 'Reserva de ejemplo' });
    for (const [from, , suvBooked, compactBooked] of SCENARIOS) {
      suvs.slice(0, suvBooked).forEach((id) => book(suv, id, from));
      compacts.slice(0, compactBooked).forEach((id) => book(compact, id, from));
    }
    const saved = { suv, scenarios: SCENARIOS.map(([from, label, booked]) => ({ label, booked, pickup_at: at(from), return_at: at(from + TRIP_DAYS) })) };
    setSetting(db, KEY, JSON.stringify(saved));
    return saved;
}

/** Carga el ejemplo la primera vez y devuelve el precio del SUV en cada caso, calculado como lo calcula el cotizador. */
function demandExample(db) {
  const raw = getSetting(db, KEY);
  const saved = raw ? JSON.parse(raw) : load(db);
  return saved.scenarios.map((s) => {
    const q = computeQuote(db, { category_id: saved.suv, pickup_at: s.pickup_at, return_at: s.return_at });
    return { label: s.label, category: q.category.name, booked: s.booked, fleet: 4, pickup_at: s.pickup_at, return_at: s.return_at, days: q.days, pct: q.dynamic_pct, total: q.total, currency: q.currency };
  });
}

module.exports = { demandExample };
