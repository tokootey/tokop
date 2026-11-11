'use strict';

const express = require('express');
const { computeQuote } = require('../pricing');
const { categoryAvailability, availableVehicles, BLOCKING } = require('../availability');
const R = require('../reservations');
const { placeSql, saveHotel, withHotelExtra } = require('../hotel');
const invoicing = require('../invoicing/index');
const { getSettings } = require('../db');
const { refundFor } = require('../refunds');
const choferes = require('../choferes');
const { requireAdmin } = require('../auth');
const { chargeInsurance } = require('./catalog');
const delivery = require('../delivery');
const whatsapp = require('../whatsapp');
const reminders = require('../reminders');
const { fail, normDateTime, nowLocal, parseLocal, fmtLocal, toCsv, dmy, hm } = require('../util');

/**
 * Primeros pasos para una empresa que recién empieza a usar el sistema. El Panel los muestra
 * hasta que estén todos hechos.
 */
function setupSteps(db) {
  const count = (sql) => db.prepare(sql).get().n;
  const setting = (k) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value || '';
  const steps = [
    { key: 'empresa', label: 'Cargar el nombre, el país y los datos de la empresa', href: '#/config', done: !['', 'Mi Rent a Car'].includes(setting('company_name')) },
    { key: 'sucursales', label: 'Cargar los lugares de entrega (aeropuerto, oficina, hoteles)', href: '#/tarifas', done: count('SELECT COUNT(*) AS n FROM branches WHERE active = 1') > 0 },
    { key: 'tarifas', label: 'Cargar las categorías con su tarifa diaria', href: '#/tarifas', done: count('SELECT COUNT(*) AS n FROM categories WHERE active = 1 AND daily_rate > 0') > 0 },
    { key: 'flota', label: 'Cargar los autos (o importarlos desde una planilla)', href: '#/flota', done: count('SELECT COUNT(*) AS n FROM vehicles') > 0 },
    { key: 'usuarios', label: 'Crear un usuario para cada persona del equipo', href: '#/usuarios', done: count('SELECT COUNT(*) AS n FROM users WHERE active = 1') > 1 },
    { key: 'contrato', label: 'Revisar las condiciones y la jurisdicción del contrato', href: '#/config', done: setting('jurisdiction') !== '' && setting('deductible_amount') !== '' },
  ];
  return { steps, done: steps.filter((x) => x.done).length, total: steps.length };
}

/** Sucursal elegida en el selector (?branch=3). Solo dígitos: el número va directo en las consultas. */
const branchOf = (req) => (/^\d+$/.test(req.query.branch) ? Number(req.query.branch) : null);

