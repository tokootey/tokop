'use strict';

const express = require('express');
const { requireAdmin, audit } = require('../auth');
const { fail, pick, normDate, nowLocal, fmtLocal } = require('../util');
const { removeCustomerDocuments } = require('./files');

/**
 * CRUD genérico para tablas maestras.
 * `adminWrite`: sólo administradores pueden crear/editar/borrar (tarifas, sucursales).
 */
function crud(db, { table, fields, required = [], order = 'id', search = [], adminWrite = false, listSql, dateFields = [], afterWrite, afterDelete, adminDelete = false }) {
  const router = express.Router();
  const guard = adminWrite ? [requireAdmin] : [];
  const deleteGuard = adminWrite || adminDelete ? [requireAdmin] : [];

  // Un campo vacío en el formulario llega como null: en las columnas NOT NULL va su valor por defecto
  // (por ejemplo el costo del taller, que es opcional), en vez de fallar con "Error interno".
  let defaults;
  const defaultsOf = () =>
    (defaults ??= Object.fromEntries(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .filter((c) => c.notnull && c.dflt_value !== null)
        .map((c) => [c.name, /^'.*'$/.test(c.dflt_value) ? c.dflt_value.slice(1, -1) : Number(c.dflt_value)]),
    ));
  const clean = (body) => {
    const data = pick(body, fields);
    for (const f of dateFields) if (f in data && data[f]) data[f] = normDate(data[f]);
    for (const [f, v] of Object.entries(defaultsOf())) if (f in data && (data[f] === null || data[f] === '')) data[f] = v;
    return data;
  };

  router.get('/', (req, res) => {
    let sql = listSql || `SELECT * FROM ${table}`;
    const params = [];
    const where = [];
    if (req.query.q && search.length) {
      where.push(`(${search.map((f) => `${f} LIKE ?`).join(' OR ')})`);
      for (let i = 0; i < search.length; i++) params.push(`%${req.query.q}%`);
    }
    // Los autos de una sucursal (selector de sucursal).
    if (req.query.branch && fields.includes('branch_id')) {
      where.push('branch_id = ?');
      params.push(req.query.branch);
    }
    if (where.length) sql = `SELECT * FROM (${sql}) WHERE ${where.join(' AND ')}`;
    res.json(db.prepare(`${sql} ORDER BY ${order}`).all(...params));
  });

  router.get('/:id', (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) fail(404, 'No encontrado');
    res.json(row);
  });

  router.post('/', ...guard, (req, res) => {
    const data = clean(req.body);
    for (const f of required) if (data[f] === undefined || data[f] === null) fail(400, `Campo obligatorio: ${f}`);
    const keys = Object.keys(data);
    const r = db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => data[k]));
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(r.lastInsertRowid);
    if (afterWrite) afterWrite(row);
    res.status(201).json(row);
  });

  router.put('/:id', ...guard, (req, res) => {
    const data = clean(req.body);
    const keys = Object.keys(data);
    if (!keys.length) fail(400, 'Nada para actualizar');
    for (const f of required) if (f in data && (data[f] === null || data[f] === undefined)) fail(400, `Campo obligatorio: ${f}`);
    const r = db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => data[k]), req.params.id);
    if (!r.changes) fail(404, 'No encontrado');
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (afterWrite) afterWrite(row);
    res.json(row);
  });

  router.delete('/:id', ...deleteGuard, (req, res) => {
    try {
      const r = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
      if (!r.changes) fail(404, 'No encontrado');
      audit(db, req, 'registro_borrado', `${table} #${req.params.id}`);
      if (afterDelete) afterDelete(req.params.id);
    } catch (err) {
      if (/FOREIGN KEY/i.test(err.message)) fail(409, 'No se puede borrar: tiene registros asociados. Podés desactivarlo.');
      throw err;
    }
    res.status(204).end();
  });

  return router;
}

