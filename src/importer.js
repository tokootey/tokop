'use strict';

const { getSettings } = require('./db');
const { normKey, fold, parseAmount, findByCodeOrName } = require('./integration');
const { computeQuote, rentalDays } = require('./pricing');
const { isVehicleFree } = require('./availability');
const { nextCode, log } = require('./reservations');
const { fail, nowLocal, round2 } = require('./util');

/**
 * Importación de datos de sistemas anteriores (planillas de Google Drive, Excel, otra página).
 *
 * Se sube el archivo CSV (o se pegan las celdas copiadas de la planilla). El sistema reconoce
 * las columnas por su nombre, muestra una vista previa y, con "Probar", simula toda la importación
 * dentro de una transacción que después se deshace: el informe es exactamente lo que va a pasar.
 */

const LIMITS = { text: 5_000_000, rows: 5000, cols: 80, cell: 1000 };

/* ---------- Lectura de CSV / celdas pegadas ---------- */

function detectDelimiter(text) {
  const firstLines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
  let best = ',';
  let bestCount = 0;
  for (const d of ['\t', ';', ',']) {
    // Cuenta separadores fuera de comillas.
    const count = firstLines.reduce((acc, line) => acc + line.replace(/"[^"]*"/g, '').split(d).length - 1, 0);
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push({ cells: row, line: rowLine });
      row = [];
      cell = '';
      line++;
      rowLine = line;
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push({ cells: row, line: rowLine });
  }
  return rows;
}

/** Devuelve { headers, rows: [{ cells, line }] } a partir del texto del archivo. */
function parseTable(text) {
  if (typeof text !== 'string' || !text.trim()) fail(400, 'El archivo está vacío');
  if (text.length > LIMITS.text) fail(413, 'El archivo es demasiado grande (máximo 5 MB). Dividilo en partes.');
  const clean = text.replace(/^﻿/, '');
  const delimiter = detectDelimiter(clean);
  const all = parseCsv(clean, delimiter)
    .map((r) => ({ line: r.line, cells: r.cells.slice(0, LIMITS.cols).map((c) => String(c).trim().slice(0, LIMITS.cell)) }))
    .filter((r) => r.cells.some((c) => c !== ''));
  if (!all.length) fail(400, 'El archivo está vacío');
  // Algunas planillas tienen un título arriba: el encabezado es la primera fila "llena".
  const width = Math.max(...all.slice(0, 20).map((r) => r.cells.filter(Boolean).length));
  const headerIdx = Math.max(0, all.slice(0, 10).findIndex((r) => r.cells.filter(Boolean).length >= Math.max(2, Math.ceil(width * 0.5))));
  const headers = all[headerIdx].cells.map((h, i) => h || `Columna ${i + 1}`);
  const rows = all.slice(headerIdx + 1);
  if (!rows.length) fail(400, 'El archivo sólo tiene encabezados, sin datos');
  if (rows.length > LIMITS.rows) fail(413, `Hay ${rows.length} filas; el máximo por importación es ${LIMITS.rows}. Dividilo en partes.`);
  return { headers, rows, delimiter };
}

/* ---------- Campos de cada tipo de importación ---------- */

const PICK = /(retiro|recogida|desde|inicio|pick_?up|salida|entrega|check_?out|^in$)/;
const RET = /(devolucion|devuelve|hasta|regreso|retorno|drop_?off|return|^fin|final|vuelta|check_?in)/;
const TIME = /(hora|horario|time|(^|_)(hs|hr)$)/;
const PLACE = /(lugar|sucursal|location|place|oficina|punto|direccion|ciudad|aeropuerto)/;
const DOC = /(^dni|documento|^doc$|^nro_?doc|^num(ero)?_?(de_)?doc|pasaporte|passport|cuit|cuil|identific)/;
const EMAIL = /(e_?mail|correo|^mail)/;
const PHONE = /(tel|cel|whats|movil|phone)/;
const PLATE = /(patente|dominio|placa|plate|matricula)/;
const CATEGORY = /(categ|grupo|clase|segmento|category|group|^tipo)/;
const STATUS = /(estado|status|situacion)/;
const NOTES = /(observ|nota|coment|notes|detalle)/;

const KINDS = {
  clientes: {
    label: 'Clientes',
    fields: [
      { key: 'doc_type', label: 'Tipo de documento', test: (k) => /tipo_?(de_)?doc|doc(ument)?_?type/.test(k) },
      { key: 'license_expiry', label: 'Vencimiento de licencia', date: true, test: (k) => /(venc|exp).*(lic|carnet|registro|conducir)|(lic|carnet|registro|conducir).*(venc|exp)/.test(k) },
      { key: 'license_number', label: 'Nº de licencia', test: (k) => /licen|carnet|registro|conducir/.test(k) },
      { key: 'birth_date', label: 'Fecha de nacimiento', date: true, test: (k) => /nacim|birth|fecha_?nac|^nac$/.test(k) },
      { key: 'doc_number', label: 'Nº de documento', test: (k) => DOC.test(k) },
      { key: 'email', label: 'Email', test: (k) => EMAIL.test(k) },
      { key: 'phone', label: 'Teléfono', test: (k) => PHONE.test(k) },
      { key: 'address', label: 'Domicilio', test: (k) => /direcc|domicilio|address|calle/.test(k) },
      { key: 'last_name', label: 'Apellido (si está aparte)', test: (k) => /^apellidos?$|last_?name|surname/.test(k) },
      { key: 'full_name', label: 'Nombre', required: true, test: (k) => /nombre|cliente|titular|full_?name|^name$|razon_social|pasajero/.test(k) },
      { key: 'notes', label: 'Observaciones', test: (k) => NOTES.test(k) },
    ],
  },
  flota: {
    label: 'Flota',
    fields: [
      { key: 'plate', label: 'Patente', required: true, test: (k) => PLATE.test(k) },
      { key: 'insurance_expiry', label: 'Vencimiento del seguro', date: true, test: (k) => /seguro|poliza|insurance/.test(k) },
      { key: 'vtv_expiry', label: 'Vencimiento VTV', date: true, test: (k) => /vtv|rto|itv|inspecc/.test(k) },
      { key: 'year', label: 'Año', test: (k) => /^(ano|anio|year)$|ano_?(de_)?fabric|^modelo_?ano$|^ano_?modelo$/.test(k) },
      { key: 'brand', label: 'Marca', test: (k) => /marca|brand|make/.test(k) },
      { key: 'model', label: 'Modelo', test: (k) => /modelo|model|version/.test(k) },
      { key: 'color', label: 'Color', test: (k) => /color/.test(k) },
      { key: 'category', label: 'Categoría', test: (k) => CATEGORY.test(k) },
      { key: 'branch', label: 'Sucursal', test: (k) => /sucursal|base|ubicacion|branch|oficina|ciudad/.test(k) },
      { key: 'status', label: 'Estado', test: (k) => STATUS.test(k) },
      { key: 'km', label: 'Kilometraje', test: (k) => /^km|kilomet|odometro|mileage|kms/.test(k) },
      { key: 'fuel', label: 'Combustible', test: (k) => /combust|nafta|fuel|tanque/.test(k) },
      { key: 'notes', label: 'Observaciones', test: (k) => NOTES.test(k) },
    ],
  },
  reservas: {
    label: 'Reservas',
    fields: [
      {
        key: 'external_id',
        label: 'Nº de reserva del sistema anterior',
        test: (k) => /^(cod(igo)?|nro|n|numero|id|reserva|voucher|localizador|booking)$|^(nro|numero|cod(igo)?|id)_?(de_)?(reserva|booking)$/.test(k),
      },
      { key: 'pickup_time', label: 'Hora de entrega', test: (k) => PICK.test(k) && TIME.test(k) },
      { key: 'return_time', label: 'Hora de devolución', test: (k) => RET.test(k) && TIME.test(k) },
      { key: 'pickup_branch', label: 'Lugar de entrega', test: (k) => PICK.test(k) && PLACE.test(k) },
      { key: 'return_branch', label: 'Lugar de devolución', test: (k) => RET.test(k) && PLACE.test(k) },
      { key: 'pickup_date', label: 'Fecha de entrega', required: true, date: true, test: (k) => PICK.test(k) },
      { key: 'return_date', label: 'Fecha de devolución', date: true, test: (k) => RET.test(k) },
      { key: 'days', label: 'Cantidad de días', test: (k) => /^(cant(idad)?_?(de_)?)?dias$|^days$/.test(k) },
      { key: 'customer_doc', label: 'Documento del cliente', test: (k) => DOC.test(k) },
      { key: 'customer_email', label: 'Email del cliente', test: (k) => EMAIL.test(k) },
      { key: 'customer_phone', label: 'Teléfono del cliente', test: (k) => PHONE.test(k) },
      { key: 'customer_last_name', label: 'Apellido del cliente (si está aparte)', test: (k) => /^apellidos?$|last_?name|surname/.test(k) },
      { key: 'customer_name', label: 'Cliente', required: true, test: (k) => /nombre|cliente|titular|pasajero|name|razon_social/.test(k) },
      { key: 'plate', label: 'Patente del auto', test: (k) => PLATE.test(k) || /vehiculo|unidad|^auto$|^movil$/.test(k) },
      { key: 'category', label: 'Categoría', test: (k) => CATEGORY.test(k) },
      { key: 'status', label: 'Estado', test: (k) => STATUS.test(k) },
      { key: 'paid', label: 'Pagado / seña', test: (k) => /pagado|abonado|sena|anticipo|cobrado|paid|a_cuenta/.test(k) },
      { key: 'total', label: 'Total', test: (k) => /total|importe|precio|monto|tarifa|valor|price|amount/.test(k) },
      { key: 'flight', label: 'Vuelo', test: (k) => /vuelo|flight/.test(k) },
      { key: 'notes', label: 'Observaciones', test: (k) => NOTES.test(k) },
    ],
  },
};

// Orden en que se muestran los campos en pantalla (el de arriba es el orden en que se reconocen).
const DISPLAY_ORDER = {
  clientes: ['full_name', 'last_name', 'doc_type', 'doc_number', 'email', 'phone', 'address', 'birth_date', 'license_number', 'license_expiry', 'notes'],
  flota: ['plate', 'brand', 'model', 'year', 'color', 'category', 'branch', 'status', 'km', 'fuel', 'insurance_expiry', 'vtv_expiry', 'notes'],
  reservas: ['external_id', 'customer_name', 'customer_last_name', 'customer_doc', 'customer_email', 'customer_phone', 'pickup_date', 'pickup_time', 'pickup_branch', 'return_date', 'return_time', 'return_branch', 'days', 'plate', 'category', 'status', 'total', 'paid', 'flight', 'notes'],
};

function kindSpec(kind) {
  const spec = KINDS[kind];
  if (!spec) fail(400, 'Tipo de importación desconocido');
  return spec;
}

/** Propone qué columna corresponde a cada dato, por el nombre del encabezado. */
function suggestMapping(kind, headers) {
  const spec = kindSpec(kind);
  const keys = headers.map(normKey);
  const used = new Set();
  const mapping = {};
  for (const f of spec.fields) {
    const idx = keys.findIndex((k, i) => !used.has(i) && k && f.test(k));
    if (idx >= 0) {
      mapping[f.key] = idx;
      used.add(idx);
    }
  }
  return mapping;
}

function analyze(kind, text) {
  const spec = kindSpec(kind);
  const { headers, rows } = parseTable(text);
  return {
    kind,
    headers,
    total_rows: rows.length,
    preview: rows.slice(0, 5).map((r) => r.cells),
    mapping: suggestMapping(kind, headers),
    fields: spec.fields
      .map(({ key, label, required }) => ({ key, label, required: !!required }))
      .sort((a, b) => DISPLAY_ORDER[kind].indexOf(a.key) - DISPLAY_ORDER[kind].indexOf(b.key)),
  };
}

/* ---------- Interpretación de valores ---------- */

const pad = (n) => String(n).padStart(2, '0');

function parseTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const s = fold(value).replace(/\s+/g, '');
  const m = s.match(/^(\d{1,2})(?:[:.h](\d{2}))?(?::\d{2})?(hs?|hrs?)?(am|pm|a\.?m\.?|p\.?m\.?)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[4] && m[4].startsWith('p') && h < 12) h += 12;
  if (m[4] && m[4].startsWith('a') && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

/** ¿La columna de fechas viene como mes/día/año (planilla en inglés)? */
function detectMonthFirst(values) {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const v of values) {
    const m = String(v || '').match(/^\s*(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/);
    if (!m) continue;
    if (Number(m[1]) > 12) dayFirst++;
    if (Number(m[2]) > 12) monthFirst++;
  }
  return monthFirst > 0 && dayFirst === 0;
}

/**
 * Interpreta una fecha (con hora opcional): "15/01/2027", "15-1-27 10:30", "2027-01-15T10:30",
 * o el número de serie de Excel (46402). Devuelve { date: 'YYYY-MM-DD', time: 'HH:MM' | null } o null.
 */
function parseDateValue(value, monthFirst = false) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  let y;
  let m;
  let d;
  let time = null;
  let rest = '';
  const serial = s.match(/^(\d{5})(?:[.,](\d+))?$/);
  const iso = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(.*)$/);
  const local = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(.*)$/);
  if (serial && Number(serial[1]) > 20000 && Number(serial[1]) < 80000) {
    const ms = Date.UTC(1899, 11, 30) + Math.round(Number(`${serial[1]}.${serial[2] || 0}`) * 86400) * 1000;
    const dt = new Date(ms);
    [y, m, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
    if (serial[2]) time = `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;
  } else if (iso) {
    [y, m, d, rest] = [Number(iso[1]), Number(iso[2]), Number(iso[3]), iso[4]];
  } else if (local) {
    const a = Number(local[1]);
    const b = Number(local[2]);
    [d, m] = monthFirst ? [b, a] : [a, b];
    y = Number(local[3]);
    if (y < 100) y += 2000;
    rest = local[4];
  } else return null;
  const check = new Date(y, m - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d || y < 1900 || y > 2100) return null;
  if (!time && rest) time = parseTime(rest.replace(/^[\sT,]+/, ''));
  return { date: `${y}-${pad(m)}-${pad(d)}`, time };
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

const compactPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const compactDoc = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

function parseFuel(value) {
  const s = fold(value);
  if (!s) return undefined;
  if (/lleno|full|completo/.test(s)) return 8;
  if (/vacio|reserva|empty/.test(s)) return 0;
  const frac = s.match(/(\d+)\s*\/\s*(\d+)/);
  if (frac && Number(frac[2]) > 0) return Math.max(0, Math.min(8, Math.round((Number(frac[1]) / Number(frac[2])) * 8)));
  const n = parseAmount(s);
  if (n === undefined) return undefined;
  if (/%/.test(s) || n > 8) return n <= 100 ? Math.max(0, Math.round((n / 100) * 8)) : undefined;
  return Math.max(0, Math.round(n));
}

function vehicleStatus(value) {
  const s = fold(value);
  if (!s) return undefined;
  if (/alquil|en curso|rentad|ocupad|en calle/.test(s)) return 'alquilado';
  if (/taller|mant|servic|repar|chapa/.test(s)) return 'mantenimiento';
  if (/baja|fuera|vendid|inactiv|sinies|robad/.test(s)) return 'fuera_servicio';
  if (/dispon|libre|activ|^ok$|operativ/.test(s)) return 'disponible';
  return null;
}

function reservationStatus(value) {
  const s = fold(value);
  if (!s) return undefined;
  if (/cancel|anulad|baja/.test(s)) return 'cancelada';
  if (/no.?show|no se present|ausent/.test(s)) return 'no_show';
  if (/final|devuel|cerrad|complet|termin|conclu/.test(s)) return 'finalizada';
  if (/curso|entregad|alquilad|activ|en calle|retirad/.test(s)) return 'en_curso';
  if (/confirm|reservad|pagad|senad|abonad/.test(s)) return 'confirmada';
  if (/pend|consult|cotiz|presup|espera/.test(s)) return 'pendiente';
  return null;
}

/* ---------- Importación ---------- */

class RowError extends Error {}

function makeIndex(db) {
  const idx = { doc: new Map(), email: new Map(), name: new Map(), phone: new Map(), withDoc: new Set() };
  const add = (c) => {
    if (c.doc_number) {
      idx.doc.set(compactDoc(c.doc_number), c.id);
      idx.withDoc.add(c.id);
    }
    if (c.email) idx.email.set(String(c.email).toLowerCase(), c.id);
    const digits = String(c.phone || '').replace(/\D/g, '');
    if (digits.length >= 8) idx.phone.set(digits.slice(-8), c.id);
    const n = fold(c.full_name).replace(/\s+/g, ' ');
    idx.name.set(n, idx.name.has(n) ? 0 : c.id); // 0 = nombre repetido: no se usa para identificar
  };
  for (const c of db.prepare('SELECT id, full_name, doc_number, email, phone FROM customers WHERE anonymized_at IS NULL').all()) add(c);
  idx.add = add;
  return idx;
}

/**
 * Busca un cliente ya cargado: por documento, email, teléfono y, por último, nombre exacto.
 * Si la fila trae documento, nunca se la une con otra persona que tenga un documento distinto.
 */
function findCustomer(idx, c) {
  const doc = compactDoc(c.doc_number);
  if (doc && idx.doc.get(doc)) return idx.doc.get(doc);
  const ok = (id) => (id && (!doc || !idx.withDoc.has(id)) ? id : null);
  const digits = String(c.phone || '').replace(/\D/g, '');
  return (
    ok(c.email && idx.email.get(c.email.toLowerCase())) ||
    ok(digits.length >= 8 && idx.phone.get(digits.slice(-8))) ||
    (!doc && !c.email && c.full_name ? idx.name.get(fold(c.full_name).replace(/\s+/g, ' ')) || null : null)
  );
}

/** Busca por código, nombre o alias; si no, por parte del nombre ("Aeropuerto" → "Aeropuerto Ushuaia") cuando hay uno solo. */
function lookup(db, table, text) {
  const hit = findByCodeOrName(db, table, text);
  if (hit) return hit;
  const t = fold(text);
  if (t.length < 3) return null;
  const rows = db.prepare(`SELECT * FROM ${table}`).all().filter((r) => fold(r.name).includes(t));
  return rows.length === 1 ? rows[0] : null;
}

const CUSTOMER_FIELDS = ['full_name', 'doc_type', 'doc_number', 'email', 'phone', 'address', 'birth_date', 'license_number', 'license_expiry', 'notes'];
const VEHICLE_FIELDS = ['plate', 'brand', 'model', 'year', 'color', 'category_id', 'branch_id', 'status', 'km', 'fuel', 'insurance_expiry', 'vtv_expiry', 'notes'];

/**
 * Guarda un registro nuevo o existente según el modo:
 *  - completar: sólo llena los datos que faltan (no pisa nada)
 *  - reemplazar: lo que viene en el archivo reemplaza lo cargado
 *  - omitir: si ya existe, no lo toca
 */
function upsert(db, table, fields, existing, data, mode) {
  if (!existing) {
    const cols = fields.filter((f) => data[f] !== undefined && data[f] !== null && data[f] !== '');
    const r = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => data[c]));
    return { action: 'creado', id: Number(r.lastInsertRowid) };
  }
  if (mode === 'omitir') return { action: 'omitido', id: existing.id, message: 'Ya existía (no se modificó)' };
  const changes = {};
  for (const f of fields) {
    const v = data[f];
    if (v === undefined || v === null || v === '') continue;
    const cur = existing[f];
    const empty = cur === undefined || cur === null || cur === '';
    if (f === 'notes' && !empty && mode === 'completar') {
      if (!String(cur).includes(String(v))) changes.notes = `${cur}\n${v}`;
    } else if ((empty || mode === 'reemplazar') && String(cur) !== String(v)) changes[f] = v;
  }
  const keys = Object.keys(changes);
  if (!keys.length) return { action: 'sin_cambios', id: existing.id, message: 'Ya existía con los mismos datos' };
  db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => changes[k]), existing.id);
  return { action: 'actualizado', id: existing.id, message: `Se actualizó: ${keys.join(', ')}` };
}

function makeReader(spec, headers, rows, mapping, keepExtra) {
  const cols = {};
  for (const f of spec.fields) {
    const i = mapping[f.key];
    if (i !== undefined && i !== null && i !== '' && Number.isInteger(Number(i)) && Number(i) >= 0 && Number(i) < headers.length) cols[f.key] = Number(i);
  }
  const monthFirst = {};
  for (const f of spec.fields) if (f.date && cols[f.key] !== undefined) monthFirst[f.key] = detectMonthFirst(rows.map((r) => r.cells[cols[f.key]]));
  const mapped = new Set(Object.values(cols));
  return {
    cols,
    get: (row, key) => (cols[key] === undefined ? '' : String(row.cells[cols[key]] ?? '').trim()),
    date: (row, key) => parseDateValue(cols[key] === undefined ? '' : row.cells[cols[key]], monthFirst[key]),
    extra: (row) =>
      keepExtra
        ? headers
            .map((h, i) => (!mapped.has(i) && row.cells[i] ? `${h}: ${row.cells[i]}` : null))
            .filter(Boolean)
            .join(' · ')
        : '',
  };
}

const joinNotes = (...parts) => parts.filter(Boolean).join('\n') || null;

function importCustomer(db, ctx, row) {
  const { read, idx, mode, warn } = ctx;
  const full = [read.get(row, 'full_name'), read.get(row, 'last_name')].filter(Boolean).join(' ').replace(/\s+/g, ' ');
  if (!full) throw new RowError('Falta el nombre');
  const data = { full_name: full };
  for (const k of ['doc_number', 'phone', 'address', 'license_number']) data[k] = read.get(row, k) || undefined;
  const docType = read.get(row, 'doc_type');
  if (docType) data.doc_type = /pas/i.test(docType) ? 'Pasaporte' : /^ci|cedula/i.test(fold(docType)) ? 'CI' : /dni|d\.n\.i/i.test(docType) ? 'DNI' : 'Otro';
  const email = read.get(row, 'email').toLowerCase();
  if (email) {
    if (validEmail(email)) data.email = email;
    else warn(`Email no válido ("${email}"): no se cargó`);
  }
  for (const k of ['birth_date', 'license_expiry']) {
    if (!read.get(row, k)) continue;
    const d = read.date(row, k);
    if (d) data[k] = d.date;
    else warn(`Fecha no reconocida en "${ctx.label(k)}": ${read.get(row, k)}`);
  }
  data.notes = joinNotes(read.get(row, 'notes'), read.extra(row)) || undefined;
  const existingId = findCustomer(idx, data);
  const existing = existingId ? db.prepare('SELECT * FROM customers WHERE id = ?').get(existingId) : null;
  const res = upsert(db, 'customers', CUSTOMER_FIELDS, existing, data, mode);
  if (res.action === 'creado') idx.add({ id: res.id, ...data });
  return { ...res, label: full };
}

function importVehicle(db, ctx, row) {
  const { read, mode, warn, options } = ctx;
  const plateRaw = read.get(row, 'plate');
  const plate = plateRaw.toUpperCase().replace(/\s+/g, ' ').trim();
  if (!compactPlate(plate)) throw new RowError('Falta la patente');
  const existing = db
    .prepare('SELECT * FROM vehicles')
    .all()
    .find((v) => compactPlate(v.plate) === compactPlate(plate));
  const data = { plate: existing ? existing.plate : plate };
  for (const k of ['brand', 'model', 'color']) data[k] = read.get(row, k) || undefined;
  const catText = read.get(row, 'category');
  const cat = catText ? lookup(db, 'categories', catText) : null;
  if (cat) data.category_id = cat.id;
  else if (!existing) {
    if (options.default_category_id) data.category_id = options.default_category_id;
    else throw new RowError(catText ? `Categoría desconocida: "${catText}". Creala en Tarifas, agregala como alias o elegí una categoría por defecto.` : 'Falta la categoría (elegí una categoría por defecto)');
    if (catText) warn(`Categoría "${catText}" desconocida: se usó la categoría por defecto`);
  } else if (catText) warn(`Categoría "${catText}" desconocida: se dejó la que tenía`);
  const branchText = read.get(row, 'branch');
  if (branchText) {
    const b = lookup(db, 'branches', branchText);
    if (b) data.branch_id = b.id;
    else warn(`Sucursal "${branchText}" desconocida: no se asignó`);
  }
  const statusText = read.get(row, 'status');
  if (statusText) {
    const st = vehicleStatus(statusText);
    if (st) data.status = st;
    else warn(`Estado "${statusText}" no reconocido: queda como disponible`);
  }
  const year = read.get(row, 'year');
  if (year) {
    const n = Number(year.replace(/\D/g, '').slice(0, 4));
    if (n >= 1950 && n <= 2100) data.year = n;
    else warn(`Año no válido: ${year}`);
  }
  const km = read.get(row, 'km');
  if (km) {
    const n = parseAmount(km);
    if (n !== undefined && n >= 0) data.km = Math.round(n);
    else warn(`Kilometraje no válido: ${km}`);
  }
  const fuel = read.get(row, 'fuel');
  if (fuel) {
    const n = parseFuel(fuel);
    if (n !== undefined && n <= 8) data.fuel = n;
    else warn(`Combustible no reconocido: ${fuel}`);
  }
  for (const k of ['insurance_expiry', 'vtv_expiry']) {
    if (!read.get(row, k)) continue;
    const d = read.date(row, k);
    if (d) data[k] = d.date;
    else warn(`Fecha no reconocida en "${ctx.label(k)}": ${read.get(row, k)}`);
  }
  data.notes = joinNotes(read.get(row, 'notes'), read.extra(row)) || undefined;
  if (existing && existing.status === 'alquilado' && data.status && data.status !== 'alquilado' && mode === 'reemplazar') {
    const open = db.prepare("SELECT 1 FROM reservations WHERE vehicle_id = ? AND status = 'en_curso'").get(existing.id);
    if (open) {
      delete data.status;
      warn('Tiene un alquiler en curso: no se cambió el estado');
    }
  }
  const res = upsert(db, 'vehicles', VEHICLE_FIELDS, existing, data, mode);
  return { ...res, label: [data.plate, data.brand, data.model].filter(Boolean).join(' ') };
}

function importReservation(db, ctx, row) {
  const { read, idx, warn, options, settings, userId } = ctx;
  // Cliente: se busca entre los ya cargados; si no está, se crea.
  const name = [read.get(row, 'customer_name'), read.get(row, 'customer_last_name')].filter(Boolean).join(' ').replace(/\s+/g, ' ');
  const email = read.get(row, 'customer_email').toLowerCase();
  const customer = {
    full_name: name || undefined,
    doc_number: read.get(row, 'customer_doc') || undefined,
    email: email && validEmail(email) ? email : undefined,
    phone: read.get(row, 'customer_phone') || undefined,
  };
  let customerId = findCustomer(idx, customer);
  let newCustomer = false;
  if (!customerId) {
    if (!name) throw new RowError('Falta el nombre del cliente');
    const r = db
      .prepare('INSERT INTO customers (full_name, doc_number, email, phone, notes) VALUES (?, ?, ?, ?, ?)')
      .run(name, customer.doc_number || null, customer.email || null, customer.phone || null, 'Importado del sistema anterior');
    customerId = Number(r.lastInsertRowid);
    idx.add({ id: customerId, ...customer });
    newCustomer = true;
  }

  // Fechas.
  const pick = read.date(row, 'pickup_date');
  if (!pick) throw new RowError(read.get(row, 'pickup_date') ? `Fecha de entrega no reconocida: ${read.get(row, 'pickup_date')}` : 'Falta la fecha de entrega');
  const pickTime = parseTime(read.get(row, 'pickup_time')) || pick.time || '10:00';
  let ret = read.date(row, 'return_date');
  if (!ret && read.get(row, 'days')) {
    const days = Math.round(parseAmount(read.get(row, 'days')) || 0);
    if (days > 0) ret = { date: addDays(pick.date, days), time: null };
  }
  if (!ret) throw new RowError(read.get(row, 'return_date') ? `Fecha de devolución no reconocida: ${read.get(row, 'return_date')}` : 'Falta la fecha de devolución');
  const retTime = parseTime(read.get(row, 'return_time')) || ret.time || pickTime;
  const pickup_at = `${pick.date}T${pickTime}`;
  const return_at = `${ret.date}T${retTime}`;
  if (return_at <= pickup_at) throw new RowError('La devolución es anterior o igual a la entrega');

  // Duplicados: mismo número del sistema anterior, o mismo cliente con las mismas fechas.
  const externalId = read.get(row, 'external_id') || null;
  const dup = externalId
    ? db.prepare("SELECT code FROM reservations WHERE source = 'importado' AND external_id = ?").get(externalId)
    : db.prepare('SELECT code FROM reservations WHERE customer_id = ? AND pickup_at = ? AND return_at = ?').get(customerId, pickup_at, return_at);
  if (dup) return { action: 'omitido', id: null, label: `${name || 'Cliente'} · ${pick.date}`, message: `Ya estaba importada (${dup.code})` };

  // Vehículo y categoría.
  let vehicle = null;
  let category = null;
  const plateText = read.get(row, 'plate');
  if (plateText) {
    vehicle = db
      .prepare('SELECT * FROM vehicles')
      .all()
      .find((v) => compactPlate(v.plate) === compactPlate(plateText));
    if (!vehicle) {
      category = lookup(db, 'categories', plateText);
      if (!category) warn(`Auto "${plateText}" no está en la flota: la reserva queda sin auto asignado`);
    }
  }
  const catText = read.get(row, 'category');
  if (catText) {
    const c = lookup(db, 'categories', catText);
    if (c) category = c;
    else warn(`Categoría "${catText}" desconocida`);
  }
  if (vehicle) {
    if (category && category.id !== vehicle.category_id) warn(`La patente ${vehicle.plate} es de otra categoría: se usó la del auto`);
    category = db.prepare('SELECT * FROM categories WHERE id = ?').get(vehicle.category_id);
  }
  if (!category && options.default_category_id) category = db.prepare('SELECT * FROM categories WHERE id = ?').get(options.default_category_id);
  if (!category) throw new RowError('No se pudo saber la categoría (agregá la columna, la patente o elegí una categoría por defecto)');

  // Estado: el del archivo o, si no viene, según las fechas.
  const statusText = read.get(row, 'status');
  let status = statusText ? reservationStatus(statusText) : undefined;
  if (status === null) warn(`Estado "${statusText}" no reconocido: se dedujo por las fechas`);
  const now = nowLocal();
  if (!status) status = return_at < now ? 'finalizada' : pickup_at <= now && vehicle ? 'en_curso' : 'confirmada';
  const blocking = ['pendiente', 'confirmada', 'en_curso'].includes(status);
  if (vehicle && blocking && !isVehicleFree(db, { vehicle_id: vehicle.id, pickup_at, return_at })) {
    warn(`El auto ${vehicle.plate} ya está ocupado en esas fechas (o fuera de servicio): la reserva queda sin auto asignado`);
    vehicle = null;
  }
  if (status === 'en_curso' && !vehicle) {
    status = 'confirmada';
    warn('Figura entregada pero sin auto: quedó confirmada; asigná el auto y registrá la entrega');
  }

  // Importes.
  let total;
  let pricing;
  const totalText = read.get(row, 'total');
  if (totalText && parseAmount(totalText) !== undefined) {
    total = round2(parseAmount(totalText));
    pricing = { source: 'importado', total };
  } else {
    if (totalText) warn(`Total no reconocido: ${totalText}`);
    try {
      pricing = computeQuote(db, { category_id: category.id, pickup_at, return_at, pickup_branch_id: null, return_branch_id: null, extras: [] });
      total = pricing.total;
      warn('Sin total en el archivo: se calculó con la tarifa actual');
    } catch {
      total = 0;
      pricing = { source: 'importado', total: 0 };
      warn('Sin total: quedó en $0');
    }
  }
  const days = rentalDays(pickup_at, return_at, Number(settings.grace_hours) || 0);

  const branch = (key) => {
    const text = read.get(row, key);
    if (!text) return null;
    const b = lookup(db, 'branches', text);
    if (!b) warn(`Lugar "${text}" desconocido: no se asignó`);
    return b ? b.id : null;
  };
  const pickupBranch = branch('pickup_branch');
  const returnBranch = branch('return_branch') || pickupBranch;

  const code = nextCode(db, 'R');
  const r = db
    .prepare(
      `INSERT INTO reservations (code, customer_id, category_id, vehicle_id, pickup_branch_id, return_branch_id, pickup_at, return_at,
        status, source, external_id, days, pricing, total, deposit, discount_pct, flight, notes, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'importado', ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
    )
    .run(
      code,
      customerId,
      category.id,
      vehicle ? vehicle.id : null,
      pickupBranch,
      returnBranch,
      pickup_at,
      return_at,
      status,
      externalId,
      days,
      JSON.stringify(pricing),
      total,
      read.get(row, 'flight') || null,
      joinNotes(read.get(row, 'notes'), read.extra(row)),
      userId || null,
      now,
    );
  const rid = Number(r.lastInsertRowid);
  if (status === 'en_curso') {
    // Ya está en la calle: se abre el contrato para poder registrar la devolución desde la app.
    db.prepare('INSERT INTO contracts (reservation_id, number, out_at, out_km, out_fuel, out_notes, out_user, damages) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      rid,
      nextCode(db, 'C'),
      pickup_at,
      vehicle.km,
      vehicle.fuel,
      'Entregado antes de usar este sistema (importado)',
      userId || null,
      JSON.stringify({ out: [] }),
    );
    db.prepare("UPDATE vehicles SET status = 'alquilado' WHERE id = ?").run(vehicle.id);
    warn('Se abrió el contrato con el km y combustible que figuran en la flota: revisalos');
  }
  const paidText = read.get(row, 'paid');
  if (paidText) {
    const paid = parseAmount(paidText);
    if (paid !== undefined && paid > 0) {
      db.prepare("INSERT INTO payments (reservation_id, kind, method, amount, reference, created_by) VALUES (?, 'pago', 'importado', ?, 'Sistema anterior', ?)").run(
        rid,
        round2(paid),
        userId || null,
      );
    } else if (paid === undefined && !/^(si|no|-)$/i.test(fold(paidText))) warn(`Pago no reconocido: ${paidText}`);
  }
  log(db, rid, userId, 'importada', { origen: 'sistema anterior', fila: row.line, ...(externalId ? { numero: externalId } : {}) });
  if (newCustomer) warn('Cliente nuevo: completá documento y licencia antes de entregar');
  return { action: 'creado', id: rid, label: `${code} · ${name || 'Cliente'} · ${pick.date}` };
}

const IMPORTERS = { clientes: importCustomer, flota: importVehicle, reservas: importReservation };

/**
 * Ejecuta la importación. Con dry_run todo corre igual pero al final se deshace,
 * así el informe muestra exactamente lo que va a pasar.
 */
function runImport(db, { kind, text, mapping = {}, options = {} }, userId) {
  const spec = kindSpec(kind);
  const { headers, rows } = parseTable(text);
  const missing = spec.fields.filter((f) => f.required && (mapping[f.key] === undefined || mapping[f.key] === null || mapping[f.key] === ''));
  // En reservas, el cliente puede identificarse sólo por documento o email.
  const customerAlt = kind === 'reservas' && ['customer_doc', 'customer_email'].some((k) => mapping[k] !== undefined && mapping[k] !== null && mapping[k] !== '');
  const reallyMissing = missing.filter((f) => !(f.key === 'customer_name' && customerAlt));
  if (reallyMissing.length) fail(400, `Indicá qué columna es: ${reallyMissing.map((f) => f.label).join(', ')}`);

  const opts = {
    mode: ['completar', 'reemplazar', 'omitir'].includes(options.mode) ? options.mode : 'completar',
    default_category_id: Number(options.default_category_id) || null,
    keep_extra: options.keep_extra !== false,
    dry_run: !!options.dry_run,
  };
  if (opts.default_category_id && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(opts.default_category_id)) fail(400, 'Categoría por defecto inexistente');

  const read = makeReader(spec, headers, rows, mapping, opts.keep_extra);
  const labels = Object.fromEntries(spec.fields.map((f) => [f.key, f.label]));
  const report = { kind, dry_run: opts.dry_run, total: rows.length, counts: { creado: 0, actualizado: 0, sin_cambios: 0, omitido: 0, error: 0 }, warnings: 0, rows: [] };
  const importer = IMPORTERS[kind];

  db.exec('BEGIN');
  try {
    const ctx = { read, idx: makeIndex(db), mode: opts.mode, options: opts, settings: getSettings(db), userId, label: (k) => labels[k] || k };
    for (const row of rows) {
      const messages = [];
      ctx.warn = (m) => messages.push(m);
      db.exec('SAVEPOINT fila');
      let result;
      try {
        result = importer(db, ctx, row);
        db.exec('RELEASE fila');
      } catch (err) {
        db.exec('ROLLBACK TO fila');
        db.exec('RELEASE fila');
        const known = err instanceof RowError || (err && err.status);
        if (!known) console.error('Importación, fila', row.line, err);
        result = { action: 'error', label: '', message: known ? err.message : 'No se pudo guardar esta fila' };
      }
      report.counts[result.action] = (report.counts[result.action] || 0) + 1;
      if (result.action !== 'error') report.warnings += messages.length;
      report.rows.push({ line: row.line, action: result.action, label: result.label || '', messages: [result.message, ...messages].filter(Boolean) });
    }
    db.exec(opts.dry_run ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return report;
}

module.exports = { KINDS, LIMITS, parseTable, suggestMapping, analyze, runImport, parseDateValue, parseTime, parseFuel };
