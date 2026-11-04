'use strict';

/* Modo "autos para choferes": períodos que se renuevan solos, recargo por atraso, km por período, multas y gastos. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, setSetting } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { computeStats } = require('../src/routes/stats');
const { fmtLocal } = require('../src/util');
const C = require('../src/choferes');
const R = require('../src/reservations');

test('períodos: un día, una semana o un mes de calendario', () => {
  assert.equal(C.addPeriod('2027-01-05T10:00', 'dia'), '2027-01-06T10:00');
  assert.equal(C.addPeriod('2027-01-05T10:00', 'semana'), '2027-01-12T10:00');
  assert.equal(C.addPeriod('2027-01-31T09:30', 'mes'), '2027-02-28T09:30');
  assert.equal(C.periodsBetween('2027-01-05T10:00', '2027-01-12T10:00', 'semana'), 1);
  assert.equal(C.periodsBetween('2027-01-05T10:00', '2027-01-13T10:00', 'semana'), 2); // la semana empezada cuenta entera
  assert.equal(C.periodRate({ daily_rate: 10, weekly_rate: 0, monthly_rate: 0 }, 'semana'), 70);
  assert.equal(C.periodRate({ daily_rate: 10, weekly_rate: 60, monthly_rate: 200 }, 'mes'), 200);
});

test('recargo por atraso: cuenta los días desde que vence cada período hasta que se cubre, menos la tolerancia', () => {
  const settings = { late_fee_per_day: '1000', late_grace_days: '1' };
  const periods = [
    { n: 1, start_at: '2027-01-01T10:00', amount: 100 },
    { n: 2, start_at: '2027-01-08T10:00', amount: 100 },
    { n: 3, start_at: '2027-01-15T10:00', amount: 100 },
  ];
  const pagos = [
    { kind: 'pago', at: '2027-01-01T11:00', amount: 100 }, // el 1.º, a tiempo
    { kind: 'pago', at: '2027-01-12T10:00', amount: 100 }, // el 2.º, 4 días tarde: 3 con recargo
  ];
  // El 3.º todavía no se pagó: al 18/01 lleva 3 días, 2 con recargo.
  assert.deepEqual(C.lateFee(periods, pagos, settings, '2027-01-18T10:00'), { total: 5000, days: 5 });
  // Sin recargo configurado no se cobra nada, y un período que todavía no empezó no está atrasado.
  assert.equal(C.lateFee(periods, [], { late_fee_per_day: '0' }, '2027-02-01T10:00').total, 0);
  assert.equal(C.lateFee(periods, pagos, settings, '2027-01-09T10:00').total, 0);
  // Una devolución de dinero descubre el período otra vez.
  assert.equal(C.lateFee(periods.slice(0, 1), [...pagos.slice(0, 1), { kind: 'devolucion', at: '2027-01-01T12:00', amount: 50 }], settings, '2027-01-05T10:00').days, 3);
});

/** Empresa en modo choferes con un auto de 100.000 por semana, 1.000 km por semana y el km extra a 50. */
function fleet(mode = 'choferes') {
  const db = openDb(':memory:');
  setSetting(db, 'business_mode', mode);
  setSetting(db, 'rent_period', 'semana');
  setSetting(db, 'late_fee_per_day', '2000');
  const cat = Number(
    db.prepare("INSERT INTO categories (code, name, daily_rate, weekly_rate, deposit, km_per_period, extra_km_rate) VALUES ('APP', 'Auto para apps', 20000, 100000, 300000, 1000, 50)").run().lastInsertRowid,
  );
  const vehicle = Number(db.prepare("INSERT INTO vehicles (plate, category_id, km, service_every_km) VALUES ('AB123CD', ?, 50000, 10000)").run(cat).lastInsertRowid);
  const customer = Number(
    db.prepare("INSERT INTO customers (full_name, license_number, license_expiry, license_class, work_apps) VALUES ('Chofer Prueba', '123', '2099-01-01', 'D1', 'Uber, DiDi')").run().lastInsertRowid,
  );
  return { db, cat, vehicle, customer };
}
const daysAgo = (n) => {
  const d = new Date();
  return fmtLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, 10, 0));
};

