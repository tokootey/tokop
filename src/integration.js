'use strict';

const { getSetting, getSettings, DEFAULT_MAPPING, WEBFORM_MAPPING } = require('./db');
const { createReservation, getReservation, publicView } = require('./reservations');
const { getPath, normDateTime, fail, HttpError } = require('./util');

/**
 * Integración con el cotizador.
 *
 * El cotizador envía la cotización aceptada en SU propio formato JSON. Con el "mapeo de campos"
 * (configurable desde la pantalla Cotizador) se indica en qué ruta del JSON está cada dato:
 *   { "customer.full_name": "cliente.nombre", "pickup_at": "retiro.fecha", "category_code": "auto.grupo", ... }
 */
function getMapping(db) {
  try {
    return { ...DEFAULT_MAPPING, ...JSON.parse(getSetting(db, 'quote_mapping') || '{}') };
  } catch {
    return { ...DEFAULT_MAPPING };
  }
}

/** Traduce el payload del cotizador al formato canónico usando el mapeo. */
function mapPayload(payload, mapping) {
  const out = { customer: {} };
  for (const [field, path] of Object.entries(mapping)) {
    const value = getPath(payload, path);
    if (value === undefined || value === null || value === '') continue;
    if (field.startsWith('customer.')) out.customer[field.slice(9)] = value;
    else out[field] = value;
  }
  return out;
}

const fold = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

/**
 * Busca por código, id, nombre o alias (lista separada por comas en la columna `aliases`).
 * Los alias permiten traducir lo que envía el sitio ("Aeropuerto", "Auto chico", "4x4") a nuestros registros.
 */
function findByCodeOrName(db, table, value) {
  if (value === undefined || value === null || value === '') return null;
  const v = String(value).trim();
  const direct = db.prepare(`SELECT * FROM ${table} WHERE code = ? COLLATE NOCASE OR name = ? COLLATE NOCASE OR CAST(id AS TEXT) = ?`).get(v, v, v);
  if (direct) return direct;
  const target = fold(v);
  for (const row of db.prepare(`SELECT * FROM ${table} WHERE aliases IS NOT NULL AND aliases <> ''`).all()) {
    if (row.aliases.split(',').some((a) => fold(a) === target)) return row;
  }
  return null;
}

/** Une fecha y hora que el formulario envía por separado ("15/01/2027" + "10:30"). */
function joinDateTime(date, time) {
  if (!date) return date;
  if (!time || /\d{1,2}:\d{2}/.test(String(date))) return date;
  const t = String(time).match(/(\d{1,2})(?::(\d{2}))?/);
  if (!t) return date;
  return `${String(date).trim()} ${t[1].padStart(2, '0')}:${t[2] || '00'}`;
}

