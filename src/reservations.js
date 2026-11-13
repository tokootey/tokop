'use strict';

const { computeQuote, computeReturnCharges, youngDriverFee } = require('./pricing');
const { categoryAvailability, isVehicleFree, paddedRange } = require('./availability');
const { emit } = require('./webhooks');
const { getSettings, proOn } = require('./db');
const { refundFor } = require('./refunds');
const { fail, normDateTime, nowLocal, round2, tx, parseLocal, fmtLocal } = require('./util');
const { placeSql, saveHotel, hotelMissing, normalizeHotel, withHotelExtra } = require('./hotel');
const choferes = require('./choferes');

const STATUSES = ['pendiente', 'confirmada', 'en_curso', 'finalizada', 'cancelada', 'no_show'];
// Para los mensajes de error: "Una reserva cancelada no puede pasar a confirmada".
const STATUS_TEXT = { pendiente: 'pendiente', confirmada: 'confirmada', en_curso: 'en curso', finalizada: 'finalizada', cancelada: 'cancelada', no_show: 'marcada como no show' };

function log(db, reservationId, userId, action, detail) {
  db.prepare('INSERT INTO reservation_log (reservation_id, user_id, action, detail) VALUES (?, ?, ?, ?)').run(
    reservationId,
    userId || null,
    action,
    detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null,
  );
}

function getReservation(db, id) {
  const r = db
    .prepare(
      `SELECT r.*, c.full_name AS customer_name, c.doc_number AS customer_doc, c.email AS customer_email, c.phone AS customer_phone,
              c.doc_type AS customer_doc_type, c.address AS customer_address, c.birth_date AS customer_birth_date,
              c.license_number AS customer_license, c.license_expiry AS customer_license_expiry, c.license_class AS customer_license_class,
              c.work_apps AS customer_work_apps, c.workplace AS customer_workplace, c.alt_contact AS customer_alt_contact, c.guarantor_name, c.guarantor_doc, c.guarantor_phone, c.guarantor_address,
              cat.code AS category_code, cat.name AS category_name, cat.km_per_day AS category_km_per_day, cat.extra_km_rate AS category_extra_km_rate, cat.km_per_period AS category_km_per_period,
              v.plate AS vehicle_plate, v.brand AS vehicle_brand, v.model AS vehicle_model, v.color AS vehicle_color, v.year AS vehicle_year,
              v.km AS vehicle_km, v.fuel AS vehicle_fuel, v.panapass AS vehicle_panapass,
              ${placeSql('deliver', 'pb')} AS pickup_branch_name, ${placeSql('return', 'rb')} AS return_branch_name
       FROM reservations r
       JOIN customers c ON c.id = r.customer_id
       JOIN categories cat ON cat.id = r.category_id
       LEFT JOIN vehicles v ON v.id = r.vehicle_id
       LEFT JOIN branches pb ON pb.id = r.pickup_branch_id
       LEFT JOIN branches rb ON rb.id = r.return_branch_id
       WHERE r.id = ? OR r.code = ?`,
    )
    .get(Number(id) || 0, String(id));
  if (!r) return null;
  r.pricing = r.pricing ? JSON.parse(r.pricing) : null;
  r.hotel = r.hotel ? JSON.parse(r.hotel) : null;
  r.holder = r.holder ? JSON.parse(r.holder) : null;
  r.drivers = r.drivers ? JSON.parse(r.drivers) : [];
  r.hotel_missing = hotelMissing(r.hotel);
  r.extras = db
    .prepare('SELECT re.extra_id, re.quantity, e.name, e.kind, e.deductible FROM reservation_extras re JOIN extras e ON e.id = re.extra_id WHERE re.reservation_id = ?')
    .all(r.id);
  r.contract = db.prepare('SELECT * FROM contracts WHERE reservation_id = ?').get(r.id) || null;
  if (r.contract) {
    r.contract.damages = r.contract.damages ? JSON.parse(r.contract.damages) : null;
    r.contract.charges = r.contract.charges ? JSON.parse(r.contract.charges) : null;
  }
  r.payments = db.prepare('SELECT * FROM payments WHERE reservation_id = ? ORDER BY created_at, id').all(r.id);
  r.files = db
    .prepare(
      `SELECT f.id, f.stage, f.name, f.mime, f.size, f.created_at, u.name AS user_name
       FROM reservation_files f LEFT JOIN users u ON u.id = f.created_by WHERE f.reservation_id = ? ORDER BY f.id`,
    )
    .all(r.id);
  Object.assign(r, choferes.rentalExtras(db, r));
  r.balance = balance(r);
  r.log = db
    .prepare('SELECT l.*, u.name AS user_name FROM reservation_log l LEFT JOIN users u ON u.id = l.user_id WHERE reservation_id = ? ORDER BY l.id')
    .all(r.id);
  return r;
}

/**
 * Saldo pendiente: total final (o total de la reserva) menos pagos netos. Los depósitos en garantía van aparte.
 * Modo choferes: se suman las multas, los km extra y el recargo por atraso (en turismo no hay).
 */
function balance(r) {
  const extra = (r.charges || []).reduce((a, c) => a + c.amount, 0) + (r.late_fee ? r.late_fee.total : 0);
  const due = (r.contract && r.contract.final_total !== null && r.contract.final_total !== undefined ? r.contract.final_total : r.total) + extra;
  let paid = 0;
  let deposit = 0;
  for (const p of r.payments) {
    if (p.kind === 'pago') paid += p.amount;
    else if (p.kind === 'devolucion') paid -= p.amount;
    else if (p.kind === 'garantia') deposit += p.amount;
    else if (p.kind === 'devolucion_garantia') deposit -= p.amount;
  }
  return { due: round2(due), paid: round2(paid), pending: round2(due - paid), deposit_held: round2(deposit) };
}