test('cobro por día: domingos y feriados van a su tarifa solo si la categoría la tiene', () => {
  const { db, cat, vehicle, customer } = fleet();
  setSetting(db, 'rent_period', 'dia');
  setSetting(db, 'holidays', '10/11/2026, 8/12/2026');
  db.prepare('UPDATE categories SET daily_rate = 50000, rest_day_rate = 40000 WHERE id = ?').run(cat);
  // De 23:00 a 23:00: el período que arranca el viernes 06/11 a la noche es el sábado 07.
  const r = R.createReservation(db, { customer_id: customer, category_id: cat, vehicle_id: vehicle, pickup_at: '2026-11-06T23:00', return_at: '2026-11-07T23:00', status: 'confirmada' });
  R.checkout(db, r.id, { out_at: '2026-11-06T23:00', out_km: 50000, out_fuel: 8 }, 1);
  C.renew(db, r.id, '2026-11-11T12:00');
  // sáb 07, dom 08, lun 09, feriado mar 10, mié 11
  assert.deepEqual(R.getReservation(db, r.id).periods.map((p) => p.amount), [50000, 40000, 50000, 40000, 50000]);

  // Sin tarifa de domingos (la de todas las agencias que no la cargan) todo sigue igual.
  const other = fleet();
  setSetting(other.db, 'rent_period', 'dia');
  const r2 = R.createReservation(other.db, { customer_id: other.customer, category_id: other.cat, vehicle_id: other.vehicle, pickup_at: '2026-11-06T23:00', return_at: '2026-11-07T23:00', status: 'confirmada' });
  R.checkout(other.db, r2.id, { out_at: '2026-11-06T23:00', out_km: 50000, out_fuel: 8 }, 1);
  C.renew(other.db, r2.id, '2026-11-11T12:00');
  assert.deepEqual(R.getReservation(other.db, r2.id).periods.map((p) => p.amount), [20000, 20000, 20000, 20000, 20000]);
});

test('precio propio de cada auto: manda sobre la categoría, con sus domingos, y si cambia vale desde la renovación siguiente', () => {
  const { db, cat, vehicle, customer } = fleet();
  setSetting(db, 'rent_period', 'dia');
  db.prepare('UPDATE categories SET daily_rate = 50000, rest_day_rate = 40000 WHERE id = ?').run(cat);
  db.prepare('UPDATE vehicles SET period_rate = 45000, rest_day_rate = 30000 WHERE id = ?').run(vehicle);
  const input = { customer_id: customer, category_id: cat, vehicle_id: vehicle, pickup_at: '2026-11-06T23:00', return_at: '2026-11-07T23:00', status: 'confirmada' };
  const r = R.createReservation(db, input);
  assert.equal(r.total, 45000, 'la reserva ya sale con el precio del auto');
  R.checkout(db, r.id, { out_at: '2026-11-06T23:00', out_km: 50000, out_fuel: 8 }, 1);
  C.renew(db, r.id, '2026-11-08T12:00');
  // sáb 07 a 45.000 y dom 08 al domingo del auto (no al de la categoría).
  assert.deepEqual(R.getReservation(db, r.id).periods.map((p) => p.amount), [45000, 30000]);
  // La agencia sube el precio: lo ya cobrado no cambia, lo que viene sí.
  db.prepare('UPDATE vehicles SET period_rate = 48000 WHERE id = ?').run(vehicle);
  C.renew(db, r.id, '2026-11-10T12:00');
  assert.deepEqual(R.getReservation(db, r.id).periods.map((p) => p.amount), [45000, 30000, 48000, 48000]);
  assert.equal(R.getReservation(db, r.id).total, 171000);

  // Sin domingo propio, el auto cobra su precio todos los días (no el domingo de la categoría).
  db.prepare('UPDATE vehicles SET rest_day_rate = 0 WHERE id = ?').run(vehicle);
  const other = fleet();
  setSetting(other.db, 'rent_period', 'dia');
  other.db.prepare('UPDATE categories SET daily_rate = 50000, rest_day_rate = 40000 WHERE id = ?').run(other.cat);
  other.db.prepare('UPDATE vehicles SET period_rate = 45000 WHERE id = ?').run(other.vehicle);
  const r2 = R.createReservation(other.db, { ...input, customer_id: other.customer, category_id: other.cat, vehicle_id: other.vehicle });
  R.checkout(other.db, r2.id, { out_at: '2026-11-06T23:00', out_km: 50000, out_fuel: 8 }, 1);
  C.renew(other.db, r2.id, '2026-11-08T12:00');
  assert.deepEqual(R.getReservation(other.db, r2.id).periods.map((p) => p.amount), [45000, 45000]);
});