function upsertCustomer(db, c) {
  if (!c.full_name) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
    if (name) c.full_name = name;
  }
  if (!c.full_name) fail(422, 'La cotización no trae el nombre del cliente (revisá el mapeo "customer.full_name")');
  let existing = null;
  if (c.doc_number) existing = db.prepare('SELECT * FROM customers WHERE doc_number = ?').get(String(c.doc_number));
  if (!existing && c.email) existing = db.prepare('SELECT * FROM customers WHERE email = ? COLLATE NOCASE').get(String(c.email));
  const fields = ['full_name', 'doc_type', 'doc_number', 'email', 'phone', 'license_number'];
  if (existing) {
    // Completa datos faltantes sin pisar los que ya cargó el mostrador.
    const updates = fields.filter((f) => c[f] && !existing[f]);
    if (updates.length) {
      db.prepare(`UPDATE customers SET ${updates.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).run(...updates.map((f) => String(c[f])), existing.id);
    }
    return existing.id;
  }
  const res = db
    .prepare('INSERT INTO customers (full_name, doc_type, doc_number, email, phone, license_number) VALUES (?, ?, ?, ?, ?, ?)')
    .run(...fields.map((f) => (c[f] === undefined || c[f] === null ? (f === 'doc_type' ? 'DNI' : null) : String(c[f]))));
  return Number(res.lastInsertRowid);
}

function resolveExtras(db, extras) {
  if (!extras) return [];
  const list = Array.isArray(extras) ? extras : String(extras).split(',');
  const out = [];
  for (const item of list) {
    const key = typeof item === 'object' ? item.code || item.id || item.name : item;
    const qty = typeof item === 'object' ? Number(item.quantity || item.cantidad || 1) : 1;
    const extra = findByCodeOrName(db, 'extras', key);
    if (!extra) fail(422, `Adicional desconocido: "${key}"`);
    out.push({ extra_id: extra.id, quantity: qty });
  }
  return out;
}

/** Convierte una cotización (ya mapeada) en reserva. Idempotente por external_id. */
function reservationFromQuote(db, mapped, { source = 'cotizador', forcePending = false } = {}) {
  const settings = getSettings(db);
  if (mapped.external_id) {
    const existing = db.prepare('SELECT id FROM reservations WHERE source = ? AND external_id = ?').get(source, String(mapped.external_id));
    if (existing) return { reservation: getReservation(db, existing.id), duplicated: true };
  }
  const category = findByCodeOrName(db, 'categories', mapped.category_code);
  if (!category) fail(422, `Categoría desconocida: "${mapped.category_code ?? ''}" (revisá el mapeo "category_code" o los códigos de categoría)`);
  const pickupBranch = findByCodeOrName(db, 'branches', mapped.pickup_branch);
  const returnBranch = findByCodeOrName(db, 'branches', mapped.return_branch) || pickupBranch;
  const pickupAt = normDateTime(joinDateTime(mapped.pickup_at, mapped.pickup_time));
  const returnAt = normDateTime(joinDateTime(mapped.return_at, mapped.return_time));
  if (!pickupAt || !returnAt) fail(422, 'Fechas de retiro/devolución ausentes o inválidas');

  const customerId = upsertCustomer(db, { ...mapped.customer });
  const useQuotedPrice = settings.quote_price_source !== 'sistema' && mapped.total !== undefined;
  const reservation = createReservation(db, {
    customer_id: customerId,
    category_id: category.id,
    pickup_branch_id: pickupBranch ? pickupBranch.id : null,
    return_branch_id: returnBranch ? returnBranch.id : null,
    pickup_at: pickupAt,
    return_at: returnAt,
    extras: resolveExtras(db, mapped.extras),
    status: !forcePending && settings.quote_auto_confirm === '1' ? 'confirmada' : 'pendiente',
    source,
    external_id: mapped.external_id,
    price_override: useQuotedPrice ? Number(String(mapped.total).replace(/[^\d.,-]/g, '').replace(',', '.')) : undefined,
    flight: mapped.flight,
    notes: `[${source === 'web' ? 'Formulario web' : 'Cotizador'}]${mapped.notes ? ' ' + mapped.notes : ''}`,
  });
  return { reservation, duplicated: false };
}

function getWebformMapping(db) {
  try {
    return JSON.parse(getSetting(db, 'webform_mapping') || '{}');
  } catch {
    return { ...WEBFORM_MAPPING };
  }
}

/**
 * Procesa un payload recibido, registrándolo en la bandeja de entrada.
 * channel: 'cotizador' (API/webhook con API key) o 'web' (formulario público del sitio).
 */
function ingestQuote(db, payload, inboxId, channel) {
  if (!channel && inboxId) {
    const row = db.prepare('SELECT channel FROM quote_inbox WHERE id = ?').get(inboxId);
    channel = row && row.channel;
  }
  channel = channel === 'web' ? 'web' : 'cotizador';
  const mapping = channel === 'web' ? getWebformMapping(db) : getMapping(db);
  const mapped = mapPayload(payload, mapping);
  let id = inboxId;
  if (!id) {
    id = Number(
      db.prepare("INSERT INTO quote_inbox (external_id, payload, status, channel) VALUES (?, ?, 'recibida', ?)").run(
        mapped.external_id ? String(mapped.external_id) : null,
        JSON.stringify(payload),
        channel,
      ).lastInsertRowid,
    );
  }
  try {
    const { reservation, duplicated } = reservationFromQuote(db, mapped, { source: channel, forcePending: channel === 'web' });
    db.prepare('UPDATE quote_inbox SET status = ?, message = ?, reservation_id = ? WHERE id = ?').run(
      duplicated ? 'duplicada' : 'procesada',
      duplicated ? 'Ya existía una reserva con ese id de cotización' : `Reserva ${reservation.code} creada`,
      reservation.id,
      id,
    );
    return { ok: true, inbox_id: id, duplicated, reservation: publicView(reservation) };
  } catch (err) {
    db.prepare("UPDATE quote_inbox SET status = 'error', message = ? WHERE id = ?").run(err.message, id);
    if (err instanceof HttpError) {
      err.details = { inbox_id: id, mapped };
      throw err;
    }
    throw err;
  }
}

function reprocessInbox(db, inboxId) {
  const row = db.prepare('SELECT * FROM quote_inbox WHERE id = ?').get(inboxId);
  if (!row) fail(404, 'Registro inexistente');
  if (row.status === 'procesada') fail(409, 'Esta cotización ya generó una reserva');
  return ingestQuote(db, JSON.parse(row.payload), row.id);
}

module.exports = { getMapping, getWebformMapping, joinDateTime, mapPayload, reservationFromQuote, ingestQuote, reprocessInbox, findByCodeOrName };
