'use strict';

const { getSettings } = require('./db');
const { addMonths } = require('./owner-book');
const { fail, fmtLocal, nowLocal, parseLocal, round2, tx } = require('./util');

/**
 * Modo "autos para choferes" (Configuración → Tipo de negocio): el auto se alquila por día, semana o mes
 * a un chofer de apps, se cobra por adelantado al empezar cada período y se renueva solo hasta que lo devuelve.
 * Cada empresa elige su modo; con el modo turismo nada de esto corre.
 */
const PERIODS = { dia: 'día', semana: 'semana', mes: 'mes' };
const DAY = 86400000;

const isChoferes = (settings) => settings.business_mode === 'choferes';
const periodOf = (settings) => (PERIODS[settings.rent_period] ? settings.rent_period : 'semana');

/** Fin de un período que empieza en `at` (AAAA-MM-DDTHH:MM). El mes es de calendario: 31/01 + 1 mes = 28 o 29/02. */
function addPeriod(at, period) {
  if (period === 'mes') return addMonths(at.slice(0, 10), 1) + at.slice(10);
  const d = parseLocal(at);
  return fmtLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() + (period === 'dia' ? 1 : 7), d.getHours(), d.getMinutes()));
}

/** Cuántos períodos entran entre dos fechas (el último, aunque esté empezado, cuenta entero). */
function periodsBetween(from, to, period) {
  let n = 0;
  for (let end = from; end < to; end = addPeriod(end, period)) n++;
  return Math.max(1, n);
}

/** Precio de un período: la tarifa de la categoría para ese período o, si no tiene, la diaria multiplicada. */
function periodRate(category, period) {
  if (period === 'dia') return category.daily_rate;
  if (period === 'semana') return category.weekly_rate || category.daily_rate * 7;
  return category.monthly_rate || category.daily_rate * 30;
}

/**
 * Recargo por pagar tarde: cada período vence al empezar (se paga por adelantado). Se cuenta cuándo lo pagado
 * alcanzó a cubrir ese período (o hoy, si todavía no) y se cobran los días pasados la tolerancia.
 * shortcut: los pagos cubren primero el alquiler (no las multas), en orden; si hace falta imputar pagos a mano, guardar a qué período va cada uno.
 */
function lateFee(periods, payments, settings, now = nowLocal()) {
  const perDay = Number(settings.late_fee_per_day) || 0;
  if (!(perDay > 0)) return { total: 0, days: 0 };
  const grace = Number(settings.late_grace_days) || 0;
  const paid = payments
    .filter((p) => p.kind === 'pago' || p.kind === 'devolucion')
    .map((p) => ({ at: p.at, amount: p.kind === 'pago' ? p.amount : -p.amount }))
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  let due = 0;
  let days = 0;
  for (const per of [...periods].sort((a, b) => a.n - b.n)) {
    due += per.amount;
    if (per.start_at > now) break;
    if (!(per.amount > 0)) continue; // un día libre no vence ni suma atraso
    // Cubierto desde el último pago que dejó lo pagado por encima (una devolución posterior lo vuelve a descubrir).
    let sum = 0;
    let covered = null;
    for (const p of paid) {
      sum += p.amount;
      if (sum < due - 0.005) covered = null;
      else covered ??= p.at;
    }
    const until = covered && covered < now ? covered : now;
    const late = Math.floor((parseLocal(until) - parseLocal(per.start_at)) / DAY) - grace;
    if (late > 0) days += late;
  }
  return { total: round2(days * perDay), days };
}

/** Los pagos traen la hora del servidor en UTC ("2026-11-02 15:00:00"): se pasa a la hora local, como los períodos. */
const paymentsLocal = (payments) => payments.map((p) => ({ ...p, at: fmtLocal(new Date(`${String(p.created_at).replace(' ', 'T')}Z`)) }));

/** Períodos, cargos (multas, km extra) y recargo por atraso de una reserva: los usa getReservation. */
function rentalExtras(db, r) {
  const periods = db.prepare('SELECT * FROM rental_periods WHERE reservation_id = ? ORDER BY n').all(r.id);
  const charges = db.prepare('SELECT * FROM rental_charges WHERE reservation_id = ? ORDER BY date, id').all(r.id);
  const late = periods.length ? lateFee(periods, paymentsLocal(r.payments), getSettings(db)) : { total: 0, days: 0 };
  return { periods, charges, late_fee: late };
}

