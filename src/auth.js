'use strict';

const crypto = require('node:crypto');
const { getSetting } = require('./db');
const { fail, HttpError } = require('./util');

const COOKIE = 'rc_session';
const IDLE_HOURS = 12; // la sesión vence tras 12 h sin uso
const MAX_DAYS = 7; // y siempre a los 7 días, aunque se use
const DEFAULT_PASSWORD = 'admin123';

/* ---------- Contraseñas ---------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === test.length && crypto.timingSafeEqual(expected, test);
}

const COMMON = ['12345678', '123456789', '1234567890', 'password', 'contraseña', 'contrasena', 'qwerty123', 'admin123', 'administrador', 'rentacar', 'ushuaia1'];

/** Devuelve el motivo por el que la contraseña no sirve, o null si está bien. */
function passwordProblem(password, email = '') {
  const p = String(password || '');
  if (p.length < 8) return 'La contraseña debe tener al menos 8 caracteres';
  if (!/[a-zA-Z]/.test(p) || !/\d/.test(p)) return 'La contraseña debe tener letras y números';
  const lower = p.toLowerCase();
  if (COMMON.some((c) => lower.includes(c))) return 'La contraseña es demasiado fácil de adivinar';
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return 'La contraseña no puede contener el usuario';
  return null;
}

function assertPassword(password, email) {
  const problem = passwordProblem(password, email);
  if (problem) fail(400, problem);
}

/* ---------- Registro de actividad ---------- */

function audit(db, req, action, detail, user) {
  const u = user || (req && req.user) || {};
  try {
    db.prepare('INSERT INTO audit_log (at, user_id, email, ip, action, detail) VALUES (?, ?, ?, ?, ?, ?)').run(
      new Date().toISOString(),
      u.id || null,
      u.email || null,
      req ? req.ip || null : null,
      action,
      detail ? String(detail).slice(0, 500) : null,
    );
  } catch {
    /* el registro nunca debe impedir la operación */
  }
}

/* ---------- Bloqueo por intentos fallidos ---------- */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_ACCOUNT = 5;
const MAX_PER_IP = 20;
const failures = new Map();

function tooMany(key, max) {
  const now = Date.now();
  if (failures.size > 5000) {
    for (const [k, list] of failures) if (!list.some((t) => now - t < WINDOW_MS)) failures.delete(k);
  }
  const list = (failures.get(key) || []).filter((t) => now - t < WINDOW_MS);
  failures.set(key, list);
  return list.length >= max;
}
function addFailure(key) {
  const list = failures.get(key) || [];
  list.push(Date.now());
  failures.set(key, list);
}

/* ---------- Sesiones (cookie HttpOnly; en la base sólo se guarda el hash del token) ---------- */

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieOptions(req) {
  return { httpOnly: true, sameSite: 'strict', secure: Boolean(req.secure), path: '/', maxAge: MAX_DAYS * 86400000 };
}

function login(db, req, res) {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = (req.body && req.body.password) || '';
  const ipKey = `ip:${req.ip}`;
  const accKey = `acc:${email}`;
  if (tooMany(accKey, MAX_PER_ACCOUNT) || tooMany(ipKey, MAX_PER_IP)) {
    audit(db, req, 'login_bloqueado', null, { email });
    fail(429, 'Demasiados intentos fallidos. Esperá 15 minutos y volvé a probar.');
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    addFailure(accKey);
    addFailure(ipKey);
    audit(db, req, 'login_fallido', null, { email });
    fail(401, 'Email o contraseña incorrectos');
  }
  failures.delete(accKey);

  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at, last_seen) VALUES (?, ?, ?, ?, ?)').run(
    hashToken(token),
    user.id,
    new Date(now.getTime() + IDLE_HOURS * 3600000).toISOString(),
    now.toISOString(),
    now.toISOString(),
  );
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
  res.cookie(COOKIE, token, cookieOptions(req));
  audit(db, req, 'login', null, user);
  return publicUser(user);
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, must_change_password: Boolean(u.must_change_password) });

function logout(db, req, res) {
  if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionHash);
  res.clearCookie(COOKIE, { ...cookieOptions(req), maxAge: undefined });
  audit(db, req, 'logout');
}

/** Middleware: requiere una sesión válida (cookie). Renueva el vencimiento por inactividad. */
function requireUser(db) {
  return (req, _res, next) => {
    const token = parseCookies(req.get('cookie'))[COOKIE];
    if (!token) return next(new HttpError(401, 'Sesión requerida'));
    const h = hashToken(token);
    const now = new Date();
    const row = db
      .prepare(
        `SELECT u.id, u.name, u.email, u.role, u.must_change_password, s.created_at, s.last_seen
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`,
      )
      .get(h, now.toISOString());
    if (!row || (row.created_at && now - new Date(row.created_at) > MAX_DAYS * 86400000)) {
      return next(new HttpError(401, 'Sesión vencida, volvé a ingresar'));
    }
    // Renovar como mucho una vez por minuto.
    if (!row.last_seen || now - new Date(row.last_seen) > 60000) {
      db.prepare('UPDATE sessions SET expires_at = ?, last_seen = ? WHERE token = ?').run(
        new Date(now.getTime() + IDLE_HOURS * 3600000).toISOString(),
        now.toISOString(),
        h,
      );
    }
    req.user = { id: row.id, name: row.name, email: row.email, role: row.role, must_change_password: Boolean(row.must_change_password) };
    req.sessionHash = h;
    next();
  };
}

/** Mientras el usuario tenga que cambiar la contraseña, sólo puede hacer eso. */
function requirePasswordChanged(req, _res, next) {
  if (req.user && req.user.must_change_password) {
    const err = new HttpError(403, 'Tenés que cambiar la contraseña antes de seguir');
    err.details = { code: 'password_change_required' };
    return next(err);
  }
  next();
}

function changePassword(db, req) {
  const { current, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current, u.password_hash)) {
    audit(db, req, 'cambio_clave_fallido');
    fail(400, 'La contraseña actual no es correcta');
  }
  if (String(password) === String(current)) fail(400, 'La contraseña nueva tiene que ser distinta de la actual');
  assertPassword(password, u.email);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(password), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(u.id, req.sessionHash);
  audit(db, req, 'cambio_clave');
}

function requireAdmin(req, _res, next) {
  if (!req.user || req.user.role !== 'admin') return next(new HttpError(403, 'Sólo administradores'));
  next();
}

/** Middleware para la API pública del cotizador: header X-API-Key (nunca en la URL, para que no quede en registros). */
function requireApiKey(db) {
  return (req, _res, next) => {
    const key = req.get('x-api-key');
    const expected = getSetting(db, 'api_key');
    const a = Buffer.from(String(key || ''));
    const b = Buffer.from(String(expected || ''));
    const ok = a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) return next(new HttpError(401, 'API key inválida'));
    next();
  };
}

module.exports = {
  DEFAULT_PASSWORD,
  hashPassword,
  verifyPassword,
  passwordProblem,
  assertPassword,
  audit,
  login,
  logout,
  requireUser,
  requirePasswordChanged,
  changePassword,
  requireAdmin,
  requireApiKey,
  publicUser,
};