test('domingos y feriados libres del auto: no se cobran, no suman atraso y no cortan la cuenta de días que debe', () => {
  const { db, cat, vehicle, customer } = fleet();
  setSetting(db, 'rent_period', 'dia');
  setSetting(db, 'holidays', '10/11/2026');
  db.prepare('UPDATE categories SET daily_rate = 50000, rest_day_rate = 40000 WHERE id = ?').run(cat);
  db.prepare('UPDATE vehicles SET rest_day_free = 1 WHERE id = ?').run(vehicle);
  const r = R.createReservation(db, { customer_id: customer, category_id: cat, vehicle_id: vehicle, pickup_at: '2026-11-06T23:00', return_at: '2026-11-07T23:00', status: 'confirmada' });
  R.checkout(db, r.id, { out_at: '2026-11-06T23:00', out_km: 50000, out_fuel: 8 }, 1);
  C.renew(db, r.id, '2026-11-11T12:00');
  // sáb 07, dom 08 libre, lun 09, feriado mar 10 libre, mié 11: sin precio propio, el de la categoría.
  const after = R.getReservation(db, r.id);
  assert.deepEqual(after.periods.map((p) => p.amount), [50000, 0, 50000, 0, 50000]);
  assert.equal(after.total, 150000);
  const settings = { late_fee_per_day: '1000', late_grace_days: '0' };
  // Solo vence el sábado 07: el domingo libre no suma atraso.
  assert.equal(C.lateFee(after.periods.slice(0, 2), [], settings, '2026-11-08T23:00').days, 2);
  assert.equal(C.lateFee([{ n: 1, start_at: '2026-11-07T23:00', amount: 0 }], [], settings, '2026-11-09T23:00').days, 0);
  // Termina en un día libre: los días que debe se cuentan con el último que se cobró.
  C.renew(db, r.id, '2026-11-14T23:30');
  const last = R.getReservation(db, r.id).periods.at(-1);
  assert.equal(last.amount, 0, 'el último período es domingo');
  const owing = C.dashboardChoferes(db, R.getReservation, '2026-11-15').owing[0];
  assert.ok(owing.days_owed >= 5, `días que debe: ${owing.days_owed}`);

  // Con precio propio, los demás días van a ese precio; apagado, el domingo vuelve a cobrarse.
  db.prepare('UPDATE vehicles SET period_rate = 45000 WHERE id = ?').run(vehicle);
  assert.equal(C.carRate(db, vehicle, 'dia', '')('2026-11-09T23:00'), 45000);
  assert.equal(C.carRate(db, vehicle, 'dia', '')('2026-11-07T23:00'), 0);
  db.prepare('UPDATE vehicles SET rest_day_free = 0 WHERE id = ?').run(vehicle);
  assert.equal(C.carRate(db, vehicle, 'dia', '')('2026-11-07T23:00'), 45000);
  // Cobrando por semana no aplica.
  db.prepare('UPDATE vehicles SET period_rate = 0, rest_day_free = 1 WHERE id = ?').run(vehicle);
  assert.equal(C.carRate(db, vehicle, 'semana', ''), null);
});

