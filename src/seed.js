'use strict';

/**
 * Carga datos de ejemplo (sucursales, categorías, flota, adicionales, clientes y reservas)
 * para probar el sistema. Uso: npm run seed  (no hace nada si ya hay categorías cargadas).
 */
const { openDb, setSetting } = require('./db');
const { ensureAdmin } = require('./app');
const { createReservation, checkout, checkin, addPayment, getReservation } = require('./reservations');
const { hashPassword } = require('./auth');
const { fmtLocal } = require('./util');
const choferes = require('./choferes');

function seed(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n > 0) return false;

  const ins = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);

  const aep = ins(
    "INSERT INTO branches (code, name, address, aliases) VALUES ('USH', 'Aeropuerto Ushuaia', 'Aeropuerto Internacional Malvinas Argentinas', 'aeropuerto,airport,aeropuerto internacional')",
  );
  const cen = ins(
    "INSERT INTO branches (code, name, address, aliases) VALUES ('CEN', 'Oficina Centro', 'Av. Principal 100, Ushuaia', 'oficina,centro,ushuaia centro')",
  );
  // En los datos de ejemplo el asistente de la web queda activado para poder probarlo.
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'chat_enabled'").run();

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
  // "Entrega en hotel" ya lo crea la base (en 0); en los datos de ejemplo cuesta 15.000.
  db.prepare("UPDATE extras SET price = 15000 WHERE code = 'HOTEL'").run();
  // Seguros de ejemplo: la cobertura básica viene incluida (con franquicia); la total la elimina.
  ins("INSERT INTO extras (code, name, price, charge_type, max_price, kind, deductible) VALUES ('BASICO', 'Cobertura básica (incluida)', 0, 'fijo', 0, 'seguro', 800000)");
  db.prepare("UPDATE extras SET kind = 'seguro', deductible = 0, name = 'Cobertura total (sin franquicia)' WHERE code = 'FULL'").run();
  ins("INSERT INTO extras (code, name, price, charge_type, max_price, kind, deductible) VALUES ('MEDIO', 'Cobertura media (franquicia reducida)', 8000, 'dia', 0, 'seguro', 300000)");
  const extraId = (code) => db.prepare('SELECT id FROM extras WHERE code = ?').get(code).id;

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
    pickup_at: at(-2, 10), return_at: at(3, 10), status: 'confirmada', extras: [{ extra_id: extraId('GPS'), quantity: 1 }],
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
    pickup_at: at(2, 9), return_at: at(9, 9), status: 'pendiente', extras: [{ extra_id: extraId('SILLA'), quantity: 1 }, { extra_id: extraId('FULL'), quantity: 1 }],
  });
  createReservation(db, {
    customer_id: cust[3], category_id: cats.A, pickup_branch_id: aep, return_branch_id: aep,
    pickup_at: at(4, 12), return_at: at(6, 12), status: 'pendiente', notes: 'Falta licencia del cliente',
  });

  ins("INSERT INTO maintenance (vehicle_id, kind, description, start_date, km, cost, status) VALUES (?, 'service', 'Service 60.000 km', date('now'), 61000, 180000, 'abierto')", vids.AE555VW);
  db.prepare("UPDATE vehicles SET status = 'mantenimiento' WHERE id = ?").run(vids.AE555VW);
  return true;
}

/**
 * Demo para mostrar a clientes (DEMO_DATA=1): los datos de ejemplo más un mes de movimiento
 * (alquileres terminados y cobrados, autos en la calle y reservas por venir) y un usuario de prueba
 * DEMO_EMAIL / DEMO_PASSWORD. Sólo carga la primera vez, sobre una base sin datos.
 */
