'use strict';

const { computeQuote, computeReturnCharges } = require('./pricing');
const { categoryAvailability, isVehicleFree } = require('./availability');
const { emit } = require('./webhooks');
const { fail, normDateTime, nowLocal, round2, tx } = require('./util');

const STATUSES = ['pendiente', 'confirmada', 'en_curso', 'finalizada', 'cancelada', 'no_show'];

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
              c.license_number AS customer_license, c.license_expiry AS customer_license_expiry,
              cat.code AS category_code, cat.name AS category_name, cat.km_per_day AS category_km_per_day, cat.extra_km_rate AS category_extra_km_rate,
              v.plate AS vehicle_plate, v.brand AS vehicle_brand, v.model AS vehicle_model, v.color AS vehicle_color, v.year AS vehicle_year,
              v.km AS vehicle_km, v.fuel AS vehicle_fuel,
              pb.name AS pickup_branch_name, rb.name AS return_branch_name
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
  r.extras = db
    .prepare('SELECT re.extra_id, re.quantity, e.name FROM reservation_extras re JOIN extras e ON e.id = re.extra_id WHERE re.reservation_id = ?')
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
  r.balance = balance(r);
  r.log = db
    .prepare('SELECT l.*, u.name AS user_name FROM reservation_log l LEFT JOIN users u ON u.id = l.user_id WHERE reservation_id = ? ORDER BY l.id')
    .all(r.id);
  return r;
}