test('corregir el inicio de un alquiler en curso: se rearman los días desde la fecha nueva y no figura como "vuelve hoy"', async () => {
  const { db, cat, vehicle, customer } = fleet();
  setSetting(db, 'rent_period', 'dia');
  db.prepare('UPDATE categories SET daily_rate = 50000 WHERE id = ?').run(cat);
  const r = R.createReservation(db, { customer_id: customer, category_id: cat, vehicle_id: vehicle, pickup_at: daysAgo(26), return_at: daysAgo(25), status: 'confirmada' });
  R.checkout(db, r.id, { out_at: daysAgo(26), out_km: 50000, out_fuel: 8 }, 1);
  C.renew(db, r.id);
  assert.equal(R.getReservation(db, r.id).periods.length, 27);

  C.restart(db, r.id, daysAgo(2), 1);
  const after = R.getReservation(db, r.id);
  assert.deepEqual(after.periods.map((p) => [p.n, p.amount]), [[1, 50000], [2, 50000], [3, 50000]]);
  assert.equal(after.pickup_at, daysAgo(2));
  assert.equal(after.contract.out_at, daysAgo(2));
  assert.equal(after.total, 150000);
  assert.ok(after.log.some((l) => l.action === 'inicio_corregido'));
  assert.throws(() => C.restart(db, r.id, '2999-01-01T10:00'), /todavía no llegó/);
  assert.throws(() => C.restart(db, r.id, 'ayer'), /inválida/);

  // Hoy y la flota: un alquiler por tiempo indeterminado no es una devolución (ni vencida ni para hoy). Por la API, solo un admin corrige.
  ensureAdmin(db);
  const server = createApp(db).listen(0);
  await new Promise((ok) => server.once('listening', ok));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) });
    if (!cookie && res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    await call('POST', '/auth/login', { email: 'admin@rentacar.local', password: 'admin123' });
    await call('POST', '/auth/password', { current: 'admin123', password: 'ChoferesPrueba2026' });
    const d = (await call('GET', '/dashboard')).data;
    assert.deepEqual([d.returns_today.length, d.overdue.length], [0, 0]);
    assert.equal((await call('GET', '/vehicles')).data.find((v) => v.id === vehicle).back_at, null);
    const fixed = await call('PUT', `/reservations/${r.id}/start`, { start_at: daysAgo(1) });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.data.periods.length, 2);
  } finally {
    server.close();
  }
});

test('seguro del auto como gasto mensual, pago con repuesto y notas, alerta de deuda de más de 3 días y habilitación por vencer', async () => {
  const { db, cat, vehicle, customer } = fleet();
  setSetting(db, 'rent_period', 'dia');
  db.prepare('UPDATE categories SET daily_rate = 50000 WHERE id = ?').run(cat);
  ensureAdmin(db);
  const server = createApp(db).listen(0);
  await new Promise((ok) => server.once('listening', ok));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let cookie;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) });
    if (!cookie && res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    await call('POST', '/auth/login', { email: 'admin@rentacar.local', password: 'admin123' });
    await call('POST', '/auth/password', { current: 'admin123', password: 'ChoferesPrueba2026' });
    const soon = fmtLocal(new Date(Date.now() + 10 * 86400000)).slice(0, 10);
    const v = await call('PUT', `/vehicles/${vehicle}`, { insurance_company: 'Agrosalta', insurance_policy: '8.751.520', insurance_cost: 26000, permit_number: '33379', permit_expiry: soon });
    assert.equal(v.status, 200);

    // La cuota se carga una sola vez por mes aunque se abra Hoy muchas veces.
    const d = (await call('GET', '/dashboard')).data;
    await call('GET', '/dashboard');
    await call('GET', '/expenses');
    const cuotas = db.prepare("SELECT * FROM expenses WHERE kind = 'seguro' AND vehicle_id = ?").all(vehicle);
    assert.equal(cuotas.length, 1);
    assert.equal(cuotas[0].amount, 26000);
    assert.match(cuotas[0].description, /Agrosalta · póliza 8\.751\.520/);
    assert.equal(cuotas[0].date, `${fmtLocal(new Date()).slice(0, 7)}-01`);
    assert.equal(d.alerts.documents.find((x) => x.id === vehicle).permit_expiry, soon, 'habilitación por vencer en Hoy');

    // 5 días sin pagar: debe más de 3. Paga 2 días (uno con un repuesto, con nota) y queda en 3.
    const r = (await call('POST', '/reservations', { customer_id: customer, category_id: cat, vehicle_id: vehicle, pickup_at: daysAgo(4), return_at: daysAgo(3), status: 'confirmada' })).data;
    await call('POST', `/reservations/${r.id}/checkout`, { out_at: daysAgo(4), out_km: 50000, out_fuel: 8 });
    let owing = (await call('GET', '/dashboard')).data.choferes.owing[0];
    assert.equal(owing.days_owed, 5);
    await call('POST', `/reservations/${r.id}/payments`, { amount: 50000, method: 'efectivo' });
    const pago = await call('POST', `/reservations/${r.id}/payments`, { amount: 50000, method: 'repuesto', notes: 'Batería nueva' });
    assert.equal(pago.data.payments.at(-1).notes, 'Batería nueva');
    owing = (await call('GET', '/dashboard')).data.choferes.owing[0];
    assert.equal(owing.days_owed, 3);
    // El repuesto queda también como gasto del auto (la plata no entró a caja).
    const rep = db.prepare("SELECT * FROM expenses WHERE kind = 'repuestos' AND vehicle_id = ?").get(vehicle);
    assert.equal(rep.amount, 50000);
    assert.match(rep.description, /Batería nueva \(lo pagó el chofer/);
  } finally {
    server.close();
  }
});