function seedDemo(db, { email, password } = {}) {
  if (email && password && !db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase())) {
    db.prepare("INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES ('Demo', ?, ?, 'admin', 0)").run(email.toLowerCase(), hashPassword(password));
  }
  if (!seed(db)) return false;

  const id = (sql, v) => db.prepare(sql).get(v).id;
  const car = (plate) => db.prepare('SELECT id, category_id, km FROM vehicles WHERE plate = ?').get(plate);
  const branch = (code) => id('SELECT id FROM branches WHERE code = ?', code);
  const extra = (code) => ({ extra_id: id('SELECT id FROM extras WHERE code = ?', code), quantity: 1 });
  const y = new Date().getFullYear();
  const people = [
    ['Sofía Martínez', '+54 9 11 6123-4567'], ['Diego López', '+54 9 351 612-3456'], ['Valentina Gómez', '+54 9 261 555-1290'],
    ['Martín Díaz', '+54 9 11 4789-3321'], ['Camila Romero', '+54 9 2901 44-7788'], ['Thiago Sánchez', '+54 9 341 677-2210'],
    ['Florencia Torres', '+54 9 11 3344-5566'], ['Joaquín Álvarez', '+54 9 223 512-8899'], ['Emma Ruiz', '+1 305 555 0142'],
    ['Lucas Benítez', '+54 9 381 455-6677'], ['Paula Castro', '+56 9 8765 4321'], ['Mateo Herrera', '+54 9 11 2233-4455'],
  ].map(([name, phone], i) =>
    Number(db.prepare("INSERT INTO customers (full_name, doc_type, doc_number, phone, license_number, license_expiry) VALUES (?, 'DNI', ?, ?, ?, ?)")
      .run(name, String(31000000 + i * 734211), phone, `LIC-${i + 100}`, `${y + 3}-06-30`).lastInsertRowid),
  );
  const at = (days, hour = 10) => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return fmtLocal(d);
  };
  let p = 0;
  const book = (plate, from, to, status, opts = {}) => {
    const v = car(plate);
    const pickup = branch(opts.at || 'USH');
    return createReservation(db, {
      customer_id: people[p++ % people.length], category_id: v.category_id, vehicle_id: v.id, pickup_branch_id: pickup, return_branch_id: pickup,
      pickup_at: at(from, opts.hour), return_at: at(to, opts.hour), status, extras: opts.extras || [], source: opts.source || 'manual',
    });
  };
  // Terminados y cobrados (en orden, para que los km de cada auto vayan subiendo).
  for (const [plate, from, to, opts] of [
    ['AG444TU', -26, -21, { extras: [extra('FULL')] }], ['AF123BC', -25, -20, {}], ['AF654JK', -22, -15, { at: 'CEN', extras: [extra('GPS')] }],
    ['AG222PQ', -20, -16, { at: 'CEN' }], ['AG789FG', -18, -14, { extras: [extra('SILLA')] }], ['AF333RS', -15, -9, { extras: [extra('MEDIO'), extra('CAD')] }],
    ['AG987LM', -12, -8, {}], ['AF456DE', -10, -6, { at: 'CEN' }], ['AF111NO', -9, -3, { extras: [extra('FULL')] }],
  ]) {
    const r = book(plate, from, to, 'confirmada', opts);
    const km = car(plate).km;
    checkout(db, r.id, { out_km: km, out_fuel: 8, out_at: at(from, opts.hour) });
    checkin(db, r.id, { in_km: km + 180 * (to - from), in_fuel: 8, in_at: at(to, opts.hour) });
    addPayment(db, r.id, { amount: r.total, method: p % 3 ? 'tarjeta' : 'transferencia' });
  }
  // En la calle ahora.
  const now = book('AG789FG', -1, 2, 'confirmada');
  checkout(db, now.id, { out_km: car('AG789FG').km, out_fuel: 8, out_at: at(-1) });
  addPayment(db, now.id, { amount: Math.round(now.total / 2), method: 'efectivo' });
  // Por venir: confirmadas, con seña, y pedidos de la web para confirmar.
  for (const [plate, from, to, status, opts] of [
    ['AG444TU', 0, 7, 'confirmada', { hour: 12, extras: [extra('FULL')] }], ['AF123BC', 1, 4, 'confirmada', {}],
    ['AG222PQ', 2, 6, 'confirmada', { at: 'CEN', extras: [extra('GPS')] }], ['AG987LM', 3, 8, 'confirmada', {}],
    ['AF654JK', 6, 10, 'pendiente', { at: 'CEN', source: 'web' }], ['AF456DE', 8, 11, 'pendiente', { source: 'web' }],
    ['AF333RS', 10, 13, 'confirmada', { extras: [extra('MEDIO')] }],
  ]) {
    const r = book(plate, from, to, status, opts);
    if (status === 'confirmada') addPayment(db, r.id, { amount: Math.round(r.total * 0.3), method: 'transferencia', reference: 'Seña' });
  }
  return true;
}