function nextCode(db, prefix) {
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const table = prefix === 'R' ? 'reservations' : 'contracts';
  const col = prefix === 'R' ? 'code' : 'number';
  const row = db.prepare(`SELECT ${col} AS c FROM ${table} WHERE ${col} LIKE ? ORDER BY id DESC LIMIT 1`).get(like);
  const n = row ? Number(row.c.split('-').pop()) + 1 : 1;
  return `${prefix}-${year}-${String(n).padStart(5, '0')}`;
}

function normalizeInput(input) {
  const pickup_at = normDateTime(input.pickup_at);
  const return_at = normDateTime(input.return_at);
  if (!pickup_at || !return_at) fail(400, 'Fechas de retiro y devolución obligatorias');
  if (return_at <= pickup_at) fail(400, 'La devolución debe ser posterior al retiro');
  return { ...input, pickup_at, return_at };
}

function assertAvailability(db, data, excludeId = 0) {
  const cat = categoryAvailability(db, { ...data, exclude_reservation_id: excludeId }).find((c) => c.id === Number(data.category_id));
  if (!cat) fail(400, 'Categoría inexistente o inactiva');
  if (cat.available <= 0 && !data.allow_overbooking) {
    fail(409, `Sin disponibilidad en la categoría ${cat.name} para esas fechas`);
  }
  if (data.vehicle_id && !isVehicleFree(db, { ...data, exclude_reservation_id: excludeId })) {
    fail(409, 'El vehículo seleccionado no está disponible en esas fechas');
  }
  if (data.vehicle_id) {
    const v = db.prepare('SELECT category_id FROM vehicles WHERE id = ?').get(data.vehicle_id);
    if (!v) fail(400, 'Vehículo inexistente');
    if (v.category_id !== Number(data.category_id)) fail(400, 'El vehículo no pertenece a la categoría de la reserva');
  }
}

/** Conductor menor (con recargo cargado): lleva sí o sí el seguro de menor franquicia, en lugar del que tenga elegido. */
function withYoungInsurance(db, data) {
  if (!youngDriverFee(db, getSettings(db), data)) return data.extras;
  const best = db.prepare("SELECT id FROM extras WHERE kind = 'seguro' AND active = 1 ORDER BY COALESCE(deductible, 0), price DESC LIMIT 1").get();
  if (!best) return data.extras;
  const insurances = new Set(db.prepare("SELECT id FROM extras WHERE kind = 'seguro'").all().map((x) => x.id));
  return [...(data.extras || []).filter((e) => !insurances.has(Number(e.extra_id))), { extra_id: best.id, quantity: 1 }];
}

/**
 * Crea una reserva. Si `price_override` viene definido (por ejemplo, el total que ya cotizó
 * el cotizador externo) se respeta ese total en lugar del calculado.
 */
