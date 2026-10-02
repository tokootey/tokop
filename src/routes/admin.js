'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { getSettings, setSetting, newApiKey, DEFAULT_SETTINGS } = require('../db');
const { hashPassword, requireAdmin } = require('../auth');
const { getMapping, getWebformMapping, interpret, ingestQuote, reprocessInbox } = require('../integration');
const { emit } = require('../webhooks');
const { fail } = require('../util');

const SECRET_KEYS = ['api_key', 'webhook_secret'];
const INTEGRATION_KEYS = [
  'quote_mapping',
  'quote_price_source',
  'quote_auto_confirm',
  'webhook_url',
  'webform_enabled',
  'webform_mapping',
  'webform_allowed_origins',
  'webform_redirect_url',
];

function adminRoutes(db) {
  const router = express.Router();

  // --- Configuración general ---
  router.get('/settings', (_req, res) => {
    const s = getSettings(db);
    for (const k of [...SECRET_KEYS, ...INTEGRATION_KEYS]) delete s[k];
    res.json(s);
  });

  router.put('/settings', requireAdmin, (req, res) => {
    for (const [k, v] of Object.entries(req.body || {})) {
      if (k in DEFAULT_SETTINGS && !SECRET_KEYS.includes(k) && !INTEGRATION_KEYS.includes(k)) setSetting(db, k, v);
    }
    res.json({ ok: true });
  });

  // --- Usuarios ---
  router.get('/users', requireAdmin, (_req, res) => {
    res.json(db.prepare('SELECT id, name, email, role, active, created_at FROM users ORDER BY name').all());
  });

  router.post('/users', requireAdmin, (req, res) => {
    const { name, email, password, role } = req.body || {};
    if (!name || !email || !password) fail(400, 'Nombre, email y contraseña son obligatorios');
    if (String(password).length < 6) fail(400, 'La contraseña debe tener al menos 6 caracteres');
    try {
      const r = db
        .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
        .run(name, email, hashPassword(password), role === 'admin' ? 'admin' : 'operador');
      res.status(201).json({ id: Number(r.lastInsertRowid) });
    } catch (err) {
      if (/UNIQUE/.test(err.message)) fail(409, 'Ya existe un usuario con ese email');
      throw err;
    }
  });

  router.put('/users/:id', requireAdmin, (req, res) => {
    const { name, role, active, password } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) fail(404, 'Usuario inexistente');
    if (Number(req.params.id) === req.user.id && (role === 'operador' || active === 0 || active === false)) {
      fail(400, 'No podés quitarte permisos de administrador ni desactivarte');
    }
    db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(
      name || u.name,
      role === 'admin' || role === 'operador' ? role : u.role,
      active === undefined ? u.active : active ? 1 : 0,
      u.id,
    );
    if (password) {
      if (String(password).length < 6) fail(400, 'La contraseña debe tener al menos 6 caracteres');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(u.id, req.token);
    }
    res.json({ ok: true });
  });

  // --- Integración con el cotizador ---
  router.get('/integration', requireAdmin, (req, res) => {
    const s = getSettings(db);
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({
      api_key: s.api_key,
      webhook_url: s.webhook_url,
      webhook_secret: s.webhook_secret,
      quote_price_source: s.quote_price_source,
      quote_auto_confirm: s.quote_auto_confirm,
      mapping: getMapping(db),
      webform: {
        enabled: s.webform_enabled === '1',
        mapping: getWebformMapping(db),
        allowed_origins: s.webform_allowed_origins,
        redirect_url: s.webform_redirect_url,
        action_url: `${base}/api/public/webform`,
        script_tag: `<script src="${base}/webform.js" data-form="form"></script>`,
      },
      endpoints: {
        catalog: `${base}/api/public/v1/catalog`,
        availability: `${base}/api/public/v1/availability`,
        quote: `${base}/api/public/v1/quote`,
        reservations: `${base}/api/public/v1/reservations`,
        inbound_webhook: `${base}/api/public/v1/quotes/inbound`,
      },
      inbox: db.prepare('SELECT id, received_at, channel, external_id, status, message, reservation_id FROM quote_inbox ORDER BY id DESC LIMIT 100').all(),
      webhook_log: db.prepare('SELECT * FROM webhook_log ORDER BY id DESC LIMIT 50').all(),
      stats: db.prepare('SELECT status, COUNT(*) AS n FROM quote_inbox GROUP BY status').all(),
    });
  });

  router.put('/integration', requireAdmin, (req, res) => {
    const b = req.body || {};
    if (b.mapping !== undefined) {
      const mapping = typeof b.mapping === 'string' ? JSON.parse(b.mapping) : b.mapping;
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) fail(400, 'El mapeo debe ser un objeto JSON');
      setSetting(db, 'quote_mapping', JSON.stringify(mapping, null, 2));
    }
    if (b.webform_mapping !== undefined) {
      const m = typeof b.webform_mapping === 'string' ? JSON.parse(b.webform_mapping) : b.webform_mapping;
      if (!m || typeof m !== 'object' || Array.isArray(m)) fail(400, 'El mapeo del formulario debe ser un objeto JSON');
      setSetting(db, 'webform_mapping', JSON.stringify(m, null, 2));
    }
    if (b.webform_enabled !== undefined) setSetting(db, 'webform_enabled', b.webform_enabled ? '1' : '0');
    if (b.webform_allowed_origins !== undefined) setSetting(db, 'webform_allowed_origins', b.webform_allowed_origins);
    if (b.webform_redirect_url !== undefined) setSetting(db, 'webform_redirect_url', b.webform_redirect_url);
    if (b.quote_price_source !== undefined) setSetting(db, 'quote_price_source', b.quote_price_source === 'sistema' ? 'sistema' : 'cotizador');
    if (b.quote_auto_confirm !== undefined) setSetting(db, 'quote_auto_confirm', b.quote_auto_confirm ? '1' : '0');
    if (b.webhook_url !== undefined) {
      if (b.webhook_url && !/^https?:\/\//i.test(b.webhook_url)) fail(400, 'La URL del webhook debe empezar con http:// o https://');
      setSetting(db, 'webhook_url', b.webhook_url);
    }
    res.json({ ok: true });
  });

  router.post('/integration/regenerate-key', requireAdmin, (_req, res) => {
    const key = newApiKey();
    setSetting(db, 'api_key', key);
    res.json({ api_key: key });
  });

  router.post('/integration/regenerate-secret', requireAdmin, (_req, res) => {
    const secret = crypto.randomBytes(24).toString('hex');
    setSetting(db, 'webhook_secret', secret);
    res.json({ webhook_secret: secret });
  });

  /** Previsualiza cómo se interpreta un JSON del cotizador con el mapeo actual (no crea nada). */
  router.post('/integration/preview', requireAdmin, (req, res) => {
    const mapping = req.body.mapping ? (typeof req.body.mapping === 'string' ? JSON.parse(req.body.mapping) : req.body.mapping) : undefined;
    res.json(interpret(db, req.body.payload || {}, req.body.channel === 'web' ? 'web' : 'cotizador', mapping));
  });

  /** Importa manualmente una cotización (pegando el JSON) como si la hubiera enviado el cotizador. */
  router.post('/integration/import', (req, res) => {
    const payload = typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : req.body.payload;
    if (!payload || typeof payload !== 'object') fail(400, 'Pegá el JSON de la cotización');
    res.status(201).json(ingestQuote(db, payload, undefined, req.body.channel === 'web' ? 'web' : 'cotizador'));
  });

  router.post('/integration/inbox/:id/reprocess', (req, res) => res.json(reprocessInbox(db, Number(req.params.id))));

  router.get('/integration/inbox/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM quote_inbox WHERE id = ?').get(req.params.id);
    if (!row) fail(404, 'Registro inexistente');
    const payload = JSON.parse(row.payload);
    res.json({ ...row, payload, interpreted: interpret(db, payload, row.channel) });
  });

  router.post('/integration/test-webhook', requireAdmin, async (_req, res) => {
    const status = await emit(db, 'test', { message: 'Prueba de conexión desde el sistema de rent a car' });
    if (status === null) fail(400, 'Configurá primero la URL del webhook');
    res.json({ status });
  });

  return router;
}

module.exports = { adminRoutes };