test('alquiler semanal: se cobra por semana, se renueva solo y suma km extra, multas y recargo', () => {
  const { db, cat, vehicle, customer } = fleet();
  const r = R.createReservation(db, { customer_id: customer, category_id: cat, vehicle_id: vehicle, pickup_at: daysAgo(15), return_at: daysAgo(8), status: 'confirmada' });
  assert.equal(r.total, 100000);
  assert.equal(r.pricing.periods, 1);
  assert.equal(r.pricing.km_included, 1000);

  // Se entregó hace 15 días: al abrir el panel quedan 3 semanas (la 3.ª empezó hace 1 día).
  R.checkout(db, r.id, { out_at: daysAgo(15), out_km: 50000, out_fuel: 8 }, 1);
  C.renewDue(db);
  let x = R.getReservation(db, r.id);
  assert.deepEqual(x.periods.map((p) => p.n), [1, 2, 3]);
  assert.equal(x.total, 300000);
  assert.ok(x.return_at > fmtLocal(new Date()), 'la devolución pasa al fin de la semana en curso');
  assert.equal(C.renew(db, r.id), 0, 'no se renueva dos veces');

  // Sin pagos: la 1.ª lleva 15 días de atraso, la 2.ª 8 y la 3.ª 1 → 24 días × 2.000.
  assert.equal(x.late_fee.total, 48000);
  R.addPayment(db, r.id, { kind: 'pago', amount: 300000 }, 1);
  x = R.getReservation(db, r.id);
  assert.equal(x.late_fee.total, 48000, 'pagar hoy no borra el atraso que ya pasó');

  // 3.500 km en 3 semanas con 1.000 por semana: 500 de más × 50. Una segunda lectura igual no vuelve a cobrar.
  assert.deepEqual(C.kmReading(db, x, 53500, 1), { km: 500, amount: 25000 });
  assert.equal(C.kmReading(db, R.getReservation(db, r.id), 53500, 1), null);
  C.addCharge(db, x, { kind: 'multa', amount: 15000, reference: 'Acta 99', date: daysAgo(3) }, 1);
  x = R.getReservation(db, r.id);
  assert.equal(x.balance.due, 300000 + 25000 + 15000 + 48000);
  assert.equal(x.balance.pending, 25000 + 15000 + 48000);

  // Lo devuelve hoy: se cobran los km que faltaban y queda cerrado, sin cargo de "demora".
  x = R.checkin(db, r.id, { in_km: 53700, in_fuel: 8 }, 1);
  assert.equal(x.status, 'finalizada');
  assert.equal(x.charges.filter((c) => c.kind === 'km').reduce((a, c) => a + c.km, 0), 700);
  assert.equal(x.contract.final_total, 300000);
  assert.equal(db.prepare('SELECT status, km FROM vehicles WHERE id = ?').get(vehicle).km, 53700);
});

