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

/** Normaliza el nombre de un campo: "Fecha de Retiro" / "fechaRetiro" / "fecha-retiro" → "fecha_de_retiro". */
const normKey = (k) =>
  String(k)
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

const PICKUP_WORD = /(retiro|retirar|recogida|recoger|desde|inicio|comienzo|pick_?up|llegada|arribo|salida|entrega|(^|_)(start|from)(_|$))/;
const RETURN_WORD = /(devolucion|devolver|hasta|regreso|retorno|drop_?off|return|until|(^|_)(fin|final|end|to)(_|$))/;
const TIME_WORD = /(hora|horario|time|(^|_)(hr|hs)(_|$))/;
const DATE_WORD = /(fecha|date|dia|day)/;
const PLACE_WORD = /(lugar|sucursal|location|place|oficina|punto|direccion|ciudad)/;
const looksLikeDate = (v) => /^\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4})/.test(String(v));
const looksLikeTime = (v) => /^\s*\d{1,2}(:\d{2})?\s*(hs|h|am|pm)?\s*$/i.test(String(v));

/**
 * Reconoce los campos de un formulario aunque no estén en el mapeo, por su nombre
 * ("nombre", "name", "tu_email", "fecha_de_retiro", "pickupDate", "lugar_devolucion", …)
 * y, si hace falta, por su contenido (las dos primeras fechas = retiro y devolución).
 * Sólo completa lo que el mapeo no encontró.
 */
function autoDetect(payload, out, mapping = {}) {
  const entries = Object.entries(payload || {})
    .filter(([k, v]) => !k.startsWith('_') && v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => [normKey(k), Array.isArray(v) ? v : String(v).trim(), k]);
  // Los campos que ya resolvió el mapeo no se vuelven a usar.
  const used = new Set(
    Object.values(mapping)
      .map((p) => String(p).split('.')[0])
      .filter((k) => payload && payload[k] !== undefined && payload[k] !== ''),
  );
  const take = (test, valueTest) => {
    const hit = entries.find(([k, v, raw]) => !used.has(raw) && test(k) && (!valueTest || valueTest(v)));
    if (!hit) return undefined;
    used.add(hit[2]);
    return hit[1];
  };
  const set = (obj, key, getter) => {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') {
      const v = getter();
      if (v !== undefined) obj[key] = v;
    }
  };
  const c = out.customer;
  set(c, 'email', () => take((k) => /(e_?mail|correo)/.test(k)));
  set(c, 'phone', () => take((k) => /(tel|cel|whatsapp|wsp|phone|movil|contacto)/.test(k)));
  set(c, 'doc_number', () => take((k) => /^(dni|documento|doc|n_?doc|nro_?doc|numero_?doc|pasaporte|passport|cuit|cuil|rut|ci)(_|$)/.test(k)));
  set(c, 'license_number', () => take((k) => /(licencia|carnet|registro|license)/.test(k)));
  set(c, 'full_name', () => take((k) => /^(nombre_?y_?apellido|apellido_?y_?nombre|nombre_?completo|full_?name|your_?name|tu_?nombre|name|cliente|titular|pasajero)$/.test(k)));
  if (!c.full_name) {
    const first = take((k) => /^(nombre|nombres|first_?name|name)$/.test(k));
    const last = take((k) => /^(apellido|apellidos|last_?name|surname)$/.test(k));
    const full = [first, last].filter(Boolean).join(' ');
    if (full) c.full_name = full;
  }

  const notTripDate = (k) => !/(nacimiento|birth|vencimiento|expir|venc|licencia|license)/.test(k);
  const isPick = (k) => PICKUP_WORD.test(k) && !RETURN_WORD.test(k.replace(/entrega/, ''));
  const isRet = (k) => RETURN_WORD.test(k);
  set(out, 'pickup_branch', () => take((k) => PLACE_WORD.test(k) && isPick(k)));
  set(out, 'return_branch', () => take((k) => PLACE_WORD.test(k) && isRet(k)));
  set(out, 'pickup_time', () => take((k) => TIME_WORD.test(k) && isPick(k)));
  set(out, 'return_time', () => take((k) => TIME_WORD.test(k) && isRet(k)));
  set(out, 'pickup_at', () => take((k) => isPick(k) && !PLACE_WORD.test(k) && notTripDate(k), looksLikeDate) || take((k) => DATE_WORD.test(k) && isPick(k) && notTripDate(k)));
  set(out, 'return_at', () => take((k) => isRet(k) && !PLACE_WORD.test(k) && notTripDate(k), looksLikeDate) || take((k) => DATE_WORD.test(k) && isRet(k) && notTripDate(k)));
  // Último recurso: las dos primeras fechas del formulario son retiro y devolución.
  set(out, 'pickup_at', () => take(notTripDate, looksLikeDate));
  set(out, 'return_at', () => take(notTripDate, looksLikeDate));
  set(out, 'pickup_time', () => (out.pickup_at && !/\d:\d/.test(out.pickup_at) ? take((k) => TIME_WORD.test(k), looksLikeTime) : undefined));
  set(out, 'return_time', () => (out.return_at && !/\d:\d/.test(out.return_at) ? take((k) => TIME_WORD.test(k), looksLikeTime) : undefined));
  // Si sólo hay un lugar, se usa para retiro y devolución.
  set(out, 'pickup_branch', () => take((k) => PLACE_WORD.test(k)));

  set(out, 'category_code', () => take((k) => /(vehiculo|auto|categoria|grupo|modelo|coche|carro|car|vehicle|unidad|tipo)/.test(k)));
  set(out, 'flight', () => take((k) => /(vuelo|flight|aerolinea|crucero)/.test(k)));
  set(out, 'extras', () => take((k) => /(adicional|extra|accesorio|equipamiento|opcional)/.test(k)));
  set(out, 'notes', () => take((k) => /(comentario|mensaje|consulta|observacion|nota|message|comment|detalle|pedido)/.test(k)));
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

