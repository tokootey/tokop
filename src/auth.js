'use strict';

const crypto = require('node:crypto');
const { getSetting } = require('./db');
const { fail, HttpError } = require('./util');

const SESSION_DAYS = 7;

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

function login(db, email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(String(email || ''));
  if (!user || !verifyPassword(password, user.password_hash)) fail(401, 'Email o contraseña incorrectos');
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
}

/** Middleware: requiere sesión de usuario (header Authorization: Bearer <token>). */
function requireUser(db) {
  return (req, _res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next(new HttpError(401, 'Sesión requerida'));
    const row = db
      .prepare(
        `SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`,
      )
      .get(token, new Date().toISOString());
    if (!row) return next(new HttpError(401, 'Sesión vencida, volvé a ingresar'));
    req.user = { ...row };
    req.token = token;
    next();
  };
}

function requireAdmin(req, _res, next) {
  if (!req.user || req.user.role !== 'admin') return next(new HttpError(403, 'Sólo administradores'));
  next();
}

/** Middleware para la API pública del cotizador: header X-API-Key o ?api_key=. */
function requireApiKey(db) {
  return (req, _res, next) => {
    const key = req.get('x-api-key') || req.query.api_key;
    const expected = getSetting(db, 'api_key');
    const a = Buffer.from(String(key || ''));
    const b = Buffer.from(String(expected || ''));
    const ok = a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) return next(new HttpError(401, 'API key inválida'));
    next();
  };
}

module.exports = { hashPassword, verifyPassword, login, requireUser, requireAdmin, requireApiKey };