test('modo turismo: la entrega no arma períodos y todo se calcula como siempre', () => {
  const { db, cat, vehicle, customer } = fleet('turismo');
  const r = R.createReservation(db, { customer_id: customer, category_id: cat, vehicle_id: vehicle, pickup_at: daysAgo(15), return_at: daysAgo(12), status: 'confirmada' });
  assert.equal(r.total, 60000); // 3 días × 20.000
  assert.equal(r.pricing.periods, undefined);
  R.checkout(db, r.id, { out_at: daysAgo(15), out_km: 50000, out_fuel: 8 }, 1);
  C.renewDue(db);
  const x = R.getReservation(db, r.id);
  assert.deepEqual(x.periods, []);
  assert.equal(x.return_at, daysAgo(12));
  assert.equal(x.balance.due, 60000);
});

test('API: tipo de negocio, multas, lectura de km, Hoy y gastos en las estadísticas', async () => {
  const { db, cat, vehicle, customer } = fleet();
  ensureAdmin(db);
  const server = createApp(db).listen(0);
  await new Promise((ok) => server.once('listening', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) });
    if (!cookie && res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    await call('POST', '/api/auth/login', { email: 'admin@rentacar.local', password: 'admin123' });
    assert.equal((await call('POST', '/api/auth/password', { current: 'admin123', password: 'ChoferesPrueba2026' })).status, 200);
    assert.equal((await call('PUT', '/api/settings', { business_mode: 'otro' })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { rent_period: 'anio' })).status, 400);
    const s = (await call('GET', '/api/settings')).data;
    assert.equal(s.business_mode, 'choferes');
    assert.match(s.contract_terms_choferes, /RENOVACIÓN/);

    const r = (await call('POST', '/api/reservations', { customer_id: customer, category_id: cat, vehicle_id: vehicle, pickup_at: daysAgo(1), return_at: C.addPeriod(daysAgo(1), 'semana'), status: 'confirmada' })).data;
    assert.equal((await call('POST', `/api/reservations/${r.id}/km`, { km: 50100 })).status, 409, 'antes de entregar no hay lectura de km');
    assert.equal((await call('POST', `/api/reservations/${r.id}/checkout`, { out_km: 50000, out_fuel: 8 })).status, 200);
    const fined = (await call('POST', `/api/reservations/${r.id}/charges`, { kind: 'multa', amount: 8000, reference: 'Fotomulta' })).data;
    assert.equal(fined.charges.length, 1);
    assert.equal((await call('POST', `/api/reservations/${r.id}/charges`, { amount: 0 })).status, 400);
    const read = (await call('POST', `/api/reservations/${r.id}/km`, { km: 51300 })).data;
    assert.deepEqual(read.km_charge, { km: 300, amount: 15000 });
    const unfined = (await call('DELETE', `/api/reservations/${r.id}/charges/${fined.charges.find((c) => c.kind === 'multa').id}`)).data;
    assert.equal(unfined.charges.length, 1);

    // Hoy: debe la semana y los km; el auto (51.300 km, service cada 10.000) no lo necesita hasta cerca de los 60.000.
    const hoy = (await call('GET', '/api/dashboard')).data;
    assert.equal(hoy.choferes.owing[0].pending, 100000 + 15000);
    assert.deepEqual(hoy.choferes.service_due, []);
    db.prepare('UPDATE vehicles SET km = 59600 WHERE id = ?').run(vehicle);
    assert.equal((await call('GET', '/api/dashboard')).data.choferes.service_due[0].next_service_km, 60000);
    // Con el service hecho a los 59.800 (cargado en el taller), el próximo es a los 69.800.
    db.prepare("INSERT INTO maintenance (vehicle_id, kind, km, status) VALUES (?, 'service', 59800, 'cerrado')").run(vehicle);
    assert.deepEqual((await call('GET', '/api/dashboard')).data.choferes.service_due, []);

    // Gastos del auto: se restan del resultado del mes.
    const today = fmtLocal(new Date()).slice(0, 10);
    assert.equal((await call('POST', '/api/expenses', { vehicle_id: vehicle, date: today, kind: 'repuestos', amount: 40000 })).status, 201);
    await call('POST', '/api/expenses', { vehicle_id: vehicle, date: today, kind: 'combustible', amount: 10000 });
    await call('POST', `/api/reservations/${r.id}/payments`, { kind: 'pago', amount: 100000 });
    const st = computeStats(db, { from: today, to: today });
    assert.equal(st.totals.expenses, 50000);
    assert.deepEqual(st.cash, { income: 100000, shop_cost: 0, expenses: 50000, net: 50000 });
    assert.equal(st.vehicles[0].expenses, 50000);
    assert.equal(st.expenses[0].kind, 'repuestos');
  } finally {
    server.close();
  }
});