function operationsRoutes(db) {
  const router = express.Router();

  // Modo choferes: antes de mostrar reservas, el panel o el calendario se renuevan los alquileres vencidos.
  router.use((req, _res, next) => {
    if (req.method === 'GET' && /^\/(reservations|dashboard|planning)/.test(req.path)) choferes.renewDue(db);
    next();
  });

  // --- Cotización y disponibilidad (uso interno, mostrador) ---
  router.get('/availability', (req, res) => {
    const pickup_at = normDateTime(req.query.pickup_at);
    const return_at = normDateTime(req.query.return_at);
    if (!pickup_at || !return_at) fail(400, 'Indicá fechas de retiro y devolución');
    const extras = req.query.extras ? String(req.query.extras).split(',').filter(Boolean).map((id) => ({ extra_id: Number(id) })) : [];
    const exclude = Number(req.query.exclude) || 0;
    const result = categoryAvailability(db, { pickup_at, return_at, exclude_reservation_id: exclude }).map((c) => ({
      ...c,
      quote: computeQuote(db, {
        category_id: c.id,
        pickup_at,
        return_at,
        pickup_branch_id: req.query.pickup_branch_id,
        return_branch_id: req.query.return_branch_id,
        extras,
        discount_pct: req.query.discount_pct,
        discount_amount: req.query.discount_amount,
      }),
    }));
    res.json(result);
  });

  router.post('/quote', (req, res) => {
    const pickup_at = normDateTime(req.body.pickup_at);
    const return_at = normDateTime(req.body.return_at);
    if (!pickup_at || !return_at) fail(400, 'Indicá fechas de retiro y devolución');
    res.json(computeQuote(db, { ...req.body, pickup_at, return_at }));
  });

  // --- Reservas ---
  router.get('/reservations', (req, res) => {
    const where = [];
    const params = [];
    const branch = branchOf(req);
    if (branch) where.push(`(r.pickup_branch_id = ${branch} OR r.return_branch_id = ${branch})`);
    if (req.query.status) {
      const list = String(req.query.status).split(',');
      where.push(`r.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (req.query.source) {
      where.push('r.source = ?');
      params.push(req.query.source);
    }
    if (req.query.customer_id) {
      where.push('r.customer_id = ?');
      params.push(req.query.customer_id);
    }
    if (req.query.vehicle_id) {
      where.push('r.vehicle_id = ?');
      params.push(req.query.vehicle_id);
    }
    if (req.query.from) {
      where.push('r.return_at >= ?');
      params.push(normDateTime(req.query.from, '00:00'));
    }
    if (req.query.to) {
      where.push('r.pickup_at <= ?');
      params.push(normDateTime(req.query.to, '23:59'));
    }
    if (req.query.q) {
      where.push('(r.code LIKE ? OR c.full_name LIKE ? OR c.doc_number LIKE ? OR v.plate LIKE ? OR r.external_id LIKE ?)');
      for (let i = 0; i < 5; i++) params.push(`%${req.query.q}%`);
    }
    const rows = db
      .prepare(
        `SELECT r.id, r.code, r.status, r.source, r.external_id, r.pickup_at, r.return_at, r.days, r.total, r.vehicle_id,
                c.full_name AS customer_name, c.phone AS customer_phone, cat.code AS category_code, cat.name AS category_name,
                v.plate AS vehicle_plate, ${placeSql('deliver', 'pb')} AS pickup_branch_name, ${placeSql('return', 'rb')} AS return_branch_name
         FROM reservations r
         JOIN customers c ON c.id = r.customer_id
         JOIN categories cat ON cat.id = r.category_id
         LEFT JOIN vehicles v ON v.id = r.vehicle_id
         LEFT JOIN branches pb ON pb.id = r.pickup_branch_id
         LEFT JOIN branches rb ON rb.id = r.return_branch_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY r.pickup_at DESC LIMIT ?`,
      )
      .all(...params, Math.min(Number(req.query.limit) || 300, 2000));
    res.json(rows);
  });

  router.post('/reservations', (req, res) => {
    const body = { ...req.body };
    delete body.source; // las reservas cargadas a mano son siempre "manual"
    delete body.external_id;
    res.status(201).json(R.createReservation(db, body, req.user.id));
  });

  router.get('/reservations/:id', (req, res) => {
    const r = R.getReservation(db, req.params.id);
    if (!r) fail(404, 'Reserva inexistente');
    res.json({ ...r, invoices: invoicing.listInvoices(db, r.id), signature: delivery.stateOf(db, r) });
  });

  // --- Factura electrónica (sólo prueba) ---
  router.post('/reservations/:id/invoice', async (req, res) => {
    res.status(201).json(await invoicing.emitForReservation(db, Number(req.params.id), req.user.id));
  });
  router.get('/invoices/:id', (req, res) => {
    const inv = invoicing.getInvoice(db, Number(req.params.id));
    if (!inv) fail(404, 'Factura inexistente');
    res.json(inv);
  });

  router.put('/reservations/:id', (req, res) => res.json(R.updateReservation(db, req.params.id, req.body, req.user.id)));
  router.post('/reservations/:id/status', (req, res) => res.json(R.changeStatus(db, req.params.id, req.body.status, req.user.id, req.body.reason)));
  // Cuánto se devolvería si se cancela ahora (para mostrarlo antes de confirmar la cancelación).
  router.get('/reservations/:id/refund', (req, res) => {
    const r = R.getReservation(db, req.params.id);
    if (!r) fail(404, 'Reserva inexistente');
    res.json(refundFor(r, getSettings(db), new Date(), req.query.motivo === 'no_show' ? 'no_show' : 'cancelada'));
  });
  // Datos del hotel (entrega o devolución ahí). Se pueden cambiar hasta que termina el alquiler.
  router.post('/reservations/:id/hotel', (req, res) => {
    const r = R.getReservation(db, req.params.id);
    if (!r) fail(404, 'Reserva inexistente');
    if (['finalizada', 'cancelada', 'no_show'].includes(r.status)) fail(409, 'La reserva ya terminó: no se cambia el hotel');
    const h = saveHotel(db, r.id, req.body, req.user.id, R.log);
    // Antes de entregar el auto, el costo de la entrega en hotel se pone o se saca del precio.
    if (['pendiente', 'confirmada'].includes(r.status)) {
      const before = r.extras.map((e) => e.extra_id).sort().join();
      const extras = withHotelExtra(db, r.extras, h);
      if (extras.map((e) => e.extra_id).sort().join() !== before) R.updateReservation(db, r.id, { extras }, req.user.id);
    }
    res.json(R.getReservation(db, r.id));
  });
  // Firma del contrato, fotos para la entrega express y tarjeta del cliente.
  router.post('/reservations/:id/signature', (req, res) => res.json(delivery.requestSignature(db, req.params.id, (req.body || {}).terms, getSettings(db), req.user.id)));
  router.post('/reservations/:id/photos-link', (req, res) => res.json(delivery.photosLink(db, req.params.id)));
  router.post('/reservations/:id/reminder', async (req, res) => res.json(await reminders.sendOne(db, req.params.id, req.user.id)));
  router.post('/reservations/:id/whatsapp', async (req, res) => {
    const r = R.getReservation(db, req.params.id);
    if (!r) fail(404, 'Reserva inexistente');
    const sent = await whatsapp.send(db, r.customer_phone, req.body && req.body.text);
    R.log(db, r.id, req.user.id, 'whatsapp_enviado', String(req.body.text).slice(0, 300));
    res.json(sent);
  });
  router.post('/reservations/:id/pre-delivery', (req, res) => res.json(delivery.preDeliver(db, req.params.id, req.body || {}, getSettings(db), req.user.id)));
  router.post('/reservations/:id/left-place', (req, res) => res.json(delivery.setLeftPlace(db, req.params.id, (req.body || {}).place, req.user.id)));
  router.post('/reservations/:id/return-link', (req, res) => res.json(delivery.returnLink(db, req.params.id)));
  router.post('/reservations/:id/card-link', (req, res) => res.json(delivery.cardLink(db, req.params.id)));
  router.get('/reservations/:id/move-options', (req, res) => res.json(R.moveOptions(db, req.params.id)));
  router.post('/reservations/:id/swap', (req, res) => res.json(R.swapVehicles(db, req.params.id, req.body.reservation_id, req.user.id)));
  router.post('/reservations/:id/assign', (req, res) => res.json(R.assignVehicle(db, req.params.id, req.body.vehicle_id, req.user.id)));
  router.post('/reservations/:id/checkout', (req, res) => res.json(R.checkout(db, req.params.id, req.body, req.user.id)));
  router.post('/reservations/:id/checkin', (req, res) => res.json(R.checkin(db, req.params.id, req.body, req.user.id)));
  router.post('/reservations/:id/payments', (req, res) => res.json(R.addPayment(db, req.params.id, req.body, req.user.id)));

  // Choferes: multas u otros cargos a cuenta del chofer, y lectura de km (cobra los km extra del período).
  const rentalOf = (id) => {
    const r = R.getReservation(db, id);
    if (!r) fail(404, 'Reserva inexistente');
    return r;
  };
  router.post('/reservations/:id/charges', (req, res) => {
    const r = rentalOf(req.params.id);
    choferes.addCharge(db, r, req.body || {}, req.user.id);
    R.log(db, r.id, req.user.id, 'cargo', `${(req.body || {}).kind === 'otro' ? 'Cargo' : 'Multa'} ${Number(req.body.amount)}`);
    res.json(R.getReservation(db, r.id));
  });
  // Borrar una multa le baja la deuda al chofer: solo administradores.
  router.delete('/reservations/:id/charges/:charge', requireAdmin, (req, res) => {
    const r = rentalOf(req.params.id);
    const c = db.prepare('DELETE FROM rental_charges WHERE id = ? AND reservation_id = ?').run(Number(req.params.charge), r.id);
    if (!c.changes) fail(404, 'Cargo inexistente');
    R.log(db, r.id, req.user.id, 'cargo_borrado', `#${req.params.charge}`);
    res.json(R.getReservation(db, r.id));
  });
  router.put('/reservations/:id/start', requireAdmin, (req, res) => {
    choferes.restart(db, req.params.id, (req.body || {}).start_at, req.user.id);
    res.json(R.getReservation(db, req.params.id));
  });
  router.post('/reservations/:id/km', (req, res) => {
    const r = rentalOf(req.params.id);
    if (r.status !== 'en_curso') fail(409, 'El auto no está alquilado');
    const charge = choferes.kmReading(db, r, (req.body || {}).km, req.user.id);
    R.log(db, r.id, req.user.id, 'lectura_km', { km: Number(req.body.km), excedente: charge ? charge.km : 0 });
    res.json({ ...R.getReservation(db, r.id), km_charge: charge });
  });

  router.get('/reservations/:id/available-vehicles', (req, res) => {
    const r = R.getReservation(db, req.params.id);
    if (!r) fail(404, 'Reserva inexistente');
    res.json(availableVehicles(db, { category_id: r.category_id, pickup_at: r.pickup_at, return_at: r.return_at, exclude_reservation_id: r.id }));
  });

  /**
   * Un auto que sale de circulación (taller) con reservas por delante: se le saca a cada reserva
   * y se le asigna otro libre de la misma categoría, si hay. Las que no consiguen auto quedan sin asignar.
   */
  router.post('/vehicles/:id/release', (req, res) => {
    const vehicleId = Number(req.params.id);
    const ids = (Array.isArray(req.body.reservation_ids) ? req.body.reservation_ids : []).map(Number);
    const out = [];
    for (const id of ids) {
      const r = R.getReservation(db, id);
      if (!r || r.vehicle_id !== vehicleId || !['pendiente', 'confirmada'].includes(r.status)) continue;
      R.assignVehicle(db, r.id, null, req.user.id);
      const other = availableVehicles(db, { category_id: r.category_id, pickup_at: r.pickup_at, return_at: r.return_at, exclude_reservation_id: r.id }).find(
        (v) => v.id !== vehicleId,
      );
      if (other) R.assignVehicle(db, r.id, other.id, req.user.id);
      out.push({ id: r.id, code: r.code, plate: other ? other.plate : null });
    }
    res.json(out);
  });

  router.get('/available-vehicles', (req, res) => {
    const pickup_at = normDateTime(req.query.pickup_at);
    const return_at = normDateTime(req.query.return_at);
    if (!pickup_at || !return_at || !req.query.category_id) fail(400, 'Indicá categoría y fechas');
    res.json(availableVehicles(db, { category_id: Number(req.query.category_id), pickup_at, return_at, exclude_reservation_id: Number(req.query.exclude) || 0 }));
  });

  // --- Alquileres activos: los autos que están en la calle, con su planilla para Excel (?format=csv) ---
  router.get('/rentals/active', (req, res) => {
    const branch = branchOf(req);
    const rows = db
      .prepare(
        `SELECT r.id, r.code, v.plate, c.full_name AS customer_name, COALESCE(ct.out_at, r.pickup_at) AS out_at, r.return_at,
                ${placeSql('deliver', 'pb')} AS pickup_branch_name, ${placeSql('return', 'rb')} AS return_branch_name
         FROM reservations r JOIN customers c ON c.id = r.customer_id
         LEFT JOIN vehicles v ON v.id = r.vehicle_id LEFT JOIN contracts ct ON ct.reservation_id = r.id
         LEFT JOIN branches pb ON pb.id = r.pickup_branch_id LEFT JOIN branches rb ON rb.id = r.return_branch_id
         WHERE r.status = 'en_curso'${branch ? ` AND (r.pickup_branch_id = ${branch} OR r.return_branch_id = ${branch})` : ''}
         ORDER BY r.return_at`,
      )
      .all();
    if (req.query.format !== 'csv') return res.json(rows);
    res.type('text/csv').send(
      toCsv(
        ['Referencia', 'Placa', 'Cliente', 'Salida', 'Hora', 'Devolución prevista'],
        rows.map((r) => [r.code, r.plate, r.customer_name, dmy(r.out_at), hm(r.out_at), `${dmy(r.return_at)} ${hm(r.return_at)}`]),
        req.query.sep === ';' ? ';' : ',',
      ),
    );
  });

  // --- Planning (grilla vehículos x días) ---
  router.get('/planning', (req, res) => {
    const from = (normDateTime(req.query.from, '00:00') || nowLocal()).slice(0, 10) + 'T00:00';
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 62);
    const start = parseLocal(from);
    const to = fmtLocal(new Date(start.getFullYear(), start.getMonth(), start.getDate() + days));
    const vehicles = db
      .prepare(
        `SELECT v.id, v.plate, v.brand, v.model, v.status, v.category_id, v.branch_id, c.code AS category_code, c.name AS category_name
         FROM vehicles v JOIN categories c ON c.id = v.category_id ORDER BY c.daily_rate, c.code, v.plate`,
      )
      .all();
    const reservations = db
      .prepare(
        `SELECT r.id, r.code, r.status, r.source, r.pickup_at, r.return_at, r.total, r.vehicle_id, r.category_id, r.pickup_branch_id, r.return_branch_id, cat.code AS category_code, c.full_name AS customer_name
         FROM reservations r JOIN customers c ON c.id = r.customer_id JOIN categories cat ON cat.id = r.category_id
         WHERE r.status IN (${[...BLOCKING, 'finalizada'].map((s) => `'${s}'`).join(',')}) AND r.pickup_at < ? AND r.return_at > ?
         ORDER BY r.pickup_at`,
      )
      .all(to, from);
    const maintenance = db
      .prepare(`SELECT id, vehicle_id, kind, start_date, end_date FROM maintenance WHERE status = 'abierto' OR (end_date >= ? AND start_date <= ?)`)
      .all(from.slice(0, 10), to.slice(0, 10));
    const branch = branchOf(req);
    if (!branch) return res.json({ from, to, days, vehicles, reservations, maintenance });
    // Con una sucursal elegida: sus autos, más los que salen o vuelven por ella esos días (si no, esa reserva no se vería).
    const here = (r) => r.pickup_branch_id === branch || r.return_branch_id === branch;
    const passing = new Set(reservations.filter(here).map((r) => r.vehicle_id));
    const shown = vehicles.filter((v) => v.branch_id === branch || passing.has(v.id));
    const ids = new Set(shown.map((v) => v.id));
    res.json({ from, to, days, vehicles: shown, reservations: reservations.filter((r) => here(r) || ids.has(r.vehicle_id)), maintenance: maintenance.filter((m) => ids.has(m.vehicle_id)) });
  });

  // --- Panel ---
  router.get('/dashboard', (req, res) => {
    const now = nowLocal();
    const today = now.slice(0, 10);
    chargeInsurance(db, today);
    // Con una sucursal elegida, todo se cuenta solo para ella.
    const branch = branchOf(req);
    const atR = branch ? ` AND (r.pickup_branch_id = ${branch} OR r.return_branch_id = ${branch})` : '';
    const atV = branch ? ` AND v.branch_id = ${branch}` : '';
    const fleet = db.prepare(`SELECT v.status, COUNT(*) AS n FROM vehicles v WHERE 1 = 1${atV} GROUP BY v.status`).all();
    const byStatus = Object.fromEntries(fleet.map((f) => [f.status, f.n]));
    const total = fleet.reduce((a, f) => a + f.n, 0);
    const operational = total - (byStatus.mantenimiento || 0) - (byStatus.fuera_servicio || 0);
    // total y paid: la pantalla Hoy muestra cuánto debe cada cliente.
    // notes y la licencia: antes de confirmar un pedido se muestran sus notas y lo que falta.
    const baseSelect = `SELECT r.id, r.code, r.status, r.source, r.pickup_at, r.return_at, r.total, r.notes, c.full_name AS customer_name, c.phone AS customer_phone,
        c.license_number AS customer_license,
        cat.code AS category_code, cat.name AS category_name, v.plate AS vehicle_plate, v.brand AS vehicle_brand, v.model AS vehicle_model,
        ${placeSql('deliver', 'pb')} AS pickup_branch_name, ${placeSql('return', 'rb')} AS return_branch_name,
        (SELECT COALESCE(SUM(CASE WHEN p.kind = 'pago' THEN p.amount WHEN p.kind = 'devolucion' THEN -p.amount ELSE 0 END), 0) FROM payments p WHERE p.reservation_id = r.id) AS paid
      FROM reservations r JOIN customers c ON c.id = r.customer_id JOIN categories cat ON cat.id = r.category_id
      LEFT JOIN vehicles v ON v.id = r.vehicle_id LEFT JOIN branches pb ON pb.id = r.pickup_branch_id LEFT JOIN branches rb ON rb.id = r.return_branch_id`;
    const month = today.slice(0, 7);
    const FIXED = 'NOT EXISTS (SELECT 1 FROM rental_periods rp WHERE rp.reservation_id = r.id)';
    const t = new Date();
    const tomorrow = fmtLocal(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)).slice(0, 10);
    res.json({
      now,
      fleet: { total, operational, ...byStatus },
      occupancy: operational ? Math.round(((byStatus.alquilado || 0) / operational) * 100) : 0,
      pickups_today: db.prepare(`${baseSelect} WHERE r.status IN ('pendiente','confirmada') AND substr(r.pickup_at,1,10) = ?${atR} ORDER BY r.pickup_at`).all(today),
      // Choferes: el alquiler es por tiempo indeterminado (se renueva solo); su fin de período no es una devolución.
      returns_today: db.prepare(`${baseSelect} WHERE r.status = 'en_curso' AND substr(r.return_at,1,10) = ? AND ${FIXED}${atR} ORDER BY r.return_at`).all(today),
      overdue: db.prepare(`${baseSelect} WHERE r.status = 'en_curso' AND r.return_at < ? AND ${FIXED}${atR} ORDER BY r.return_at`).all(now),
      late_pickups: db.prepare(`${baseSelect} WHERE r.status IN ('pendiente','confirmada') AND substr(r.pickup_at,1,10) < ?${atR} ORDER BY r.pickup_at`).all(today),
      pending_confirmation: db.prepare(`SELECT COUNT(*) AS n FROM reservations r WHERE r.status = 'pendiente'${atR}`).get().n,
      // Pedidos para confirmar (link de reservas, cotizador o cargados como pendientes): la pantalla Hoy los lista.
      pending: db.prepare(`${baseSelect} WHERE r.status = 'pendiente'${atR} ORDER BY r.pickup_at LIMIT 50`).all(),
      unassigned_next_7d: db
        .prepare(`SELECT COUNT(*) AS n FROM reservations r WHERE r.status IN ('pendiente','confirmada') AND r.vehicle_id IS NULL AND r.pickup_at <= ?${atR}`)
        .get(fmtLocal(new Date(Date.now() + 7 * 86400000))).n,
      month_revenue: db
        .prepare(`SELECT COALESCE(SUM(CASE WHEN p.kind='pago' THEN p.amount WHEN p.kind='devolucion' THEN -p.amount ELSE 0 END),0) AS n FROM payments p JOIN reservations r ON r.id = p.reservation_id WHERE substr(p.created_at,1,7) = ?${atR}`)
        .get(month).n,
      month_reservations: db.prepare(`SELECT COUNT(*) AS n FROM reservations r WHERE substr(r.created_at,1,7) = ? AND r.status <> 'cancelada'${atR}`).get(month).n,
      from_quoter_month: db.prepare(`SELECT COUNT(*) AS n FROM reservations r WHERE substr(r.created_at,1,7) = ? AND r.source = 'cotizador'${atR}`).get(month).n,
      tomorrow: {
        pickups: db.prepare(`SELECT COUNT(*) AS n FROM reservations r WHERE r.status IN ('pendiente','confirmada') AND substr(r.pickup_at,1,10) = ?${atR}`).get(tomorrow).n,
        returns: db.prepare(`SELECT COUNT(*) AS n FROM reservations r WHERE status IN ('pendiente','confirmada','en_curso') AND substr(return_at,1,10) = ? AND ${FIXED}${atR}`).get(tomorrow).n,
      },
      // Recordatorios de las próximas 12 horas que falta mandar (los automáticos que ya salieron no aparecen).
      reminders: reminders.pending(db, now),
      quote_errors: db.prepare(`SELECT COUNT(*) AS n FROM quote_inbox WHERE status = 'error'`).get().n,
      alerts: {
        documents: db
          .prepare(
            `SELECT v.id, v.plate, v.insurance_expiry, v.vtv_expiry, v.permit_expiry FROM vehicles v
             WHERE ((v.insurance_expiry IS NOT NULL AND v.insurance_expiry <= date(?, '+30 day')) OR (v.vtv_expiry IS NOT NULL AND v.vtv_expiry <= date(?, '+30 day'))
               OR (v.permit_expiry IS NOT NULL AND v.permit_expiry <= date(?, '+30 day')))${atV}
             ORDER BY v.plate`,
          )
          .all(today, today, today),
        maintenance_open: db.prepare(`SELECT COUNT(*) AS n FROM maintenance m JOIN vehicles v ON v.id = m.vehicle_id WHERE m.status = 'abierto'${atV}`).get().n,
      },
      setup: setupSteps(db),
      choferes: choferes.isChoferes(getSettings(db)) ? choferes.dashboardChoferes(db, R.getReservation, today, branch) : null,
    });
  });

  return router;
}

module.exports = { operationsRoutes };
