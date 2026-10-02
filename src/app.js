'use strict';

const path = require('node:path');
const express = require('express');
const { login, requireUser, hashPassword } = require('./auth');
const { catalogRoutes } = require('./routes/catalog');
const { operationsRoutes } = require('./routes/operations');
const { adminRoutes } = require('./routes/admin');
const { publicRoutes } = require('./routes/public');
const { webformRoutes } = require('./routes/webform');
const { fileRoutes } = require('./routes/files');
const { HttpError } = require('./util');

/** Crea el usuario administrador inicial si no hay ninguno. */
function ensureAdmin(db) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return null;
  const email = process.env.ADMIN_EMAIL || 'admin@rentacar.local';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Administrador', ?, ?, 'admin')").run(email, hashPassword(password));
  return { email, password };
}

/**
 * @param {object} [options]
 * @param {string} [options.uploadsDir] carpeta de fotos y documentos (por defecto, junto a la base de datos).
 */
function createApp(db, options = {}) {
  const uploadsDir =
    options.uploadsDir ||
    process.env.UPLOADS_DIR ||
    path.join(path.dirname(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'rentacar.db')), 'uploads');
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.use(express.json({ limit: '1mb' }));

  // CORS sólo para la API pública (el cotizador puede llamarla desde el navegador).
  app.use('/api/public', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  app.use('/api/public/webform', webformRoutes(db));
  app.use('/api/public/v1', publicRoutes(db));

  app.post('/api/auth/login', (req, res) => res.json(login(db, req.body.email, req.body.password)));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  const auth = requireUser(db);
  app.get('/api/auth/me', auth, (req, res) => res.json(req.user));
  app.post('/api/auth/logout', auth, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.json({ ok: true });
  });
  app.use('/api', auth, catalogRoutes(db), operationsRoutes(db), fileRoutes(db, uploadsDir), adminRoutes(db));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Ruta inexistente')));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'El archivo es demasiado grande (máximo 20 MB)' });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'JSON inválido' });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (/UNIQUE constraint/i.test(err.message)) return res.status(409).json({ error: 'Ya existe un registro con ese código / dato único' });
    if (/FOREIGN KEY/i.test(err.message)) return res.status(409).json({ error: 'Referencia inválida o registro en uso' });
    console.error(err);
    res.status(500).json({ error: 'Error interno', detail: err.message });
  });

  return app;
}

module.exports = { createApp, ensureAdmin };