function createReservation(db, input, userId) {
  const data = normalizeInput(input);
  if (!data.customer_id) fail(400, 'Cliente obligatorio');
  const customer = db.prepare('SELECT blocked_reason FROM customers WHERE id = ?').get(data.customer_id);
  if (!customer) fail(400, 'Cliente inexistente');
  // Cliente bloqueado: el motivo lo ve la agencia; a quien reserva por la web no se le muestra.
  const blocked = String(customer.blocked_reason || '').trim();
  if (blocked) fail(409, userId ? `Este cliente está bloqueado: ${blocked}` : 'No pudimos tomar tu reserva por acá. Escribinos y la vemos.');
  if (!data.category_id) fail(400, 'Categoría obligatoria');
  const status = data.status && ['pendiente', 'confirmada'].includes(data.status) ? data.status : 'pendiente';
  // Entrega en hotel: se suma sola su tarifa (adicional "Entrega en hotel"), si la agencia le puso precio.
  if (normalizeHotel(data.hotel)) data.extras = withHotelExtra(db, data.extras, true);
  data.extras = withYoungInsurance(db, data);

  const id = tx(db, () => {
    assertAvailability(db, data);
    const quote = computeQuote(db, { ...data, dynamic_pct: undefined });
    let pricing = quote;
    let total = quote.total;
    if (data.price_override !== undefined && data.price_override !== null && data.price_override !== '') {
      total = round2(data.price_override);
      pricing = { ...quote, source: data.source || 'externo', calculated_total: quote.total, total };
    }
    const code = nextCode(db, 'R');
    const res = db
      .prepare(
        `INSERT INTO reservations (code, customer_id, category_id, vehicle_id, pickup_branch_id, return_branch_id, pickup_at, return_at,
          status, source, external_id, days, pricing, total, deposit, discount_pct, discount_amount, flight, notes, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        code,
        data.customer_id,
        data.category_id,
        data.vehicle_id || null,
        data.pickup_branch_id || null,
        data.return_branch_id || data.pickup_branch_id || null,
        data.pickup_at,
        data.return_at,
        status,
        data.source || 'manual',
        data.external_id ? String(data.external_id) : null,
        quote.days,
        JSON.stringify(pricing),
        total,
        quote.deposit,
        quote.discount_pct,
        quote.discount_amount,
        data.flight || null,
        data.notes || null,
        userId || null,
        nowLocal(),
      );
    const rid = Number(res.lastInsertRowid);
    const insExtra = db.prepare('INSERT INTO reservation_extras (reservation_id, extra_id, quantity) VALUES (?, ?, ?)');
    for (const e of data.extras || []) insExtra.run(rid, e.extra_id, Math.max(1, Number(e.quantity) || 1));
    log(db, rid, userId, 'creada', { status, source: data.source || 'manual' });
    if (data.hotel) saveHotel(db, rid, data.hotel, userId, log);
    return rid;
  });
  const r = getReservation(db, id);
  emit(db, 'reservation.created', publicView(r));
  return r;
}

function updateReservation(db, id, input, userId) {
  const current = getReservation(db, id);
  if (!current) fail(404, 'Reserva inexistente');
  if (!['pendiente', 'confirmada'].includes(current.status)) fail(409, 'Sólo se pueden modificar reservas pendientes o confirmadas');
  const merged = {
    customer_id: current.customer_id,
    category_id: current.category_id,
    vehicle_id: current.vehicle_id,
    pickup_branch_id: current.pickup_branch_id,
    return_branch_id: current.return_branch_id,
    pickup_at: current.pickup_at,
    return_at: current.return_at,
    discount_pct: current.discount_pct,
    discount_amount: current.discount_amount,
    flight: current.flight,
    notes: current.notes,
    extras: current.extras,
    ...input,
  };
  const data = normalizeInput(merged);
  data.extras = withYoungInsurance(db, data);
  tx(db, () => {
    assertAvailability(db, data, current.id);
    const sameTrip = data.pickup_at === current.pickup_at && data.return_at === current.return_at && Number(data.category_id) === current.category_id;
    const quote = computeQuote(db, { ...data, exclude_reservation_id: current.id, dynamic_pct: sameTrip ? (current.pricing && current.pricing.dynamic_pct) || 0 : undefined });
    const agreed = input.price_override;
    const hasAgreed = agreed !== undefined && agreed !== null && agreed !== '';
    if (hasAgreed && !(Number(agreed) >= 0)) fail(400, 'El precio final tiene que ser un número mayor o igual a 0');
    const keepExternalPrice = current.pricing && current.pricing.calculated_total !== undefined && input.recalculate !== true;
    const total = hasAgreed ? round2(agreed) : keepExternalPrice ? current.total : quote.total;
    const pricing = hasAgreed
      ? { ...quote, source: 'acordado', calculated_total: quote.total, total }
      : keepExternalPrice
        ? { ...quote, source: current.pricing.source, calculated_total: quote.total, total }
        : quote;
    db.prepare(
      `UPDATE reservations SET customer_id=?, category_id=?, vehicle_id=?, pickup_branch_id=?, return_branch_id=?, pickup_at=?, return_at=?,
        days=?, pricing=?, total=?, deposit=?, discount_pct=?, discount_amount=?, flight=?, notes=?, updated_at=? WHERE id=?`,
    ).run(
      data.customer_id,
      data.category_id,
      data.vehicle_id || null,
      data.pickup_branch_id || null,
      data.return_branch_id || null,
      data.pickup_at,
      data.return_at,
      quote.days,
      JSON.stringify(pricing),
      total,
      quote.deposit,
      quote.discount_pct,
      quote.discount_amount,
      data.flight || null,
      data.notes || null,
      nowLocal(),
      current.id,
    );
    if (input.extras) {
      db.prepare('DELETE FROM reservation_extras WHERE reservation_id = ?').run(current.id);
      const ins = db.prepare('INSERT INTO reservation_extras (reservation_id, extra_id, quantity) VALUES (?, ?, ?)');
      for (const e of input.extras) ins.run(current.id, e.extra_id, Math.max(1, Number(e.quantity) || 1));
    }
    log(db, current.id, userId, 'modificada', hasAgreed ? { precio_final: total, antes: current.total } : undefined);
  });
  const r = getReservation(db, current.id);
  emit(db, 'reservation.updated', publicView(r));
  return r;
}

function changeStatus(db, id, status, userId, detail) {
  const r = getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  const allowed = {
    confirmada: ['pendiente'],
    cancelada: ['pendiente', 'confirmada'],
    no_show: ['pendiente', 'confirmada'],
    pendiente: ['cancelada', 'no_show'],
  };
  if (!allowed[status] || !allowed[status].includes(r.status)) fail(409, `Una reserva ${STATUS_TEXT[r.status] || r.status} no puede pasar a ${STATUS_TEXT[status] || status}`);
  // "No se presentó" recién tiene sentido cuando pasó la hora de retiro; antes, es una cancelación.
  if (status === 'no_show' && r.pickup_at > nowLocal()) fail(409, 'Todavía no llegó la hora de retiro: si el cliente avisó que no viene, cancelá la reserva');
  if (status === 'pendiente') assertAvailability(db, r, r.id);
  db.prepare('UPDATE reservations SET status = ?, updated_at = ? WHERE id = ?').run(status, nowLocal(), r.id);
  log(db, r.id, userId, status, detail);
  // Al cancelar (o si no se presentó) queda registrado cuánto corresponde devolver según la política de la empresa.
  let refund = null;
  if (status === 'cancelada' || status === 'no_show') {
    refund = refundFor(r, getSettings(db), new Date(), status);
    log(db, r.id, userId, 'devolucion_calculada', { porcentaje: refund.percent, devolver: refund.amount, pagado: refund.paid, regla: refund.rule });
  }
  const updated = getReservation(db, r.id);
  if (refund) updated.refund = refund;
  const event = { confirmada: 'reservation.confirmed', cancelada: 'reservation.cancelled', no_show: 'reservation.no_show', pendiente: 'reservation.reopened' };
  emit(db, event[status], publicView(updated));
  return updated;
}

function assignVehicle(db, id, vehicleId, userId) {
  const r = getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  if (!['pendiente', 'confirmada'].includes(r.status)) fail(409, 'Sólo se asigna vehículo a reservas pendientes o confirmadas');
  const v = vehicleId ? db.prepare('SELECT plate, category_id FROM vehicles WHERE id = ?').get(vehicleId) : null;
  if (vehicleId && !v) fail(400, 'Vehículo inexistente');
  const otherCategory = v && v.category_id !== r.category_id && proOn(db);
  if (otherCategory) {
    if (!isVehicleFree(db, { ...r, vehicle_id: Number(vehicleId), exclude_reservation_id: r.id })) fail(409, 'El vehículo seleccionado no está disponible en esas fechas');
    // El precio se mantiene: queda como precio acordado, así una modificación posterior tampoco lo recalcula.
    const pricing = { ...(r.pricing || {}), source: (r.pricing && r.pricing.calculated_total !== undefined && r.pricing.source) || 'acordado', calculated_total: (r.pricing && r.pricing.calculated_total) ?? r.total, total: r.total };
    db.prepare('UPDATE reservations SET category_id = ?, pricing = ? WHERE id = ?').run(v.category_id, JSON.stringify(pricing), r.id);
  } else if (vehicleId) {
    assertAvailability(db, { ...r, vehicle_id: Number(vehicleId) }, r.id);
  }
  db.prepare('UPDATE reservations SET vehicle_id = ?, updated_at = ? WHERE id = ?').run(vehicleId || null, nowLocal(), r.id);
  log(db, r.id, userId, 'vehiculo_asignado', v ? `${v.plate}${otherCategory ? ' (otra categoría, se mantiene el precio)' : ''}` : 'sin asignar');
  return getReservation(db, r.id);
}

const MOVABLE = ['pendiente', 'confirmada'];
const swapPlate = (db, id) => db.prepare('SELECT plate FROM vehicles WHERE id = ?').get(id).plate;

/** Por qué no se pueden intercambiar los autos de dos reservas (null si se puede). */
function swapProblem(db, a, b) {
  if (a.id === b.id) return 'Elegí otra reserva para intercambiar';
  if (![a, b].every((r) => MOVABLE.includes(r.status))) return 'Sólo se intercambian reservas pendientes o confirmadas: el auto ya entregado no se puede cambiar';
  if (!a.vehicle_id || !b.vehicle_id) return 'Las dos reservas tienen que tener un auto asignado';
  if (a.vehicle_id === b.vehicle_id) return 'Las dos reservas ya usan el mismo auto';
  if (a.category_id !== b.category_id) return 'Sólo se pueden intercambiar autos de la misma categoría';
  const ids = [a.id, b.id];
  if (!isVehicleFree(db, { vehicle_id: b.vehicle_id, pickup_at: a.pickup_at, return_at: a.return_at, exclude_reservation_id: ids })) return `${swapPlate(db, b.vehicle_id)} no está libre en las fechas de ${a.code}`;
  if (!isVehicleFree(db, { vehicle_id: a.vehicle_id, pickup_at: b.pickup_at, return_at: b.return_at, exclude_reservation_id: ids })) return `${swapPlate(db, a.vehicle_id)} no está libre en las fechas de ${b.code}`;
  return null;
}

/** Intercambia los autos de dos reservas; las fechas y los precios no cambian. */
function swapVehicles(db, idA, idB, userId) {
  const a = getReservation(db, idA);
  const b = getReservation(db, idB);
  if (!a || !b) fail(404, 'Reserva inexistente');
  const problem = swapProblem(db, a, b);
  if (problem) fail(409, problem);
  tx(db, () => {
    const set = db.prepare('UPDATE reservations SET vehicle_id = ?, updated_at = ? WHERE id = ?');
    set.run(b.vehicle_id, nowLocal(), a.id);
    set.run(a.vehicle_id, nowLocal(), b.id);
    log(db, a.id, userId, 'vehiculo_intercambiado', `${b.vehicle_plate}, antes en ${b.code}`);
    log(db, b.id, userId, 'vehiculo_intercambiado', `${a.vehicle_plate}, antes en ${a.code}`);
  });
  return getReservation(db, a.id);
}

/** A qué autos se puede mover una reserva: los libres en sus fechas y los ocupados por una sola reserva con la que se puede intercambiar. */
function moveOptions(db, id) {
  const r = getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  const cars = db
    .prepare(
      `SELECT v.id, v.plate, v.brand, v.model, v.km, b.name AS branch_name FROM vehicles v LEFT JOIN branches b ON b.id = v.branch_id
       WHERE v.category_id = ? AND v.status NOT IN ('mantenimiento', 'fuera_servicio') AND v.id <> ? ORDER BY v.plate`,
    )
    .all(r.category_id, r.vehicle_id || 0);
  const [from, to] = paddedRange(db, r.pickup_at, r.return_at);
  const hits = db.prepare(
    `SELECT id FROM reservations WHERE vehicle_id = ? AND status IN ('pendiente', 'confirmada', 'en_curso') AND pickup_at < ? AND return_at > ? AND id <> ?`,
  );
  const free = [];
  const swaps = [];
  for (const car of cars) {
    const hit = hits.all(car.id, to, from, r.id);
    if (!hit.length) free.push(car);
    else if (hit.length === 1) {
      const other = getReservation(db, hit[0].id);
      if (!swapProblem(db, r, other)) swaps.push({ ...car, reservation_id: other.id, code: other.code, customer_name: other.customer_name });
    }
  }
  // Agencias que lo usan: también los autos libres de otras categorías (el precio de la reserva no cambia).
  const others = proOn(db)
    ? db
        .prepare(
          `SELECT v.id, v.plate, v.brand, v.model, v.km, b.name AS branch_name, c.name AS category_name FROM vehicles v JOIN categories c ON c.id = v.category_id
           LEFT JOIN branches b ON b.id = v.branch_id WHERE v.category_id <> ? AND v.status NOT IN ('mantenimiento', 'fuera_servicio') ORDER BY c.daily_rate, v.plate`,
        )
        .all(r.category_id)
        .filter((car) => !hits.all(car.id, to, from, r.id).length)
    : [];
  return { free, swaps, others };
}

// Saldo de Panapass: vacío = no se cargó.
const balanceOf = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (!Number.isFinite(Number(v))) fail(400, 'El saldo de Panapass tiene que ser un número');
  return round2(v);
};

const text = (v, max = 120) => String(v ?? '').trim().slice(0, max);
const MAX_DRIVERS = 5;
const driverOf = (d) => ({ full_name: text(d.full_name), doc_type: text(d.doc_type, 20), doc_number: text(d.doc_number, 40), license_number: text(d.license_number, 40), license_expiry: normDateTime(d.license_expiry) ? normDateTime(d.license_expiry).slice(0, 10) : '' });

/** Titular del contrato (si no es quien maneja) y hasta 5 conductores adicionales. */
function setParties(db, id, input, userId) {
  const r = getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  if (['finalizada', 'cancelada', 'no_show'].includes(r.status)) fail(409, 'La reserva ya terminó: no se cambian el titular ni los conductores');
  const h = input.holder || {};
  const holder = text(h.full_name)
    ? { full_name: text(h.full_name), doc_type: text(h.doc_type, 20), doc_number: text(h.doc_number, 40), phone: text(h.phone, 40), address: text(h.address, 200) }
    : null;
  const drivers = (Array.isArray(input.drivers) ? input.drivers : [])
    .filter((d) => d && text(d.full_name))
    .map(driverOf);
  if (drivers.length > MAX_DRIVERS) fail(400, `Se pueden cargar hasta ${MAX_DRIVERS} conductores adicionales`);
  const expired = drivers.find((d) => d.license_expiry && d.license_expiry < r.return_at.slice(0, 10));
  if (expired) fail(400, `La licencia de ${expired.full_name} vence antes de la devolución`);
  db.prepare('UPDATE reservations SET holder = ?, drivers = ?, updated_at = ? WHERE id = ?').run(holder && JSON.stringify(holder), drivers.length ? JSON.stringify(drivers) : null, nowLocal(), r.id);
  log(db, r.id, userId, 'titular_conductores', `${holder ? `Titular: ${holder.full_name}. ` : ''}${drivers.length} conductor(es) adicional(es)`);
  return getReservation(db, r.id);
}

/** Suma un conductor adicional a la reserva, sin tocar los que ya están. Si se cobra, el cargo lo registra quien llama. */
function addDriver(db, id, input, userId) {
  const r = getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  if (['finalizada', 'cancelada', 'no_show'].includes(r.status)) fail(409, 'La reserva ya terminó: no se le agregan conductores');
  const d = driverOf(input || {});
  if (!d.full_name) fail(400, 'Escribí el nombre y apellido del conductor');
  if (r.drivers.length >= MAX_DRIVERS) fail(400, `Se pueden cargar hasta ${MAX_DRIVERS} conductores adicionales`);
  if (d.license_expiry && d.license_expiry < r.return_at.slice(0, 10)) fail(400, `La licencia de ${d.full_name} vence antes de la devolución`);
  db.prepare('UPDATE reservations SET drivers = ?, updated_at = ? WHERE id = ?').run(JSON.stringify([...r.drivers, d]), nowLocal(), r.id);
  log(db, r.id, userId, 'conductor_adicional', d.full_name);
  return d;
}

/**
 * Extiende un alquiler en curso hasta una nueva fecha de devolución. El auto tiene que estar libre esos días.
 * Con precio del sistema se recalcula todo el alquiler con las tarifas; con precio acordado, los días nuevos valen lo mismo que los del contrato.
 * `extra_amount` (opcional): lo que se cobra por la extensión, si se acordó otro importe.
 */
function extendReservation(db, id, input, userId) {
  const r = getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  if (r.status !== 'en_curso' || r.periods.length) fail(409, 'Solo se extiende un alquiler en curso');
  const return_at = normDateTime(input.return_at);
  if (!return_at || return_at <= r.return_at) fail(400, 'La nueva devolución tiene que ser posterior a la actual');
  if (!isVehicleFree(db, { vehicle_id: r.vehicle_id, pickup_at: r.return_at, return_at, exclude_reservation_id: r.id })) {
    fail(409, 'El auto ya está reservado en esos días: cambiá de auto la otra reserva antes de extender');
  }
  const quote = computeQuote(db, { ...r, return_at, exclude_reservation_id: r.id, dynamic_pct: (r.pricing && r.pricing.dynamic_pct) || 0 });
  const { days } = quote;
  const agreed = r.pricing && r.pricing.calculated_total !== undefined;
  const given = input.extra_amount !== undefined && input.extra_amount !== null && input.extra_amount !== '';
  if (given && !(Number(input.extra_amount) >= 0)) fail(400, 'El importe de la extensión tiene que ser un número mayor o igual a 0');
  const extra = given ? round2(input.extra_amount) : agreed ? round2((days - r.days) * (r.days ? r.total / r.days : 0)) : round2(quote.total - r.total);
  const total = round2(r.total + extra);
  const extensions = [...((r.pricing && r.pricing.extensions) || []), { from: r.return_at, to: return_at, days: days - r.days, amount: extra }];
  const pricing = agreed || given ? { ...quote, source: (agreed && r.pricing.source) || 'acordado', calculated_total: quote.total, total, extensions } : { ...quote, extensions };
  db.prepare('UPDATE reservations SET return_at = ?, days = ?, total = ?, pricing = ?, updated_at = ? WHERE id = ?').run(return_at, days, total, JSON.stringify(pricing), nowLocal(), r.id);
  log(db, r.id, userId, 'extendida', { hasta: return_at, dias: days - r.days, importe: extra });
  const updated = getReservation(db, r.id);
  emit(db, 'reservation.updated', publicView(updated));
  return updated;
}

/** ¿Se puede entregar? Lo comprueba la entrega y también la pre-entrega, para no enterarse recién cuando firma el cliente. */
// Sin estos datos del cliente no se entrega el vehículo (ni se guarda la pre-entrega).
const CUSTOMER_REQUIRED = [
  ['doc_number', 'documento'],
  ['phone', 'teléfono'],
  ['address', 'domicilio'],
  ['birth_date', 'fecha de nacimiento'],
  ['license_expiry', 'vencimiento de la licencia'],
];

function checkoutCheck(db, r, input) {
  if (!['pendiente', 'confirmada'].includes(r.status)) fail(409, 'La reserva no está en condiciones de ser entregada');
  const vehicleId = Number(input.vehicle_id || r.vehicle_id);
  if (!vehicleId) fail(400, 'Asigná un vehículo antes de entregar');
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
  if (!vehicle) fail(400, 'Vehículo inexistente');
  if (vehicle.status === 'alquilado') fail(409, `El vehículo ${vehicle.plate} figura como alquilado`);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(r.customer_id);
  const missing = CUSTOMER_REQUIRED.filter(([f]) => !String(customer[f] || '').trim()).map(([, label]) => label);
  if (missing.length) fail(400, `Completá los datos del cliente antes de entregar. Falta: ${missing.join(', ')}`);
  if (customer.license_expiry && customer.license_expiry < r.return_at.slice(0, 10)) {
    fail(400, 'La licencia del cliente vence antes de la devolución');
  }

  const outKm = input.out_km !== undefined && input.out_km !== '' ? Number(input.out_km) : vehicle.km;
  const outFuel = input.out_fuel !== undefined && input.out_fuel !== '' ? Number(input.out_fuel) : vehicle.fuel;
  if (outKm < vehicle.km) fail(400, `El km de salida no puede ser menor al registrado (${vehicle.km})`);
  if (!(outFuel >= 0 && outFuel <= 8)) fail(400, 'Combustible: valor entre 0 y 8 (octavos)');
  return { vehicleId, outKm, outFuel };
}

/** Entrega del vehículo al cliente (check-out): abre el contrato. */
function checkout(db, id, input, userId) {
  const r = getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  const { vehicleId, outKm, outFuel } = checkoutCheck(db, r, input);
  if (r.express && getSettings(db).express_requires_payment === '1' && r.balance.pending > 0.005) fail(409, `Reserva express: se entrega con todo pago. Falta cobrar ${r.balance.pending}`);
  const outPanapass = balanceOf(input.out_panapass) ?? db.prepare('SELECT panapass FROM vehicles WHERE id = ?').get(vehicleId).panapass;

  tx(db, () => {
    if (vehicleId !== r.vehicle_id) assertAvailability(db, { ...r, vehicle_id: vehicleId }, r.id);
    const number = nextCode(db, 'C');
    db.prepare(
      `INSERT INTO contracts (reservation_id, number, out_at, out_km, out_fuel, out_panapass, out_notes, out_user, damages)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, number, normDateTime(input.out_at) || nowLocal(), outKm, outFuel, outPanapass, input.out_notes || null, userId || null, JSON.stringify({ out: input.damages || [] }));
    db.prepare("UPDATE reservations SET status = 'en_curso', vehicle_id = ?, updated_at = ? WHERE id = ?").run(vehicleId, nowLocal(), r.id);
    if (choferes.isChoferes(getSettings(db))) choferes.openPeriods(db, r, normDateTime(input.out_at) || nowLocal());
    db.prepare("UPDATE vehicles SET status = 'alquilado', km = ?, fuel = ?, panapass = ? WHERE id = ?").run(outKm, outFuel, outPanapass, vehicleId);
    log(db, r.id, userId, 'entregado', { contrato: number, km: outKm, combustible: outFuel });
  });
  const updated = getReservation(db, r.id);
  emit(db, 'reservation.checked_out', publicView(updated));
  return updated;
}