/**
 * Demo de autos para trabajo (modo choferes): una flota chica alquilada por semana a choferes de apps,
 * con pagos al día y atrasados, una multa, km de más, una licencia vencida, un auto en el taller y gastos.
 */
function seedChoferes(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n > 0) return false;
  for (const [k, v] of Object.entries({
    company_name: 'Demo Flota para Choferes',
    company_address: 'Av. Corrientes 5200, CABA',
    business_mode: 'choferes',
    rent_period: 'semana',
    late_fee_per_day: '5000',
    late_grace_days: '1',
    deductible_amount: '500000',
    jurisdiction: 'la Ciudad Autónoma de Buenos Aires',
  }))
    setSetting(db, k, v);
  const ins = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);
  const base = ins("INSERT INTO branches (code, name, address) VALUES ('BASE', 'Base Villa Crespo', 'Av. Corrientes 5200, CABA')");
  const category = (code, name, daily, weekly, monthly, deposit, km, extraKm) =>
    ins(
      "INSERT INTO categories (code, name, daily_rate, weekly_rate, monthly_rate, deposit, km_per_period, extra_km_rate, seats, transmission) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 5, 'Manual')",
      code, name, daily, weekly, monthly, deposit, km, extraKm,
    );
  const cat = {
    APP: category('APP', 'Sedán para apps (Etios, Prisma o similar)', 32000, 190000, 690000, 300000, 1800, 110),
    GNC: category('GNC', 'Sedán con GNC (Cronos, Logan o similar)', 38000, 230000, 820000, 350000, 2200, 90),
  };
  const y = new Date().getFullYear();
  const car = {};
  for (const [plate, brand, model, year, c, km] of [
    ['AB101CD', 'Toyota', 'Etios', 2021, 'APP', 112400], ['AC202EF', 'Chevrolet', 'Prisma', 2020, 'APP', 138900],
    ['AD303GH', 'Fiat', 'Cronos GNC', 2022, 'GNC', 96300], ['AE404IJ', 'Renault', 'Logan GNC', 2021, 'GNC', 121700],
    ['AF505KL', 'Toyota', 'Etios', 2019, 'APP', 159800], ['AG606MN', 'Chevrolet', 'Prisma', 2021, 'APP', 109200],
  ])
    car[plate] = ins(
      'INSERT INTO vehicles (plate, brand, model, year, category_id, branch_id, km, service_every_km, insurance_expiry, vtv_expiry) VALUES (?, ?, ?, ?, ?, ?, ?, 10000, ?, ?)',
      plate, brand, model, year, cat[c], base, km, `${y + 1}-03-31`, `${y + 1}-06-30`,
    );
  const who = {};
  for (const [name, doc, phone, apps, guarantor, gDoc, gPhone] of [
    ['Juan Pérez', '33456789', '+54 9 11 6123-4567', 'Uber, DiDi', 'Rosa Pérez', '14567890', '+54 9 11 4455-6677'],
    ['Carla Gómez', '35987654', '+54 9 11 5234-8890', 'Cabify', 'Héctor Gómez', '12345678', '+54 9 11 4321-0099'],
    ['Ramiro Díaz', '31222333', '+54 9 11 3876-1122', 'Uber, remis', null, null, null],
    ['Lucía Fernández', '37111222', '+54 9 11 6789-3344', 'PedidosYa, DiDi', 'Marta Ríos', '16222333', '+54 9 11 4777-8899'],
    ['Marcos Ruiz', '30555666', '+54 9 11 5566-7788', 'Uber', null, null, null],
  ])
    who[name] = ins(
      "INSERT INTO customers (full_name, doc_type, doc_number, phone, license_number, license_expiry, license_class, work_apps, guarantor_name, guarantor_doc, guarantor_phone) VALUES (?, 'DNI', ?, ?, ?, ?, 'D1 (profesional)', ?, ?, ?, ?)",
      name, doc, phone, `LP-${doc.slice(-5)}`, `${y + 2}-08-31`, apps, guarantor, gDoc, gPhone,
    );
  const day = (n) => {
    const d = new Date();
    d.setHours(9, 0, 0, 0);
    d.setDate(d.getDate() + n);
    return d;
  };
  const at = (n) => fmtLocal(day(n));
  // Cada pago con su fecha (se guardan en UTC, como los del servidor): así el recargo por atraso sale como en la realidad.
  const pay = (rid, amount, n, method = 'transferencia', kind = 'pago') => {
    addPayment(db, rid, { amount, method, kind });
    db.prepare('UPDATE payments SET created_at = ? WHERE id = (SELECT MAX(id) FROM payments)').run(day(n).toISOString().slice(0, 19).replace('T', ' '));
  };
  const rent = (plate, name, from) => {
    const v = db.prepare('SELECT category_id, km FROM vehicles WHERE id = ?').get(car[plate]);
    const r = createReservation(db, { customer_id: who[name], category_id: v.category_id, vehicle_id: car[plate], pickup_branch_id: base, pickup_at: at(from), return_at: at(from + 7), status: 'confirmada' });
    checkout(db, r.id, { out_at: at(from), out_km: v.km, out_fuel: 8 }, null);
    return r.id;
  };
  // Terminado: Marcos lo tuvo 5 semanas y lo devolvió hace 5 días con km de más (ya pagó todo y se le devolvió la garantía).
  const done = rent('AG606MN', 'Marcos Ruiz', -40);
  pay(done, 300000, -40, 'efectivo', 'garantia');
  for (let w = 0; w < 5; w++) pay(done, 190000, -40 + 7 * w);
  checkin(db, done, { in_at: at(-5), in_km: 119600, in_fuel: 8 }, null);
  pay(done, getReservation(db, done).balance.pending, -5, 'efectivo');
  pay(done, 300000, -5, 'efectivo', 'devolucion_garantia');
  // En la calle: Juan al día; Carla debe la semana que empezó hace 2 días; Ramiro pagó una semana tarde,
  // debe la última, una multa y km de más; Lucía está al día pero se le venció la licencia.
  const juan = rent('AB101CD', 'Juan Pérez', -23);
  for (let w = 0; w < 4; w++) pay(juan, 190000, -23 + 7 * w);
  const carla = rent('AC202EF', 'Carla Gómez', -16);
  pay(carla, 190000, -16);
  pay(carla, 190000, -9, 'efectivo');
  const ramiro = rent('AD303GH', 'Ramiro Díaz', -30);
  for (const n of [-30, -23, -16, -6]) pay(ramiro, 230000, n);
  const lucia = rent('AE404IJ', 'Lucía Fernández', -9);
  pay(lucia, 230000, -9);
  pay(lucia, 230000, -2, 'mercadopago');
  for (const id of [juan, carla, ramiro, lucia]) choferes.renew(db, id);
  choferes.addCharge(db, { id: ramiro }, { kind: 'multa', amount: 48000, reference: 'Fotomulta 112233', description: 'Exceso de velocidad', date: at(-12) }, null);
  choferes.kmReading(db, getReservation(db, ramiro), 96300 + 5 * 2200 + 400, null);
  db.prepare('UPDATE customers SET license_expiry = ? WHERE id = ?').run(at(-3).slice(0, 10), who['Lucía Fernández']);
  // Un auto en el taller y los gastos de las últimas semanas.
  ins("INSERT INTO maintenance (vehicle_id, kind, description, start_date, km, cost, status) VALUES (?, 'service', 'Service 160.000 km', ?, 159800, 210000, 'abierto')", car.AF505KL, at(-1).slice(0, 10));
  db.prepare("UPDATE vehicles SET status = 'mantenimiento' WHERE id = ?").run(car.AF505KL);
  for (const [plate, n, kind, description, amount] of [
    ['AB101CD', -20, 'repuestos', 'Pastillas de freno', 68000], ['AD303GH', -14, 'taller', 'Revisión del equipo de GNC', 95000],
    ['AC202EF', -10, 'lavado', 'Lavado completo', 18000], [null, -8, 'seguro', 'Cuota del seguro de la flota', 420000],
    ['AE404IJ', -4, 'repuestos', 'Cubierta nueva', 125000], ['AG606MN', -3, 'combustible', 'Carga de GNC', 9000],
  ])
    ins('INSERT INTO expenses (vehicle_id, date, kind, description, amount) VALUES (?, ?, ?, ?, ?)', plate ? car[plate] : null, at(n).slice(0, 10), kind, description, amount);
  return true;
}