/** Un vehículo con mantenimientos abiertos pasa a "mantenimiento"; al cerrarlos vuelve a "disponible". */
function syncVehicleMaintenance(db, vehicleId) {
  const open = db.prepare("SELECT 1 FROM maintenance WHERE vehicle_id = ? AND status = 'abierto' LIMIT 1").get(vehicleId);
  if (open) db.prepare("UPDATE vehicles SET status = 'mantenimiento' WHERE id = ? AND status = 'disponible'").run(vehicleId);
  else db.prepare("UPDATE vehicles SET status = 'disponible' WHERE id = ? AND status = 'mantenimiento'").run(vehicleId);
}

/**
 * Cuota mensual del seguro de cada auto: se carga sola como gasto del auto el día 1 de cada mes (desde que se pone la cuota).
 * Se llama al abrir Hoy y la lista de gastos; la clave por auto y mes evita repetirla.
 */
function chargeInsurance(db, today) {
  const month = String(today).slice(0, 7);
  const ins = db.prepare("INSERT OR IGNORE INTO expenses (vehicle_id, date, kind, description, amount, auto_key) VALUES (?, ?, 'seguro', ?, ?, ?)");
  for (const v of db.prepare('SELECT id, insurance_company, insurance_policy, insurance_cost FROM vehicles WHERE insurance_cost > 0').all()) {
    const what = ['Cuota del seguro', v.insurance_company, v.insurance_policy && `póliza ${v.insurance_policy}`].filter(Boolean).join(' · ');
    ins.run(v.id, `${month}-01`, what, v.insurance_cost, `seguro:${v.id}:${month}`);
  }
}