/** Saldo pendiente: total final (o total de la reserva) menos pagos netos. Los depósitos en garantía van aparte. */
function balance(r) {
  const due = r.contract && r.contract.final_total !== null && r.contract.final_total !== undefined ? r.contract.final_total : r.total;
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

/**
 * Crea una reserva. Si `price_override` viene definido (por ejemplo, el total que ya cotizó
 * el cotizador externo) se respeta ese total en lugar del calculado.
 */
function createReservation(db, input, userId) {
  const data = normalizeInput(input);
  if (!data.customer_id) fail(400, 'Cliente obligatorio');
  if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(data.customer_id)) fail(400, 'Cliente inexistente');
  if (!data.category_id) fail(400, 'Categoría obligatoria');
  const status = data.status && ['pendiente', 'confirmada'].includes(data.status) ? data.status : 'pendiente';

  const id = tx(db, () => {
    assertAvailability(db, data);
    const quote = computeQuote(db, data);
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
          status, source, external_id, days, pricing, total, deposit, discount_pct, flight, notes, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        data.flight || null,
        data.notes || null,
        userId || null,
        nowLocal(),
      );
    const rid = Number(res.lastInsertRowid);
    const insExtra = db.prepare('INSERT INTO reservation_extras (reservation_id, extra_id, quantity) VALUES (?, ?, ?)');
    for (const e of data.extras || []) insExtra.run(rid, e.extra_id, Math.max(1, Number(e.quantity) || 1));
    log(db, rid, userId, 'creada', { status, source: data.source || 'manual' });
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
    flight: current.flight,
    notes: current.notes,
    extras: current.extras,
    ...input,
  };
  const data = normalizeInput(merged);
  tx(db, () => {
    assertAvailability(db, data, current.id);
    const quote = computeQuote(db, data);
    const keepExternalPrice = current.pricing && current.pricing.calculated_total !== undefined && input.recalculate !== true;
    const total = keepExternalPrice ? current.total : quote.total;
    const pricing = keepExternalPrice ? { ...quote, source: current.pricing.source, calculated_total: quote.total, total } : quote;
    db.prepare(
      `UPDATE reservations SET customer_id=?, category_id=?, vehicle_id=?, pickup_branch_id=?, return_branch_id=?, pickup_at=?, return_at=?,
        days=?, pricing=?, total=?, deposit=?, discount_pct=?, flight=?, notes=?, updated_at=? WHERE id=?`,
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
    log(db, current.id, userId, 'modificada');
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
  if (!allowed[status] || !allowed[status].includes(r.status)) fail(409, `No se puede pasar de "${r.status}" a "${status}"`);
  if (status === 'pendiente') assertAvailability(db, r, r.id);
  db.prepare('UPDATE reservations SET status = ?, updated_at = ? WHERE id = ?').run(status, nowLocal(), r.id);
  log(db, r.id, userId, status, detail);
  const updated = getReservation(db, r.id);
  const event = { confirmada: 'reservation.confirmed', cancelada: 'reservation.cancelled', no_show: 'reservation.no_show', pendiente: 'reservation.reopened' };
  emit(db, event[status], publicView(updated));
  return updated;
}

function assignVehicle(db, id, vehicleId, userId) {
  const r = getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  if (!['pendiente', 'confirmada'].includes(r.status)) fail(409, 'Sólo se asigna vehículo a reservas pendientes o confirmadas');
  if (vehicleId) {
    const data = { ...r, vehicle_id: Number(vehicleId) };
    assertAvailability(db, data, r.id);
  }
  db.prepare('UPDATE reservations SET vehicle_id = ?, updated_at = ? WHERE id = ?').run(vehicleId || null, nowLocal(), r.id);
  const v = vehicleId ? db.prepare('SELECT plate FROM vehicles WHERE id = ?').get(vehicleId) : null;
  log(db, r.id, userId, 'vehiculo_asignado', v ? v.plate : 'sin asignar');
  return getReservation(db, r.id);
}

/** Entrega del vehículo al cliente (check-out): abre el contrato. */
function checkout(db, id, input, userId) {
  const r = getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  if (!['pendiente', 'confirmada'].includes(r.status)) fail(409, 'La reserva no está en condiciones de ser entregada');
  const vehicleId = Number(input.vehicle_id || r.vehicle_id);
  if (!vehicleId) fail(400, 'Asigná un vehículo antes de entregar');
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(vehicleId);
  if (!vehicle) fail(400, 'Vehículo inexistente');
  if (vehicle.status === 'alquilado') fail(409, `El vehículo ${vehicle.plate} figura como alquilado`);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(r.customer_id);
  if (!customer.license_number) fail(400, 'Cargá el número de licencia del cliente antes de entregar');
  if (customer.license_expiry && customer.license_expiry < r.return_at.slice(0, 10)) {
    fail(400, 'La licencia del cliente vence antes de la devolución');
  }

  const outKm = input.out_km !== undefined && input.out_km !== '' ? Number(input.out_km) : vehicle.km;
  const outFuel = input.out_fuel !== undefined && input.out_fuel !== '' ? Number(input.out_fuel) : vehicle.fuel;
  if (outKm < vehicle.km) fail(400, `El km de salida no puede ser menor al registrado (${vehicle.km})`);
  if (!(outFuel >= 0 && outFuel <= 8)) fail(400, 'Combustible: valor entre 0 y 8 (octavos)');

  tx(db, () => {
    if (vehicleId !== r.vehicle_id) assertAvailability(db, { ...r, vehicle_id: vehicleId }, r.id);
    const number = nextCode(db, 'C');
    db.prepare(
      `INSERT INTO contracts (reservation_id, number, out_at, out_km, out_fuel, out_notes, out_user, damages)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, number, normDateTime(input.out_at) || nowLocal(), outKm, outFuel, input.out_notes || null, userId || null, JSON.stringify({ out: input.damages || [] }));
    db.prepare("UPDATE reservations SET status = 'en_curso', vehicle_id = ?, updated_at = ? WHERE id = ?").run(vehicleId, nowLocal(), r.id);
    db.prepare("UPDATE vehicles SET status = 'alquilado', km = ?, fuel = ? WHERE id = ?").run(outKm, outFuel, vehicleId);
    log(db, r.id, userId, 'entregado', { contrato: number, km: outKm, combustible: outFuel });
  });
  const updated = getReservation(db, r.id);
  emit(db, 'reservation.checked_out', publicView(updated));
  return updated;
}

/** Devolución del vehículo (check-in): cierra el contrato y calcula cargos adicionales. */
function checkin(db, id, input, userId) {
  const r = getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  if (r.status !== 'en_curso' || !r.contract) fail(409, 'La reserva no tiene un contrato abierto');
  const inKm = Number(input.in_km);
  if (!(inKm >= r.contract.out_km)) fail(400, `El km de devolución debe ser mayor o igual al de salida (${r.contract.out_km})`);
  const inFuel = Number(input.in_fuel);
  if (!(inFuel >= 0 && inFuel <= 8)) fail(400, 'Combustible: valor entre 0 y 8 (octavos)');
  const inAt = normDateTime(input.in_at) || nowLocal();
  const charges = computeReturnCharges(db, r, r.contract, { ...input, in_km: inKm, in_fuel: inFuel, in_at: inAt });
  const finalTotal = round2(r.total + charges.total);
  const returnBranch = input.return_branch_id || r.return_branch_id || r.pickup_branch_id;

  tx(db, () => {
    const damages = { ...(r.contract.damages || {}), in: input.damages || [] };
    db.prepare(
      `UPDATE contracts SET in_at=?, in_km=?, in_fuel=?, in_notes=?, in_user=?, damages=?, charges=?, final_total=? WHERE id=?`,
    ).run(inAt, inKm, inFuel, input.in_notes || null, userId || null, JSON.stringify(damages), JSON.stringify(charges), finalTotal, r.contract.id);
    db.prepare("UPDATE reservations SET status = 'finalizada', return_branch_id = ?, updated_at = ? WHERE id = ?").run(returnBranch, nowLocal(), r.id);
    const nextStatus = input.send_to_maintenance ? 'mantenimiento' : 'disponible';
    db.prepare('UPDATE vehicles SET status = ?, km = ?, fuel = ?, branch_id = ? WHERE id = ?').run(nextStatus, inKm, inFuel, returnBranch, r.vehicle_id);
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
  const updated = getReservation(db, r.id);
  emit(db, 'reservation.checked_in', publicView(updated));
  return updated;
}

function addPayment(db, id, input, userId) {
  const r = getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  const amount = Number(input.amount);
  if (!(amount > 0)) fail(400, 'Importe inválido');
  const kind = ['pago', 'devolucion', 'garantia', 'devolucion_garantia'].includes(input.kind) ? input.kind : 'pago';
  db.prepare('INSERT INTO payments (reservation_id, kind, method, amount, reference, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(
    r.id,
    kind,
    input.method || 'efectivo',
    round2(amount),
    input.reference || null,
    userId || null,
  );
  log(db, r.id, userId, kind, `${input.method || 'efectivo'} ${round2(amount)}`);
  const updated = getReservation(db, r.id);
  emit(db, 'reservation.payment', publicView(updated));
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
  STATUSES,
  getReservation,
  createReservation,
  updateReservation,
  changeStatus,
  assignVehicle,
  checkout,
  checkin,
  addPayment,
  publicView,
};