/**
 * Demo: un año de movimiento anterior a los datos de ejemplo (alquileres terminados y cobrados, cancelaciones,
 * taller y gastos), para que Estadísticas se vea como en una agencia que ya trabaja. Siempre sale igual
 * (números al azar con semilla fija). Va después de seed() o seedChoferes(): termina antes del primer
 * alquiler de cada auto y le deja a cada auto su km y su estado.
 */
function seedHistory(db, { months = 12 } = {}) {
  let s = 20240611;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pickOne = (list) => list[Math.floor(rnd() * list.length)];
  const work = (db.prepare("SELECT value FROM settings WHERE key = 'business_mode'").get() || {}).value === 'choferes';
  const ins = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);
  const y = new Date().getFullYear();
  const today = new Date();
  today.setHours(10, 0, 0, 0);
  const start = new Date(today);
  start.setMonth(start.getMonth() - months);
  const day = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 10);
  const ymd = (d) => fmtLocal(d).slice(0, 10);
  const stamp = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const pay = (rid, amount, d, method, kind = 'pago') => {
    if (!(amount > 0)) return;
    addPayment(db, rid, { amount, method, kind });
    db.prepare('UPDATE payments SET created_at = ? WHERE id = (SELECT MAX(id) FROM payments)').run(stamp(d));
  };

  const names = work
    ? ['Gustavo Acosta', 'Nicolás Medina', 'Brenda Sosa', 'Hernán Ojeda', 'Pablo Ibarra', 'Sergio Molina', 'Daniela Paz', 'Walter Quiroga', 'Ezequiel Vera', 'Fernando Godoy', 'Jorge Cabrera', 'Micaela Luna']
    : ['Ana Silva', 'Pedro Ramírez', 'Laura Méndez', 'John Smith', 'Rocío Navarro', 'Federico Ríos', 'Julia Moreno', 'Andrés Castillo', 'Carolina Vega', 'Tomás Aguirre', 'Sarah Johnson',
       'Ignacio Peralta', 'Victoria Ledesma', 'Gonzalo Figueroa', 'Agustina Rojas', 'Bruno Ferreyra', 'Natalia Correa', 'Luca Rossi', 'Milagros Ponce', 'Santiago Vidal', 'Marina Costa', 'Facundo Ortiz'];
  const people = names.map((name, i) =>
    ins(
      "INSERT INTO customers (full_name, doc_type, doc_number, phone, license_number, license_expiry, license_class, work_apps) VALUES (?, 'DNI', ?, ?, ?, ?, ?, ?)",
      name, String(26000000 + i * 517313), `+54 9 11 ${4000 + i * 137}-${1000 + i * 311}`, `LIC-H${i + 1}`, `${y + 3}-12-31`,
      work ? 'D1 (profesional)' : null, work ? pickOne(['Uber', 'Uber, DiDi', 'Cabify', 'DiDi', 'PedidosYa', 'remis']) : null,
    ),
  );
  const branches = db.prepare('SELECT id FROM branches ORDER BY id').all().map((b) => b.id);
  const extras = db.prepare("SELECT id, code FROM extras WHERE code IN ('GPS', 'SILLA', 'COND', 'CAD', 'FULL', 'MEDIO')").all();
  const extra = (code) => extras.filter((e) => e.code === code).map((e) => ({ extra_id: e.id, quantity: 1 }));
  // Temporada: verano y vacaciones de invierno se llenan; abril, mayo y octubre son flojos.
  const busy = [0.85, 0.85, 0.6, 0.45, 0.35, 0.45, 0.8, 0.75, 0.45, 0.4, 0.5, 0.75];

  const cars = db.prepare('SELECT id, plate, category_id, km, status FROM vehicles ORDER BY id').all();
  const firstUse = db.prepare('SELECT MIN(pickup_at) AS at FROM reservations WHERE vehicle_id = ?');
  for (const car of cars) {
    const until = firstUse.get(car.id).at ? day(new Date(firstUse.get(car.id).at.replace(' ', 'T')), -2) : day(today, -1);
    const plan = [];
    let d = day(start, int(0, work ? 20 : 6));
    while (true) {
      const len = work ? 7 * int(3, 10) : int(2, 8);
      const end = day(d, len);
      if (end > until) break;
      plan.push([d, end, len]);
      d = day(end, work ? int(2, 12) : Math.max(0, Math.round((1 - busy[end.getMonth()]) * int(4, 12)) - 1));
    }
    // Los km de antes: el auto termina el año con los que tiene hoy.
    const kmPerDay = work ? 260 : int(150, 230);
    let km = Math.max(0, car.km - plan.reduce((a, [, , len]) => a + len * kmPerDay, 0) - int(500, 3000));
    db.prepare("UPDATE vehicles SET status = 'disponible', km = ? WHERE id = ?").run(km, car.id);
    let nextService = Math.ceil((km + 1) / 10000) * 10000;
    for (const [from, to, len] of plan) {
      const branch = pickOne(branches);
      const opts = work
        ? {}
        : { extras: [...(rnd() < 0.35 ? extra(pickOne(['FULL', 'MEDIO'])) : []), ...(rnd() < 0.25 ? extra(pickOne(['GPS', 'SILLA', 'COND'])) : []), ...([5, 6, 7].includes(from.getMonth()) && rnd() < 0.4 ? extra('CAD') : [])] };
      const r = createReservation(db, {
        customer_id: pickOne(people), category_id: car.category_id, vehicle_id: car.id, pickup_branch_id: branch, return_branch_id: branch,
        pickup_at: fmtLocal(from), return_at: fmtLocal(to), status: 'confirmada', source: work ? 'manual' : pickOne(['manual', 'manual', 'web', 'web', 'web', 'cotizador']),
        allow_overbooking: true, ...opts,
      });
      db.prepare('UPDATE reservations SET created_at = ? WHERE id = ?').run(fmtLocal(day(from, -int(1, 25))), r.id);
      // Algunas se caen: cancelaciones y clientes que no vinieron (el auto queda libre esos días).
      if (!work && rnd() < 0.08) {
        db.prepare('UPDATE reservations SET status = ? WHERE id = ?').run(rnd() < 0.7 ? 'cancelada' : 'no_show', r.id);
        continue;
      }
      checkout(db, r.id, { out_at: fmtLocal(from), out_km: km, out_fuel: 8 }, null);
      const method = () => pickOne(['transferencia', 'transferencia', 'tarjeta', 'efectivo', 'mercadopago']);
      if (work) {
        pay(r.id, r.deposit || 300000, from, 'efectivo', 'garantia');
        for (let w = 0; w < len / 7; w++) pay(r.id, Math.round(r.total / (len / 7)), day(from, 7 * w + (rnd() < 0.15 ? int(1, 3) : 0)), method());
      }
      km += len * kmPerDay + int(-300, 300);
      const damage = !work && rnd() < 0.05 ? int(4, 30) * 10000 : 0;
      checkin(db, r.id, { in_at: fmtLocal(to), in_km: km, in_fuel: 8, ...(damage ? { damage_charge: damage, in_notes: 'Raspón en el paragolpes' } : {}) }, null);
      const pending = getReservation(db, r.id).balance.pending;
      pay(r.id, pending, to, work ? 'efectivo' : method());
      if (work) pay(r.id, r.deposit || 300000, to, 'efectivo', 'devolucion_garantia');
      if (km >= nextService) {
        ins("INSERT INTO maintenance (vehicle_id, kind, description, start_date, end_date, km, cost, status) VALUES (?, 'service', ?, ?, ?, ?, ?, 'cerrado')",
          car.id, `Service ${nextService.toLocaleString('es-AR')} km`, ymd(to), ymd(day(to, 1)), km, int(14, 24) * 10000);
        nextService += 10000;
      }
    }
    db.prepare('UPDATE vehicles SET status = ?, km = ? WHERE id = ?').run(car.status, car.km, car.id);
  }

  // Gastos de todos los meses: seguro de la flota, patentes, lavados y, en los autos de trabajo, GNC y repuestos.
  for (let m = 0; m < months; m++) {
    const first = new Date(start.getFullYear(), start.getMonth() + m, 1, 10);
    const at = (n) => ymd(day(first, n));
    if (day(first, 27) > today) break;
    ins('INSERT INTO expenses (vehicle_id, date, kind, description, amount) VALUES (NULL, ?, ?, ?, ?)', at(9), 'seguro', 'Cuota del seguro de la flota', cars.length * (work ? 70000 : 85000));
    if (m % 2 === 0) ins('INSERT INTO expenses (vehicle_id, date, kind, description, amount) VALUES (NULL, ?, ?, ?, ?)', at(14), 'patente', 'Patentes', cars.length * 38000);
    for (let i = 0; i < (work ? 4 : 3); i++) {
      const [kind, description, a, b] = pickOne(
        work
          ? [['combustible', 'Carga de GNC', 6, 12], ['repuestos', 'Pastillas de freno', 50, 80], ['repuestos', 'Cubierta nueva', 100, 140], ['lavado', 'Lavado completo', 15, 22], ['taller', 'Alineación y balanceo', 30, 45]]
          : [['lavado', 'Lavado completo', 15, 22], ['repuestos', 'Escobillas y lámparas', 20, 35], ['repuestos', 'Cubierta nueva', 110, 150], ['taller', 'Alineación y balanceo', 30, 45]],
      );
      ins('INSERT INTO expenses (vehicle_id, date, kind, description, amount) VALUES (?, ?, ?, ?, ?)', pickOne(cars).id, at(int(1, 27)), kind, description, int(a, b) * 1000);
    }
  }
  return true;
}

if (require.main === module) {
  const db = openDb();
  const admin = ensureAdmin(db);
  console.log(seed(db) ? 'Datos de ejemplo cargados.' : 'Ya había datos: no se cargó nada.');
  if (admin) console.log(`Usuario inicial: ${admin.email} / ${admin.password}`);
}

module.exports = { seed, seedDemo, seedChoferes, seedHistory };