function catalogRoutes(db, { uploadsDir } = {}) {
  // Carnet y DNI del cliente: se borran con sus datos personales (también los archivos del disco).
  const dropDocuments = (id) => uploadsDir && removeCustomerDocuments(db, uploadsDir, id);
  const router = express.Router();

  /**
   * Anonimizar un cliente (pedido de baja de datos personales): se borran sus datos personales
   * pero se conservan las reservas y los importes para la contabilidad.
   */
  router.post('/customers/:id/anonymize', requireAdmin, (req, res) => {
    const c = db.prepare('SELECT id FROM customers WHERE id = ?').get(Number(req.params.id));
    if (!c) fail(404, 'Cliente inexistente');
    db.prepare(
      `UPDATE customers SET full_name = ?, doc_type = NULL, doc_number = NULL, email = NULL, phone = NULL, address = NULL,
        birth_date = NULL, license_number = NULL, license_expiry = NULL, notes = NULL, license_class = NULL, work_apps = NULL,
        guarantor_name = NULL, guarantor_doc = NULL, guarantor_phone = NULL, guarantor_address = NULL, anonymized_at = ? WHERE id = ?`,
    ).run(`Cliente anonimizado #${c.id}`, new Date().toISOString(), c.id);
    db.prepare("UPDATE reservations SET notes = NULL, flight = NULL WHERE customer_id = ?").run(c.id);
    db.prepare('DELETE FROM delivery_links WHERE reservation_id IN (SELECT id FROM reservations WHERE customer_id = ?)').run(c.id);
    dropDocuments(c.id);
    // Las solicitudes del sitio web guardan el formulario original, que también tiene sus datos.
    db.prepare(
      "UPDATE quote_inbox SET payload = '{}', message = 'Datos anonimizados' WHERE reservation_id IN (SELECT id FROM reservations WHERE customer_id = ?)",
    ).run(c.id);
    audit(db, req, 'cliente_anonimizado', `cliente #${c.id}`);
    res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(c.id));
  });

  router.use(
    '/branches',
    crud(db, { table: 'branches', fields: ['code', 'name', 'address', 'phone', 'aliases', 'active'], required: ['code', 'name'], order: 'name', adminWrite: true }),
  );
  router.use(
    '/categories',
    crud(db, {
      table: 'categories',
      fields: ['code', 'name', 'description', 'daily_rate', 'weekly_rate', 'monthly_rate', 'deposit', 'km_per_day', 'km_per_period', 'rest_day_rate', 'extra_km_rate', 'seats', 'transmission', 'aliases', 'active'],
      required: ['code', 'name'],
      order: 'daily_rate',
      adminWrite: true,
    }),
  );
  router.use(
    '/extras',
    crud(db, { table: 'extras', fields: ['code', 'name', 'price', 'charge_type', 'max_price', 'aliases', 'active', 'kind', 'deductible'], required: ['name'], order: 'name', adminWrite: true }),
  );
  router.use('/seasons', (req, _res, next) => {
    const m = (req.body || {}).multiplier;
    if (['POST', 'PUT'].includes(req.method) && m !== undefined && !(Number(m) >= 1)) fail(400, 'Una temporada solo sube el precio: para bajarlo, cargá una promoción');
    next();
  });
  // La promo se carga por cantidad de días o por fechas fijas; se guarda siempre como fechas.
  router.use('/promotions', (req, _res, next) => {
    if (!['POST', 'PUT'].includes(req.method)) return next();
    const b = req.body || {};
    const start = normDate(b.start_date);
    if (Number(b.days) > 0) {
      const d = new Date(`${start}T12:00`);
      d.setDate(d.getDate() + Math.floor(Number(b.days)) - 1);
      b.end_date = fmtLocal(d).slice(0, 10);
    }
    if (!b.end_date) fail(400, 'Poné la cantidad de días o hasta qué fecha dura la promo');
    if (normDate(b.end_date) < start) fail(400, 'La promo termina antes de empezar');
    const category = db.prepare('SELECT daily_rate FROM categories WHERE id = ?').get(Number(b.category_id));
    if (!category) fail(400, 'Elegí el auto de la promo');
    if (!(Number(b.promo_rate) > 0) || Number(b.promo_rate) >= category.daily_rate) fail(400, `El precio de promo tiene que ser mayor que 0 y menor que la tarifa del auto (${category.daily_rate})`);
    next();
  });
  router.use(
    '/promotions',
    crud(db, {
      table: 'promotions',
      fields: ['name', 'category_id', 'start_date', 'end_date', 'promo_rate', 'active'],
      required: ['name', 'category_id', 'start_date', 'end_date', 'promo_rate'],
      order: 'start_date DESC',
      adminWrite: true,
      dateFields: ['start_date', 'end_date'],
    }),
  );
  router.use(
    '/seasons',
    crud(db, {
      table: 'seasons',
      fields: ['name', 'start_date', 'end_date', 'multiplier'],
      required: ['name', 'start_date', 'end_date'],
      order: 'start_date',
      adminWrite: true,
      dateFields: ['start_date', 'end_date'],
    }),
  );
  // "Alquilado" lo manejan la entrega y la devolución de una reserva, no la ficha del auto:
  // así un auto no figura alquilado sin contrato, ni libre mientras lo tiene un cliente.
  router.use('/vehicles', (req, _res, next) => {
    const status = (req.body || {}).status;
    if (!['POST', 'PUT'].includes(req.method) || status === undefined) return next();
    const id = Number((req.path.match(/^\/(\d+)$/) || [])[1]) || null;
    const current = id ? (db.prepare('SELECT status FROM vehicles WHERE id = ?').get(id) || {}).status : null;
    const rented = id && db.prepare("SELECT 1 FROM reservations WHERE vehicle_id = ? AND status = 'en_curso'").get(id);
    if (status === 'alquilado' && current !== 'alquilado') fail(409, 'Un auto pasa a "Alquilado" solo al entregarlo desde una reserva');
    if (rented && status !== 'alquilado') fail(409, 'Este auto lo tiene un cliente: vuelve a "Disponible" al registrar la devolución');
    next();
  });
  router.use(
    '/vehicles',
    crud(db, {
      table: 'vehicles',
      fields: ['plate', 'brand', 'model', 'year', 'color', 'category_id', 'branch_id', 'status', 'km', 'fuel', 'insurance_expiry', 'vtv_expiry', 'service_every_km', 'notes', 'period_rate', 'rest_day_rate', 'rest_day_free', 'pay_every',
        'insurance_company', 'insurance_policy', 'insurance_cost', 'permit_number', 'permit_expiry'],
      required: ['plate', 'category_id'],
      order: 'plate',
      search: ['plate', 'brand', 'model'],
      dateFields: ['insurance_expiry', 'vtv_expiry', 'permit_expiry'],
      adminDelete: true,
      // Con su próximo movimiento (la próxima salida y, si está alquilado, cuándo vuelve) y su trabajo abierto en el taller.
      listSql: `SELECT v.*, c.name AS category_name, c.code AS category_code, b.name AS branch_name,
                  (SELECT MIN(r.pickup_at) FROM reservations r WHERE r.vehicle_id = v.id AND r.status IN ('pendiente','confirmada')) AS next_out,
                  (SELECT r.return_at FROM reservations r WHERE r.vehicle_id = v.id AND r.status = 'en_curso' AND NOT EXISTS (SELECT 1 FROM rental_periods rp WHERE rp.reservation_id = r.id) ORDER BY r.return_at LIMIT 1) AS back_at,
                  (SELECT m.kind FROM maintenance m WHERE m.vehicle_id = v.id AND m.status = 'abierto' ORDER BY m.start_date LIMIT 1) AS shop_kind,
                  (SELECT m.start_date FROM maintenance m WHERE m.vehicle_id = v.id AND m.status = 'abierto' ORDER BY m.start_date LIMIT 1) AS shop_since
                FROM vehicles v JOIN categories c ON c.id = v.category_id LEFT JOIN branches b ON b.id = v.branch_id`,
    }),
  );
  // WhatsApp del cliente: un número de 8 a 15 dígitos, para que el voucher no se mande a un número mal cargado.
  router.use('/customers', (req, _res, next) => {
    const phone = String((req.body || {}).phone || '').trim();
    if (!['POST', 'PUT'].includes(req.method) || !phone) return next();
    const digits = phone.replace(/\D/g, '').length;
    if (!/^[+\d\s().-]+$/.test(phone) || digits < 8 || digits > 15) fail(400, 'El WhatsApp tiene que ser un número con código de país, por ejemplo +54 9 2901 555123');
    next();
  });
  // Licencia vencida: no se guarda, así no queda un cliente que después no puede retirar el auto.
  router.use('/customers', (req, _res, next) => {
    const expiry = ['POST', 'PUT'].includes(req.method) ? normDate((req.body || {}).license_expiry) : null;
    if (expiry && expiry < nowLocal().slice(0, 10)) fail(400, 'La licencia está vencida: cargá una vigente');
    next();
  });
  router.use(
    '/customers',
    crud(db, {
      table: 'customers',
      fields: ['full_name', 'doc_type', 'doc_number', 'email', 'phone', 'address', 'birth_date', 'license_number', 'license_expiry', 'notes',
        'license_class', 'work_apps', 'guarantor_name', 'guarantor_doc', 'guarantor_phone', 'guarantor_address'],
      required: ['full_name'],
      order: 'full_name',
      search: ['full_name', 'doc_number', 'email', 'phone'],
      dateFields: ['birth_date', 'license_expiry'],
      adminDelete: true,
      afterDelete: dropDocuments,
    }),
  );
  router.use(
    '/maintenance',
    crud(db, {
      table: 'maintenance',
      fields: ['vehicle_id', 'kind', 'description', 'start_date', 'end_date', 'km', 'cost', 'status'],
      required: ['vehicle_id'],
      order: 'start_date DESC',
      search: ['plate', 'description'],
      dateFields: ['start_date', 'end_date'],
      listSql: `SELECT m.*, v.plate, v.brand, v.model FROM maintenance m JOIN vehicles v ON v.id = m.vehicle_id`,
      afterWrite: (m) => syncVehicleMaintenance(db, m.vehicle_id),
      adminDelete: true,
    }),
  );
  // Gastos de cada auto (taller, repuestos, combustible, seguro…): entran en las ganancias y gastos del mes.
  router.get('/expenses', (_req, _res, next) => {
    chargeInsurance(db, nowLocal().slice(0, 10));
    next();
  });
  router.use(
    '/expenses',
    crud(db, {
      table: 'expenses',
      fields: ['vehicle_id', 'date', 'kind', 'description', 'amount'],
      required: ['date', 'amount'],
      order: 'date DESC, id DESC',
      search: ['plate', 'description', 'kind'],
      dateFields: ['date'],
      listSql: `SELECT e.*, v.plate, v.brand, v.model FROM expenses e LEFT JOIN vehicles v ON v.id = e.vehicle_id`,
      adminDelete: true,
    }),
  );

  return router;
}

module.exports = { catalogRoutes, crud, chargeInsurance };