/**
 * Agencias con las funciones a pedido: quien entrega o recibe el auto carga el km y el combustible, y tiene que haber
 * al menos una foto de esa etapa (subida recién o antes por el auxiliar). Se pide en las rutas del panel, no en `checkout`,
 * que también corre solo cuando el cliente firma una pre-entrega.
 */
function requireHandover(db, id, stage, input) {
  if (!proOn(db)) return;
  const blank = (v) => v === undefined || v === null || v === '';
  const [km, fuel] = stage === 'entrega' ? ['out_km', 'out_fuel'] : ['in_km', 'in_fuel'];
  if (blank((input || {})[km]) || blank((input || {})[fuel])) fail(400, 'Cargá el kilometraje y el combustible del auto');
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM reservation_files WHERE reservation_id = ? AND stage = ? AND mime LIKE 'image/%'").get(Number(id), stage);
  if (!n) fail(400, `Faltan las fotos del auto: subí al menos una de la ${stage === 'entrega' ? 'entrega' : 'devolución'}`);
}

/** Los datos de una devolución, revisados: reserva con contrato abierto, km no menor al de salida y combustible entre 0 y 8. */
function checkinInput(db, id, input) {
  const r = getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  if (r.status !== 'en_curso' || !r.contract) fail(409, 'La reserva no tiene un contrato abierto');
  const inKm = Number(input.in_km);
  if (!(inKm >= r.contract.out_km)) fail(400, `El km de devolución debe ser mayor o igual al de salida (${r.contract.out_km})`);
  const inFuel = Number(input.in_fuel);
  if (!(inFuel >= 0 && inFuel <= 8)) fail(400, 'Combustible: valor entre 0 y 8 (octavos)');
  return { r, inKm, inFuel, inAt: normDateTime(input.in_at) || nowLocal() };
}