/** Al entregar el auto: arma los períodos de la reserva desde la entrega, repartiendo el total entre ellos. */
/**
 * Precio propio del auto (lo pone la agencia en cada auto): el de cada período y, cobrando por día, el de domingos y feriados,
 * que también pueden ser libres (no se cobran). Sin precio propio ni días libres, null: se usa el de la categoría.
 */
function carRate(db, vehicleId, period, holidays) {
  const v =
    vehicleId &&
    db
      .prepare('SELECT v.period_rate, v.rest_day_rate, v.rest_day_free, c.daily_rate, c.weekly_rate, c.monthly_rate FROM vehicles v JOIN categories c ON c.id = v.category_id WHERE v.id = ?')
      .get(vehicleId);
  if (!v) return null;
  const free = period === 'dia' && v.rest_day_free;
  if (!(v.period_rate > 0) && !free) return null;
  const base = v.period_rate > 0 ? v.period_rate : periodRate(v, period);
  return (start) => {
    if (period !== 'dia' || !isRestDay(start, holidays)) return base;
    if (free) return 0;
    return v.rest_day_rate > 0 ? v.rest_day_rate : base;
  };
}

function openPeriods(db, r, outAt) {
  const settings = getSettings(db);
  const period = periodOf(settings);
  const n = periodsBetween(r.pickup_at, r.return_at, period);
  const car = carRate(db, r.vehicle_id, period, settings.holidays);
  const amount = round2(r.total / n);
  const ins = db.prepare('INSERT INTO rental_periods (reservation_id, n, start_at, end_at, amount) VALUES (?, ?, ?, ?, ?)');
  let start = outAt;
  for (let i = 1; i <= n; i++) {
    const end = addPeriod(start, period);
    ins.run(r.id, i, start, end, car ? car(start) : amount);
    start = end;
  }
  syncReservation(db, r.id);
}

/** La reserva sigue a sus períodos: devolución = fin del último, total = la suma. */
function syncReservation(db, id) {
  const s = db.prepare('SELECT MIN(start_at) AS a, MAX(end_at) AS b, SUM(amount) AS t FROM rental_periods WHERE reservation_id = ?').get(id);
  const days = Math.max(1, Math.round((parseLocal(s.b) - parseLocal(s.a)) / DAY));
  db.prepare('UPDATE reservations SET return_at = ?, total = ?, days = ?, updated_at = ? WHERE id = ?').run(s.b, round2(s.t), days, nowLocal(), id);
}

/** Domingo o feriado de Configuración (DD/MM/AAAA). El día de un período diario es el de su mitad: de 23:00 a 23:00 cuenta el siguiente. */
function isRestDay(start, holidays) {
  const day = fmtLocal(new Date(parseLocal(start).getTime() + DAY / 2)).slice(0, 10);
  if (parseLocal(`${day}T12:00`).getDay() === 0) return true;
  return String(holidays || '')
    .split(',')
    .some((h) => {
      const m = h.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      return m && `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` === day;
    });
}

/**
 * Renovación automática: mientras el auto siga con el chofer, cada período vencido abre el siguiente al mismo precio.
 * Cobro por día con tarifa de domingos y feriados en la categoría: esos días van a esa tarifa y el día siguiente vuelve a la diaria.
 */
function renew(db, reservationId, now = nowLocal(), userId = null) {
  let last = db.prepare('SELECT * FROM rental_periods WHERE reservation_id = ? ORDER BY n DESC LIMIT 1').get(reservationId);
  // El período siguiente arranca recién pasado el fin del actual (devolverlo justo al terminar no abre otro).
  if (!last || last.end_at >= now) return 0;
  const settings = getSettings(db);
  const period = periodOf(settings);
  const cat = db.prepare('SELECT c.daily_rate, c.rest_day_rate, r.vehicle_id FROM reservations r JOIN categories c ON c.id = r.category_id WHERE r.id = ?').get(reservationId);
  const rest = period === 'dia' && cat && cat.rest_day_rate > 0;
  // Con precio propio del auto, cada renovación va a ese precio (si la agencia lo cambia, el período siguiente ya sale con el nuevo).
  const car = cat && carRate(db, cat.vehicle_id, period, settings.holidays);
  const amountAfter = (prev, start) => {
    if (car) return car(start);
    if (!rest) return prev.amount;
    if (isRestDay(start, settings.holidays)) return cat.rest_day_rate;
    return isRestDay(prev.start_at, settings.holidays) ? cat.daily_rate : prev.amount;
  };
  const ins = db.prepare('INSERT INTO rental_periods (reservation_id, n, start_at, end_at, amount) VALUES (?, ?, ?, ?, ?)');
  const logIns = db.prepare("INSERT INTO reservation_log (reservation_id, user_id, action, detail) VALUES (?, ?, 'renovado', ?)");
  let added = 0;
  tx(db, () => {
    while (last.end_at < now) {
      const next = { n: last.n + 1, start_at: last.end_at, end_at: addPeriod(last.end_at, period), amount: amountAfter(last, last.end_at) };
      ins.run(reservationId, next.n, next.start_at, next.end_at, next.amount);
      logIns.run(reservationId, userId, JSON.stringify({ periodo: next.n, desde: next.start_at, hasta: next.end_at, importe: next.amount }));
      last = next;
      added++;
    }
    syncReservation(db, reservationId);
  });
  return added;
}

