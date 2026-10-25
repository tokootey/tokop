'use strict';

/*
 * Perfil de demo para mostrarle Floty a Discover Ushuaia Rent a Car.
 * Flota, sucursales, extras y datos de contacto: los de su página (discoverushuaia.com.ar, 24/10/2026).
 * Los PRECIOS son de ejemplo: la página no los publica. Se cambian en Precios y lugares.
 *
 *   node scripts/build-demo.js --perfil=discover   →  demo/discover-demo.html
 */
const { setSetting } = require('./db');
const { createReservation, checkout, addPayment } = require('./reservations');
const { fmtLocal } = require('./util');

const company = 'Discover Ushuaia Rent a Car';

function seed(db) {
  const ins = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);
  for (const [k, v] of Object.entries({
    company_name: company,
    company_address: '25 de Mayo 260, PB Of. 4, Ushuaia',
    company_phone: '+54 2901 425337',
    chat_whatsapp: '5492901646393',
    chat_enabled: '1',
  }))
    setSetting(db, k, v);

  const aep = ins(
    "INSERT INTO branches (code, name, address, aliases) VALUES ('USH', 'Aeropuerto Ushuaia', 'Aeropuerto Internacional Malvinas Argentinas', 'aeropuerto,airport,malvinas')",
  );
  const cen = ins("INSERT INTO branches (code, name, address, aliases) VALUES ('CEN', 'Oficina Centro', '25 de Mayo 260, PB Of. 4', 'oficina,centro')");

  // Sus 4 categorías, con km libres y seguro incluido (como dice la página). Precios de ejemplo, en pesos.
  const cats = {};
  for (const [code, name, daily, weekly, deposit, seats, tr, aliases] of [
    ['C', 'Low Cost Compact (Chevrolet Onix o similar)', 48000, 288000, 400000, 5, 'Manual', 'compact,onix,low cost'],
    ['F', 'Low Cost Confort (Chevrolet Prisma o similar)', 55000, 330000, 400000, 5, 'Manual', 'confort,prisma'],
    ['T', 'New Tech (Chevrolet Cruze Hatchback o similar)', 78000, 468000, 600000, 5, 'Manual o automática', 'tech,cruze hatchback,cruze 5 puertas'],
    ['S', 'New Tech Sedán (Chevrolet Cruze Sedán AT o similar)', 88000, 528000, 600000, 5, 'Automática', 'tech sedan,cruze sedan,sedan'],
  ]) {
    cats[code] = ins(
      'INSERT INTO categories (code, name, daily_rate, weekly_rate, deposit, km_per_day, extra_km_rate, seats, transmission, aliases) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)',
      code, name, daily, weekly, deposit, seats, tr, aliases,
    );
  }

  // Extras de su página (precios de ejemplo). El conductor adicional ya viene incluido en la tarifa.
  for (const [code, name, price, type, max] of [
    ['BEBE', 'Butaca para bebés', 6000, 'dia', 42000],
    ['NINO', 'Butaca para niños', 6000, 'dia', 42000],
    ['GPS', 'GPS', 5000, 'dia', 35000],
    ['SKI', 'Porta ski', 7000, 'dia', 49000],
    ['NOCHE', 'Retiro en aeropuerto fuera de horario (20 a 22 h)', 20000, 'fijo', 0],
  ])
    ins('INSERT INTO extras (code, name, price, charge_type, max_price) VALUES (?, ?, ?, ?, ?)', code, name, price, type, max);
  db.prepare("UPDATE extras SET price = 15000 WHERE code = 'HOTEL'").run();
  // Sus tres coberturas (nombres de su página; precios y franquicias de ejemplo).
  for (const [code, name, price, deductible] of [
    ['DISC', 'Cobertura Discover (con franquicia)', 0, 600000],
    ['PLUS', 'Discover Plus (franquicia reducida)', 9000, 250000],
    ['ADV', 'Discover Advance (sin franquicia)', 16000, 0],
  ])
    ins("INSERT INTO extras (code, name, price, charge_type, max_price, kind, deductible) VALUES (?, ?, ?, 'dia', 0, 'seguro', ?)", code, name, price, deductible);
  const extraId = (code) => db.prepare('SELECT id FROM extras WHERE code = ?').get(code).id;

  const y = new Date().getFullYear();
  ins('INSERT INTO seasons (name, start_date, end_date, multiplier) VALUES (?, ?, ?, ?)', 'Temporada alta verano (cruceros)', `${y}-12-15`, `${y + 1}-02-28`, 1.3);
  ins('INSERT INTO seasons (name, start_date, end_date, multiplier) VALUES (?, ?, ?, ?)', 'Temporada de nieve', `${y}-07-01`, `${y}-08-31`, 1.25);

  const fleet = [
    ['AF210KC', 'Chevrolet', 'Onix', 2023, 'Blanco', 'C', aep, 31200],
    ['AF388LD', 'Chevrolet', 'Onix', 2023, 'Gris', 'C', aep, 27800],
    ['AG104MB', 'Chevrolet', 'Onix', 2024, 'Rojo', 'C', cen, 12400],
    ['AG517NE', 'Chevrolet', 'Onix', 2024, 'Negro', 'C', cen, 9600],
    ['AE902PR', 'Chevrolet', 'Prisma', 2022, 'Plata', 'F', aep, 48300],
    ['AF615QS', 'Chevrolet', 'Prisma', 2023, 'Blanco', 'F', cen, 35100],
    ['AF733RT', 'Chevrolet', 'Prisma', 2023, 'Gris', 'F', aep, 29900],
    ['AG220SU', 'Chevrolet', 'Cruze 5 puertas', 2024, 'Azul', 'T', aep, 11800],
    ['AG341TV', 'Chevrolet', 'Cruze 5 puertas', 2024, 'Blanco', 'T', cen, 8700],
    ['AG458UW', 'Chevrolet', 'Cruze 5 puertas', 2025, 'Negro', 'T', aep, 3200],
    ['AG612VX', 'Chevrolet', 'Cruze Sedán AT', 2024, 'Gris', 'S', aep, 14500],
    ['AG775WY', 'Chevrolet', 'Cruze Sedán AT', 2025, 'Blanco', 'S', cen, 4100],
  ];
  const vids = {};
  for (const [plate, brand, model, year, color, cat, branch, km] of fleet) {
    vids[plate] = ins(
      'INSERT INTO vehicles (plate, brand, model, year, color, category_id, branch_id, km, fuel, insurance_expiry, vtv_expiry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 8, ?, ?)',
      plate, brand, model, year, color, cats[cat], branch, km, `${y + 1}-03-31`, `${y + 1}-06-30`,
    );
  }

  const cust = [
    ['Martina López', '33456789', 'martina.lopez@example.com', '+54 9 11 5555-1010', 'LIC-33456789'],
    ['Federico Álvarez', '29876543', 'fede.alvarez@example.com', '+54 9 11 5555-2020', 'LIC-29876543'],
    ['Sofía Romero', '37123456', 'sofia.romero@example.com', '+54 9 351 555-3030', 'LIC-37123456'],
    ['Diego Herrera', '31987654', 'diego.h@example.com', '+54 9 2901 55-4040', null],
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

  // Un auto en la calle, uno que sale hoy, uno al hotel y dos pedidos para confirmar.
  const r1 = createReservation(db, {
    customer_id: cust[0], category_id: cats.T, vehicle_id: vids.AG220SU, pickup_branch_id: aep, return_branch_id: aep,
    pickup_at: at(-2, 11), return_at: at(3, 11), status: 'confirmada', extras: [{ extra_id: extraId('GPS'), quantity: 1 }],
  });
  checkout(db, r1.id, { out_km: 11800, out_fuel: 8 });
  addPayment(db, r1.id, { amount: r1.total, method: 'tarjeta' });
  addPayment(db, r1.id, { amount: 600000, method: 'tarjeta', kind: 'garantia', reference: 'Preautorización' });

  createReservation(db, {
    customer_id: cust[1], category_id: cats.C, vehicle_id: vids.AF210KC, pickup_branch_id: aep, return_branch_id: cen,
    pickup_at: at(0, 15), return_at: at(5, 15), status: 'confirmada',
  });
  createReservation(db, {
    customer_id: cust[2], category_id: cats.S, vehicle_id: vids.AG612VX, pickup_branch_id: cen, return_branch_id: cen,
    pickup_at: at(1, 10), return_at: at(4, 10), status: 'confirmada', extras: [{ extra_id: extraId('SKI'), quantity: 1 }],
    hotel: { deliver: true, return: true, name: 'Hotel Arakur', address: 'Cerro Alarken s/n', room: '312', notes: 'Dejarlo en recepción a las 10' },
  });
  createReservation(db, {
    customer_id: cust[3], category_id: cats.F, pickup_branch_id: aep, return_branch_id: aep,
    pickup_at: at(3, 12), return_at: at(7, 12), status: 'pendiente', notes: 'Pidió por WhatsApp. Falta la licencia.',
  });
  createReservation(db, {
    customer_id: cust[0], category_id: cats.C, pickup_branch_id: cen, return_branch_id: cen,
    pickup_at: at(6, 9), return_at: at(9, 9), status: 'pendiente', extras: [{ extra_id: extraId('BEBE'), quantity: 1 }],
  });

  ins("INSERT INTO maintenance (vehicle_id, kind, description, start_date, km, cost, status) VALUES (?, 'service', 'Service 50.000 km', date('now'), 48300, 220000, 'abierto')", vids.AE902PR);
  db.prepare("UPDATE vehicles SET status = 'mantenimiento' WHERE id = ?").run(vids.AE902PR);
}

module.exports = { id: 'discover', company, seed };