/** Antes de cerrar la devolución: km recorridos, km de más, combustible faltante y los cargos que saldrían. No guarda nada. */
function checkinPreview(db, id, input) {
  const { r, inKm, inFuel, inAt } = checkinInput(db, id, input);
  return computeReturnCharges(db, r, r.contract, { ...input, in_km: inKm, in_fuel: inFuel, in_at: inAt }, { byPeriods: r.periods.length > 0 });
}

/** Devolución del vehículo (check-in): cierra el contrato y calcula cargos adicionales. */
function checkin(db, id, input, userId) {
  const checked = checkinInput(db, id, input);
  const { inKm, inFuel, inAt } = checked;
  let { r } = checked;
  // Choferes: el período en que lo devuelve se cobra entero, y los km se controlan contra los de todos los períodos.
  const byPeriods = r.periods.length > 0;
  if (byPeriods) {
    // Con la misma tolerancia de horas que el alquiler por días: devolverlo un rato tarde no abre otra semana.
    const grace = Number(getSettings(db).grace_hours) || 0;
    choferes.renew(db, r.id, fmtLocal(new Date(parseLocal(inAt).getTime() - grace * 3600000)), userId);
    choferes.kmReading(db, r, inKm, userId);
    r = getReservation(db, r.id);
  }
  const charges = computeReturnCharges(db, r, r.contract, { ...input, in_km: inKm, in_fuel: inFuel, in_at: inAt }, { byPeriods });
  const finalTotal = round2(r.total + charges.total);
  const inPanapass = balanceOf(input.in_panapass);
  const returnBranch = input.return_branch_id || r.return_branch_id || r.pickup_branch_id;

  tx(db, () => {
    const damages = { ...(r.contract.damages || {}), in: input.damages || [] };
    db.prepare(
      `UPDATE contracts SET in_at=?, in_km=?, in_fuel=?, in_panapass=?, in_notes=?, in_user=?, damages=?, charges=?, final_total=? WHERE id=?`,
    ).run(inAt, inKm, inFuel, inPanapass, input.in_notes || null, userId || null, JSON.stringify(damages), JSON.stringify(charges), finalTotal, r.contract.id);
    db.prepare("UPDATE reservations SET status = 'finalizada', return_branch_id = ?, updated_at = ? WHERE id = ?").run(returnBranch, nowLocal(), r.id);
    const nextStatus = input.send_to_maintenance ? 'mantenimiento' : 'disponible';
    db.prepare('UPDATE vehicles SET status = ?, km = ?, fuel = ?, branch_id = ?, panapass = COALESCE(?, panapass) WHERE id = ?').run(nextStatus, inKm, inFuel, returnBranch, inPanapass, r.vehicle_id);
    if (input.send_to_maintenance) {
      db.prepare("INSERT INTO maintenance (vehicle_id, kind, description, start_date, km, status) VALUES (?, 'reparacion', ?, ?, ?, 'abierto')").run(
        r.vehicle_id,
        input.in_notes || `Ingreso a taller tras devolución ${r.code}`,
        inAt.slice(0, 10),
        inKm,
      );
    }
    log(db, r.id, userId, 'devuelto', { km: inKm, combustible: inFuel, cargos: charges.total });
  });
  let updated = getReservation(db, r.id);
  // Agencias con contratos pendientes: con saldo sin cobrar, o si el operador lo deja pendiente (daños, faltantes), el contrato no se cierra todavía.
  const note = String(input.pending_note || '').trim().slice(0, 300);
  // Días o km de más: queda en suspenso aunque no generen cargo (por ejemplo, sin tarifa de km excedente), hasta que la agencia lo resuelva.
  const over = [charges.late_days > 0 && 'Días de más', charges.km_excess > 0 && 'Km de más'].filter(Boolean).join(' y ');
  const why = note || (updated.balance.pending > 0.005 ? 'Saldo sin cobrar' : over);
  const pending = proOn(db) && Boolean(why);
  db.prepare('UPDATE contracts SET closed_at = ?, pending_note = ? WHERE id = ?').run(pending ? null : inAt, pending ? why : null, r.contract.id);
  if (pending) log(db, r.id, userId, 'contrato_pendiente', why);
  updated = getReservation(db, r.id);
  emit(db, 'reservation.checked_in', publicView(updated));
  return updated;
}