/** Renueva todos los alquileres vencidos que siguen en curso (se llama al abrir el panel y las reservas). */
/**
 * Corregir desde cuándo corre un alquiler en curso (por ejemplo, uno que venía de antes y se cargó con otra fecha):
 * se rearman los períodos desde la fecha nueva hasta hoy, al precio de ahora. Los pagos no se tocan.
 */
function restart(db, id, at, userId = null) {
  const r = db.prepare('SELECT r.*, c.daily_rate, c.weekly_rate, c.monthly_rate, c.rest_day_rate FROM reservations r JOIN categories c ON c.id = r.category_id WHERE r.id = ?').get(Number(id));
  if (!r) fail(404, 'Reserva inexistente');
  if (r.status !== 'en_curso' || !db.prepare('SELECT 1 FROM rental_periods WHERE reservation_id = ?').get(r.id)) fail(409, 'Solo se corrige el inicio de un alquiler en curso');
  const start = String(at || '').slice(0, 16);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start) || Number.isNaN(parseLocal(start).getTime())) fail(400, 'Fecha de inicio inválida');
  const now = nowLocal();
  if (start > now) fail(400, 'El inicio no puede ser una fecha que todavía no llegó');
  const settings = getSettings(db);
  const period = periodOf(settings);
  const car = carRate(db, r.vehicle_id, period, settings.holidays);
  const rest = period === 'dia' && r.rest_day_rate > 0 && isRestDay(start, settings.holidays);
  const amount = car ? car(start) : rest ? r.rest_day_rate : periodRate(r, period);
  tx(db, () => {
    db.prepare('DELETE FROM rental_periods WHERE reservation_id = ?').run(r.id);
    db.prepare('INSERT INTO rental_periods (reservation_id, n, start_at, end_at, amount) VALUES (?, 1, ?, ?, ?)').run(r.id, start, addPeriod(start, period), amount);
    db.prepare('UPDATE reservations SET pickup_at = ? WHERE id = ?').run(start, r.id);
    db.prepare('UPDATE contracts SET out_at = ? WHERE reservation_id = ?').run(start, r.id);
    db.prepare("INSERT INTO reservation_log (reservation_id, user_id, action, detail) VALUES (?, ?, 'inicio_corregido', ?)").run(r.id, userId, JSON.stringify({ antes: r.pickup_at, ahora: start }));
    syncReservation(db, r.id);
  });
  renew(db, r.id, now, userId);
}

function renewDue(db, now = nowLocal()) {
  if (!isChoferes(getSettings(db))) return;
  const due = db
    .prepare("SELECT id FROM reservations WHERE status = 'en_curso' AND return_at <= ? AND EXISTS (SELECT 1 FROM rental_periods p WHERE p.reservation_id = reservations.id)")
    .all(now);
  for (const r of due) renew(db, r.id, now);
}

/**
 * Lectura del cuentakilómetros: los km por período de la categoría por la cantidad de períodos son los permitidos;
 * lo que se pase (y no se haya cobrado en una lectura anterior) se cobra al precio del km excedente.
 */
