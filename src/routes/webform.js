'use strict';

const express = require('express');
const { getSettings } = require('../db');
const { ingestQuote } = require('../integration');

/**
 * Recepción del formulario de cotización del sitio web (p. ej. discoverushuaia.com.ar).
 *
 * No usa API key (el formulario es público), así que se protege con:
 *  - lista de orígenes permitidos (header Origin),
 *  - campo trampa anti-spam (`_gotcha`): si viene completo se descarta en silencio,
 *  - límite de envíos por IP.
 * Las solicitudes web siempre entran como reserva "pendiente" para que el mostrador las confirme.
 */
function webformRoutes(db) {
  const router = express.Router();
  const hits = new Map();
  const LIMIT = 20;
  const WINDOW_MS = 10 * 60 * 1000;

  const rateLimited = (ip) => {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    list.push(now);
    hits.set(ip, list);
    return list.length > LIMIT;
  };

  const wantsHtml = (req) => !req.is('application/json') && (req.accepts(['json', 'html']) === 'html' || req.is('application/x-www-form-urlencoded'));

  function reply(req, res, settings, status, ok, data) {
    if (wantsHtml(req) && !req.get('x-requested-with')) {
      if (ok && settings.webform_redirect_url) return res.redirect(303, settings.webform_redirect_url);
      const title = ok ? '¡Gracias! Recibimos tu solicitud' : 'No pudimos registrar tu solicitud';
      const msg = ok
        ? 'Te vamos a contactar a la brevedad para confirmar la disponibilidad y el precio final.'
        : 'Por favor intentá nuevamente o comunicate con nosotros por teléfono o WhatsApp.';
      return res
        .status(status)
        .type('html')
        .send(
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
            `<body style="font-family:system-ui;max-width:520px;margin:60px auto;padding:0 16px;text-align:center"><h1>${title}</h1><p>${msg}</p>` +
            `<p><a href="javascript:history.back()">Volver</a></p></body>`,
        );
    }
    return res.status(status).json({ ok, ...data });
  }

  router.post('/', express.urlencoded({ extended: true, limit: '200kb' }), (req, res) => {
    const settings = getSettings(db);
    if (settings.webform_enabled !== '1') return reply(req, res, settings, 403, false, { error: 'Formulario web deshabilitado' });

    const origin = req.get('origin');
    const allowed = String(settings.webform_allowed_origins || '')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean);
    if (origin && allowed.length && !allowed.includes(origin.replace(/\/$/, ''))) {
      return reply(req, res, settings, 403, false, { error: 'Origen no permitido' });
    }
    if (rateLimited(req.ip)) return reply(req, res, settings, 429, false, { error: 'Demasiados envíos, probá en unos minutos' });

    const payload = { ...(req.body || {}) };
    if (payload._gotcha) return reply(req, res, settings, 200, true, {});
    delete payload._gotcha;

    try {
      const result = ingestQuote(db, payload, undefined, 'web');
      return reply(req, res, settings, 201, true, { code: result.reservation.code });
    } catch (err) {
      // La solicitud queda igual en la bandeja (con error) para que el mostrador la gestione a mano.
      return reply(req, res, settings, 202, true, { pending_review: true, message: err.message });
    }
  });

  return router;
}

module.exports = { webformRoutes };