/** Nota suelta en el historial de la reserva (por ejemplo, la del auxiliar de flota al entregar o recibir el auto). */
function addNote(db, id, input, userId) {
  if (!db.prepare('SELECT 1 FROM reservations WHERE id = ?').get(id)) fail(404, 'Reserva inexistente');
  const note = String((input && input.note) || '').trim().slice(0, 500);
  if (!note) fail(400, 'Escribí la nota');
  log(db, Number(id), userId, 'nota', note);
  return { ok: true };
}

/** Cierra un contrato que quedó pendiente después de la devolución. Con saldo o cargos sin cobrar no se puede. */
function closeContract(db, id, userId) {
  const r = getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  if (!r.contract || !r.contract.in_at) fail(409, 'El auto todavía no fue devuelto');
  if (r.contract.closed_at) fail(409, 'El contrato ya está cerrado');
  if (r.balance.pending > 0.005) fail(409, `No se puede cerrar el contrato: hay ${r.balance.pending} sin cobrar. Cobralo o corregí los cargos primero.`);
  db.prepare('UPDATE contracts SET closed_at = ?, pending_note = NULL WHERE id = ?').run(nowLocal(), r.contract.id);
  log(db, r.id, userId, 'contrato_cerrado');
  return getReservation(db, r.id);
}