/**
 * Traduce los adicionales. En modo tolerante (formulario web) los desconocidos no frenan
 * la reserva: se devuelven en `unknown` para dejarlos anotados.
 */
function resolveExtras(db, extras, { lenient = false } = {}) {
  const out = [];
  const unknown = [];
  if (!extras) return lenient ? { list: out, unknown } : out;
  const list = Array.isArray(extras) ? extras : String(extras).split(/[,;]/);
  for (const item of list) {
    const key = typeof item === 'object' ? item.code || item.id || item.name : String(item).trim();
    if (!key || /^(no|ninguno|none|0)$/i.test(String(key))) continue;
    const qty = typeof item === 'object' ? Number(item.quantity || item.cantidad || 1) : 1;
    const extra = findByCodeOrName(db, 'extras', key);
    if (!extra) {
      if (!lenient) fail(422, `Adicional desconocido: "${key}"`);
      unknown.push(String(key));
      continue;
    }
    if (!out.some((e) => e.extra_id === extra.id)) out.push({ extra_id: extra.id, quantity: qty });
  }
  return lenient ? { list: out, unknown } : out;
}

/** Interpreta importes: "$ 150.000", "150.000,50", "150,000.50", "150000". */
function parseAmount(value) {
  if (typeof value === 'number') return value;
  let s = String(value).replace(/[^\d.,-]/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Convierte una cotización (ya mapeada) en reserva. Idempotente por external_id. */
function reservationFromQuote(db, mapped, { source = 'cotizador', forcePending = false } = {}) {
  const settings = getSettings(db);
  if (mapped.external_id) {
    const existing = db.prepare('SELECT id FROM reservations WHERE source = ? AND external_id = ?').get(source, String(mapped.external_id));
    if (existing) return { reservation: getReservation(db, existing.id), duplicated: true };
  }
  const category = findByCodeOrName(db, 'categories', mapped.category_code);
  if (!category) {
    fail(
      422,
      mapped.category_code
        ? `Categoría desconocida: "${mapped.category_code}". Agregala como alias en Tarifas y sucursales → Categorías y tocá Reintentar.`
        : 'La solicitud no indica el vehículo/categoría (revisá el mapeo "category_code")',
    );
  }
  const pickupBranch = findByCodeOrName(db, 'branches', mapped.pickup_branch);
  const returnBranch = findByCodeOrName(db, 'branches', mapped.return_branch) || pickupBranch;
  const pickupAt = normDateTime(joinDateTime(mapped.pickup_at, mapped.pickup_time));
  const returnAt = normDateTime(joinDateTime(mapped.return_at, mapped.return_time));
  if (!pickupAt || !returnAt) fail(422, 'Fechas de retiro/devolución ausentes o inválidas');

  const customerId = upsertCustomer(db, { ...mapped.customer });
  const lenient = source === 'web';
  const extras = resolveExtras(db, mapped.extras, { lenient });
  const extrasList = lenient ? extras.list : extras;
  const quotedTotal = mapped.total !== undefined ? parseAmount(mapped.total) : undefined;
  const useQuotedPrice = settings.quote_price_source !== 'sistema' && quotedTotal !== undefined;
  const noteParts = [mapped.notes, lenient && extras.unknown.length ? `Adicionales pedidos: ${extras.unknown.join(', ')}` : null].filter(Boolean);
  const reservation = createReservation(db, {
    customer_id: customerId,
    category_id: category.id,
    pickup_branch_id: pickupBranch ? pickupBranch.id : null,
    return_branch_id: returnBranch ? returnBranch.id : null,
    pickup_at: pickupAt,
    return_at: returnAt,
    extras: extrasList,
    status: !forcePending && settings.quote_auto_confirm === '1' ? 'confirmada' : 'pendiente',
    source,
    external_id: mapped.external_id,
    price_override: useQuotedPrice ? quotedTotal : undefined,
    flight: mapped.flight,
    notes: `[${source === 'web' ? 'Formulario web' : 'Cotizador'}]${noteParts.length ? ' ' + noteParts.join(' · ') : ''}`,
  });
  return { reservation, duplicated: false };
}

/** Interpreta un envío: mapeo configurado y, en el formulario web, autodetección de lo que falte. */
function interpret(db, payload, channel, mapping) {
  const m = mapping || (channel === 'web' ? getWebformMapping(db) : getMapping(db));
  const mapped = mapPayload(payload, m);
  return channel === 'web' ? autoDetect(payload, mapped, m) : mapped;
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
  const mapped = interpret(db, payload, channel);
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

module.exports = { getMapping, getWebformMapping, joinDateTime, mapPayload, autoDetect, interpret, parseAmount, reservationFromQuote, ingestQuote, reprocessInbox, findByCodeOrName };
