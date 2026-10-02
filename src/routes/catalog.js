'use strict';

const express = require('express');
const { requireAdmin, audit } = require('../auth');
const { fail, pick, normDate } = require('../util');

/**
 * CRUD genérico para tablas maestras.
 * `adminWrite`: sólo administradores pueden crear/editar/borrar (tarifas, sucursales).
 */
function crud(db, { table, fields, required = [], order = 'id', search = [], adminWrite = false, listSql, dateFields = [], afterWrite, adminDelete = false }) {
  const router = express.Router();
  const guard = adminWrite ? [requireAdmin] : [];
  const deleteGuard = adminWrite || adminDelete ? [requireAdmin] : [];

  const clean = (body) => {
    const data = pick(body, fields);
    for (const f of dateFields) if (f in data && data[f]) data[f] = normDate(data[f]);
    return data;
  };

  router.get('/', (req, res) => {
    let sql = listSql || `SELECT * FROM ${table}`;
    const params = [];
    if (req.query.q && search.length) {
      sql = `SELECT * FROM (${sql}) WHERE ${search.map((f) => `${f} LIKE ?`).join(' OR ')}`;
      for (let i = 0; i < search.length; i++) params.push(`%${req.query.q}%`);
    }
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

function catalogRoutes(db) {
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
        birth_date = NULL, license_number = NULL, license_expiry = NULL, notes = NULL, anonymized_at = ? WHERE id = ?`,
    ).run(`Cliente anonimizado #${c.id}`, new Date().toISOString(), c.id);
    db.prepare("UPDATE reservations SET notes = NULL, flight = NULL WHERE customer_id = ?").run(c.id);
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
      fields: ['code', 'name', 'description', 'daily_rate', 'weekly_rate', 'deposit', 'km_per_day', 'extra_km_rate', 'seats', 'transmission', 'aliases', 'active'],
      required: ['code', 'name'],
      order: 'daily_rate',
      adminWrite: true,
    }),
  );
  router.use(
    '/extras',
    crud(db, { table: 'extras', fields: ['code', 'name', 'price', 'charge_type', 'max_price', 'aliases', 'active'], required: ['name'], order: 'name', adminWrite: true }),
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
  router.use(
    '/vehicles',
    crud(db, {
      table: 'vehicles',
      fields: ['plate', 'brand', 'model', 'year', 'color', 'category_id', 'branch_id', 'status', 'km', 'fuel', 'insurance_expiry', 'vtv_expiry', 'notes'],
      required: ['plate', 'category_id'],
      order: 'plate',
      search: ['plate', 'brand', 'model'],
      dateFields: ['insurance_expiry', 'vtv_expiry'],
      adminDelete: true,
      listSql: `SELECT v.*, c.name AS category_name, c.code AS category_code, b.name AS branch_name
                FROM vehicles v JOIN categories c ON c.id = v.category_id LEFT JOIN branches b ON b.id = v.branch_id`,
    }),
  );
  router.use(
    '/customers',
    crud(db, {
      table: 'customers',
      fields: ['full_name', 'doc_type', 'doc_number', 'email', 'phone', 'address', 'birth_date', 'license_number', 'license_expiry', 'notes'],
      required: ['full_name'],
      order: 'full_name',
      search: ['full_name', 'doc_number', 'email', 'phone'],
      dateFields: ['birth_date', 'license_expiry'],
      adminDelete: true,
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

  return router;
}

module.exports = { catalogRoutes, crud };