function addPayment(db, id, input, userId) {
  const r = getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  const amount = Number(input.amount);
  if (!(amount > 0)) fail(400, 'Importe inválido');
  const kind = ['pago', 'devolucion', 'garantia', 'devolucion_garantia'].includes(input.kind) ? input.kind : 'pago';
  const notes = input.notes ? String(input.notes).trim().slice(0, 500) : null;
  db.prepare('INSERT INTO payments (reservation_id, kind, method, amount, reference, created_by, notes, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    r.id,
    kind,
    input.method || 'efectivo',
    round2(amount),
    input.reference || null,
    userId || null,
    notes,
    Number(input.branch_id) || r.pickup_branch_id || null,
  );
  // Recargo de PayPal: se anota aparte, entra a caja y no descuenta de la deuda.
  const pct = Number(getSettings(db).paypal_surcharge_pct) || 0;
  if (kind === 'pago' && input.method === 'paypal' && pct > 0) {
    db.prepare("INSERT INTO payments (reservation_id, kind, method, amount, created_by, notes, branch_id) VALUES (?, 'recargo', 'paypal', ?, ?, ?, ?)").run(
      r.id,
      round2((amount * pct) / 100),
      userId || null,
      `Recargo PayPal ${pct}%`,
      Number(input.branch_id) || r.pickup_branch_id || null,
    );
  }
  // Pagó con un repuesto o un arreglo del auto: cuenta como pago y también como gasto del auto (la plata no entró a caja).
  if (kind === 'pago' && input.method === 'repuesto' && r.vehicle_id) {
    db.prepare("INSERT INTO expenses (vehicle_id, date, kind, description, amount) VALUES (?, ?, 'repuestos', ?, ?)").run(
      r.vehicle_id,
      nowLocal().slice(0, 10),
      `${notes || 'Repuesto o arreglo'} (lo pagó el chofer, ${r.code})`,
      round2(amount),
    );
  }
  log(db, r.id, userId, kind, `${input.method || 'efectivo'} ${round2(amount)}`);
  let updated = getReservation(db, r.id);
  emit(db, 'reservation.payment', publicView(updated));
  // Reserva pendiente que queda paga entera: se confirma sola. Una seña o la garantía no alcanzan.
  if (updated.status === 'pendiente' && kind === 'pago' && updated.balance.pending <= 0.005) updated = changeStatus(db, r.id, 'confirmada', userId, 'pago completo');
  return updated;
}

