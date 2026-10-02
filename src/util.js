'use strict';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const fail = (status, message, details) => {
  throw new HttpError(status, message, details);
};

/**
 * Normaliza una fecha/hora a "YYYY-MM-DDTHH:MM" (hora local, sin zona).
 * Acepta "2026-10-02", "2026-10-02 10:00", "2026-10-02T10:00:00", "02/10/2026 10:00".
 */
function normDateTime(value, defaultTime = '10:00') {
  if (value === undefined || value === null || value === '') return null;
  let s = String(value).trim();
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T,]+(\d{1,2}):(\d{2}))?/);
  if (dmy) {
    const [, d, m, y, hh, mm] = dmy;
    s = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hh ? hh.padStart(2, '0') + ':' + mm : defaultTime}`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!iso) return null;
  const [, y, m, d, hh, mm] = iso;
  const out = `${y}-${m}-${d}T${hh ? `${hh}:${mm}` : defaultTime}`;
  return Number.isNaN(parseLocal(out).getTime()) ? null : out;
}

function normDate(value) {
  const dt = normDateTime(value);
  return dt ? dt.slice(0, 10) : null;
}

function parseLocal(s) {
  const [d, t = '00:00'] = s.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  return new Date(y, m - 1, day, hh, mm);
}

function fmtLocal(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

const nowLocal = () => fmtLocal(new Date());

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Convierte valores a tipos aceptados por node:sqlite. */
function sqlValue(v) {
  if (v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj && Object.prototype.hasOwnProperty.call(obj, f)) out[f] = sqlValue(obj[f]);
  return out;
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Lee un valor de un objeto usando una ruta con puntos: "cliente.datos.nombre" o "items.0.code". */
function getPath(obj, path) {
  if (!path) return undefined;
  return String(path)
    .split('.')
    .reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

module.exports = {
  HttpError,
  fail,
  normDateTime,
  normDate,
  parseLocal,
  fmtLocal,
  nowLocal,
  round2,
  sqlValue,
  pick,
  tx,
  getPath,
};