test('devolverlo justo al terminar la semana, o dentro de la tolerancia de horas, no abre otra semana', () => {
  const { db, cat, vehicle, customer } = fleet();
  setSetting(db, 'grace_hours', '2');
  const start = daysAgo(14);
  const r = R.createReservation(db, { customer_id: customer, category_id: cat, vehicle_id: vehicle, pickup_at: start, return_at: C.addPeriod(start, 'semana'), status: 'confirmada' });
  R.checkout(db, r.id, { out_at: start, out_km: 50000, out_fuel: 8 }, 1);
  const end2 = C.addPeriod(C.addPeriod(start, 'semana'), 'semana'); // fin de la 2.ª semana
  const later = (at, min) => fmtLocal(new Date(new Date(at.replace('T', ' ')).getTime() + min * 60000));
  const x = R.checkin(db, r.id, { in_at: later(end2, 90), in_km: 51000, in_fuel: 8 }, 1);
  assert.equal(x.periods.length, 2);
  assert.equal(x.contract.final_total, 200000);
});

test('demo de autos para trabajo: flota, choferes que deben, licencia vencida, service y gastos', () => {
  const { seedChoferes } = require('../src/seed');
  const db = openDb(':memory:');
  ensureAdmin(db);
  assert.equal(seedChoferes(db), true);
  assert.equal(seedChoferes(db), false, 'no se carga dos veces');
  const hoy = C.dashboardChoferes(db, R.getReservation, fmtLocal(new Date()).slice(0, 10));
  assert.deepEqual(
    hoy.owing.map((o) => [o.customer_name, o.pending, o.late_fee]),
    [
      ['Ramiro Díaz', 230000 + 15000 + 48000 + 400 * 90, 15000], // semana, recargo, multa y km de más
      ['Carla Gómez', 190000 + 5000, 5000],
    ],
  );
  assert.deepEqual(hoy.license_expired.map((x) => x.customer_name), ['Lucía Fernández']);
  assert.deepEqual(hoy.service_due.map((v) => v.plate), ['AG606MN']);
  const done = R.getReservation(db, db.prepare("SELECT id FROM reservations WHERE status = 'finalizada'").get().id);
  assert.equal(done.balance.pending, 0);
  assert.equal(done.balance.deposit_held, 0);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n >= 6);
});

test('Panel de Floty: una agencia nueva puede arrancar como "autos para trabajo"', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { openPlatform } = require('../src/platform');
  const { getSetting } = require('../src/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-choferes-'));
  const file = path.join(dir, 'rentacar.db');
  const platform = openPlatform(openDb(file), file);
  const trabajo = platform.create({ name: 'Flota Norte', country: 'AR', admin_name: 'Ana', admin_email: 'ana@flota-norte.test', business_mode: 'choferes' });
  const turismo = platform.create({ name: 'Rent Sur', country: 'AR', admin_name: 'Beto', admin_email: 'beto@rent-sur.test' });
  assert.equal(getSetting(platform.get(trabajo.company.id).db, 'business_mode'), 'choferes');
  assert.equal(getSetting(platform.get(turismo.company.id).db, 'business_mode'), 'turismo');
  assert.equal(platform.stats(trabajo.company.id).business_mode, 'choferes');
});