/** Vista reducida que se expone a sistemas externos (cotizador / webhooks). */
function publicView(r) {
  if (!r) return null;
  return {
    id: r.id,
    code: r.code,
    external_id: r.external_id,
    source: r.source,
    status: r.status,
    customer: { name: r.customer_name, doc_number: r.customer_doc, email: r.customer_email, phone: r.customer_phone },
    category: { code: r.category_code, name: r.category_name },
    vehicle: r.vehicle_plate ? { plate: r.vehicle_plate, brand: r.vehicle_brand, model: r.vehicle_model } : null,
    pickup: { at: r.pickup_at, branch: r.pickup_branch_name },
    return: { at: r.return_at, branch: r.return_branch_name },
    days: r.days,
    total: r.total,
    final_total: r.contract ? r.contract.final_total : null,
    balance: r.balance,
  };
}

module.exports = {
  balanceOf,
  driverOf,
  addDriver,
  STATUSES,
  getReservation,
  createReservation,
  updateReservation,
  changeStatus,
  assignVehicle,
  swapVehicles,
  moveOptions,
  setParties,
  extendReservation,
  addNote,
  checkoutCheck,
  requireHandover,
  checkout,
  checkin,
  checkinPreview,
  closeContract,
  addPayment,
  publicView,
  nextCode,
  log,
};