function kmReading(db, r, km, userId) {
  km = Number(km);
  if (!r.contract) fail(409, 'El auto todavía no se entregó');
  if (!(km >= r.contract.out_km)) fail(400, `El km tiene que ser mayor o igual al de la entrega (${r.contract.out_km})`);
  const cat = db.prepare('SELECT km_per_period, extra_km_rate FROM categories WHERE id = ?').get(r.category_id);
  const periods = db.prepare('SELECT COUNT(*) AS n FROM rental_periods WHERE reservation_id = ?').get(r.id).n;
  const charged = db.prepare("SELECT COALESCE(SUM(km), 0) AS km FROM rental_charges WHERE reservation_id = ? AND kind = 'km'").get(r.id).km;
  const excess = km - r.contract.out_km - cat.km_per_period * periods - charged;
  db.prepare('UPDATE vehicles SET km = MAX(km, ?) WHERE id = ?').run(km, r.vehicle_id);
  if (!(cat.km_per_period > 0 && cat.extra_km_rate > 0 && excess > 0)) return null;
  const amount = round2(excess * cat.extra_km_rate);
  db.prepare("INSERT INTO rental_charges (reservation_id, kind, date, description, km, amount, created_by) VALUES (?, 'km', ?, ?, ?, ?, ?)").run(
    r.id,
    nowLocal().slice(0, 10),
    `Km excedentes (${excess} km, lectura ${km} km)`,
    excess,
    amount,
    userId || null,
  );
  return { km: excess, amount };
}

/** Multa u otro cargo a cuenta del chofer (se suma a lo que debe). */
function addCharge(db, r, input, userId) {
  const amount = Number(input.amount);
  if (!(amount > 0)) fail(400, 'Importe inválido');
  const kind = input.kind === 'otro' ? 'otro' : 'multa';
  db.prepare('INSERT INTO rental_charges (reservation_id, kind, date, reference, description, amount, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    r.id,
    kind,
    String(input.date || nowLocal()).slice(0, 10),
    input.reference || null,
    input.description || null,
    round2(amount),
    userId || null,
  );
}

/** Para la pantalla Hoy: quién debe, autos que necesitan service y choferes con la licencia vencida. */
function dashboardChoferes(db, getReservation, today) {
  const rentals = db.prepare("SELECT id FROM reservations WHERE status = 'en_curso'").all().map((x) => getReservation(db, x.id));
  const owing = rentals
    .filter((r) => r.balance.pending > 0.005)
    .map((r) => {
      // Días que debe: lo pendiente del alquiler (sin recargos ni multas) sobre el precio del último período (con días a distinto precio es aproximado).
      const day = r.periods.map((p) => p.amount).filter((a) => a > 0).pop() || 0; // el último día que se cobró: los libres valen 0
      const rent = r.balance.pending - r.late_fee.total - r.charges.reduce((a, c) => a + c.amount, 0);
      const days_owed = day > 0 && rent > 0 ? Math.floor((rent / day) * 10) / 10 : 0;
      return { id: r.id, code: r.code, customer_name: r.customer_name, customer_phone: r.customer_phone, vehicle_plate: r.vehicle_plate, pending: r.balance.pending, late_fee: r.late_fee.total, days_owed };
    })
    .sort((a, b) => b.pending - a.pending);
  const license_expired = rentals
    .filter((r) => r.customer_license_expiry && r.customer_license_expiry < today)
    .map((r) => ({ id: r.id, code: r.code, customer_name: r.customer_name, license_expiry: r.customer_license_expiry }));
  // Service: el último del taller más el intervalo o, si no hay ninguno cargado, el próximo múltiplo (60.000, 70.000…).
  // Aparece cuando le quedan 500 km o menos.
  const service_due = db
    .prepare(
      `SELECT v.id, v.plate, v.brand, v.model, v.km, v.service_every_km,
         (SELECT MAX(m.km) FROM maintenance m WHERE m.vehicle_id = v.id AND m.kind = 'service') AS last_service_km
       FROM vehicles v WHERE v.service_every_km > 0 ORDER BY v.plate`,
    )
    .all()
    .map((v) => ({
      ...v,
      next_service_km: v.last_service_km ? v.last_service_km + v.service_every_km : (Math.floor(v.km / v.service_every_km) + 1) * v.service_every_km,
    }))
    .filter((v) => v.km >= v.next_service_km - 500);
  return { owing, license_expired, service_due };
}

module.exports = { PERIODS, isChoferes, periodOf, addPeriod, isRestDay, periodsBetween, periodRate, carRate, lateFee, rentalExtras, openPeriods, renew, renewDue, restart, kmReading, addCharge, dashboardChoferes };
