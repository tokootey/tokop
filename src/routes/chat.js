'use strict';

const express = require('express');
const { getSettings } = require('../db');
const { computeQuote } = require('../pricing');
const { categoryAvailability } = require('../availability');
const { ingestQuote } = require('../integration');
const { fail, normDateTime, nowLocal } = require('../util');

/**
 * Asistente de reservas: el chat que la agencia pone en su página web con una línea
 * (<script src="https://SERVIDOR/chat.js"></script>).
 *
 * Responde la disponibilidad y el precio de cada categoría, contesta las preguntas frecuentes y
 * deja la reserva como "pendiente" para que el mostrador la confirme. No usa API key (corre en
 * la página pública), así que se protege igual que el formulario web: sitios autorizados,
 * campo trampa, límite de consultas por IP y largo máximo de cada dato.
 */
const MAX_TEXT = 300;
const FAQ_DEFAULT = [
  'Requisitos | Licencia de conducir vigente, documento o pasaporte y tarjeta de crédito para la garantía.',
  'Edad mínima | {edad_minima} años.',
  'Garantía | Se toma con tarjeta de crédito al retirar el auto y se libera al devolverlo en las mismas condiciones.',
  'Kilometraje | Depende de la categoría: te lo mostramos junto con el precio.',
].join('\n');

/** "Pregunta | Respuesta" por línea → [{ q, a }] */
function parseFaq(text, settings) {
  return String(text || '')
    .split('\n')
    .map((line) => line.split('|'))
    .filter((parts) => parts.length >= 2 && parts[0].trim() && parts.slice(1).join('|').trim())
    .slice(0, 20)
    .map(([q, ...a]) => ({ q: q.trim().slice(0, 120), a: a.join('|').trim().replace(/\{edad_minima\}/g, settings.min_driver_age || '21').slice(0, 600) }));
}

const str = (v, max = MAX_TEXT) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));

function chatRoutes(db) {
  const router = express.Router();

  const hits = new Map();
  const limited = (key, limit, windowMs) => {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, list] of hits) if (!list.some((t) => now - t < windowMs)) hits.delete(k);
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    return list.length > limit;
  };

  // Sólo responde si el asistente está activado y la consulta viene de la propia app o de un sitio autorizado.
  router.use((req, res, next) => {
    const settings = getSettings(db);
    if (settings.chat_enabled !== '1') return res.status(403).json({ error: 'El asistente está desactivado' });
    const origin = req.get('origin');
    const allowed = String(settings.webform_allowed_origins || '')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean);
    const own = origin && origin.replace(/\/$/, '') === `${req.protocol}://${req.get('host')}`;
    if (origin && !own && allowed.length && !allowed.includes(origin.replace(/\/$/, ''))) {
      return res.status(403).json({ error: 'Origen no permitido' });
    }
    req.settings = settings;
    next();
  });

  router.get('/config', (req, res) => {
    const s = req.settings;
    res.json({
      company: s.company_name,
      welcome: s.chat_welcome || `¡Hola! Elegí las fechas y te mostramos los autos disponibles de ${s.company_name} con su precio.`,
      whatsapp: str(s.chat_whatsapp, 30).replace(/[^\d]/g, ''),
      currency: s.currency,
      locale: s.locale,
      branches: db.prepare('SELECT code, name FROM branches WHERE active = 1 ORDER BY name').all(),
      faq: parseFaq(s.chat_faq || FAQ_DEFAULT, s),
    });
  });

  router.post('/quote', (req, res) => {
    if (limited(`q:${req.ip}`, 60, 10 * 60 * 1000)) fail(429, 'Demasiadas consultas, probá en unos minutos');
    const b = req.body || {};
    const pickup_at = normDateTime(str(b.pickup_at, 20));
    const return_at = normDateTime(str(b.return_at, 20));
    if (!pickup_at || !return_at) fail(400, 'Indicá las fechas de retiro y devolución');
    if (return_at <= pickup_at) fail(400, 'La devolución tiene que ser después del retiro');
    if (pickup_at.slice(0, 10) < nowLocal().slice(0, 10)) fail(400, 'La fecha de retiro ya pasó');
    const branch = b.pickup_branch ? db.prepare('SELECT id FROM branches WHERE code = ? AND active = 1').get(str(b.pickup_branch, 20)) : null;
    const range = { pickup_at, return_at, pickup_branch_id: branch ? branch.id : null, return_branch_id: branch ? branch.id : null };
    const options = categoryAvailability(db, range)
      .filter((c) => c.available > 0)
      .map((c) => {
        const q = computeQuote(db, { ...range, category_id: c.id });
        // Al público sólo se le muestra lo necesario: nunca cuántos autos quedan exactamente.
        return { code: c.code, name: c.name, description: c.description || '', seats: c.seats, transmission: c.transmission, days: q.days, total: q.total, deposit: q.deposit, few_left: c.available <= 1 };
      })
      .sort((a, b2) => a.total - b2.total);
    res.json({ pickup_at, return_at, options });
  });

  router.post('/book', (req, res) => {
    if (limited(`b:${req.ip}`, 5, 10 * 60 * 1000)) fail(429, 'Ya recibimos varias solicitudes, probá en unos minutos');
    const b = req.body || {};
    if (b._gotcha) return res.status(201).json({ ok: true }); // trampa para robots: se descarta en silencio
    const name = str(b.name, 120);
    const email = str(b.email, 160).toLowerCase();
    const phone = str(b.phone, 40);
    if (name.length < 3) fail(400, 'Decinos tu nombre y apellido');
    if (!email && !phone) fail(400, 'Dejanos un email o un teléfono para confirmarte');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'El email no parece válido');
    const payload = {
      nombre: name,
      email,
      telefono: phone,
      vehiculo: str(b.category, 20),
      fecha_retiro: str(b.pickup_at, 20),
      fecha_devolucion: str(b.return_at, 20),
      lugar_retiro: str(b.pickup_branch, 20),
      lugar_devolucion: str(b.pickup_branch, 20),
      vuelo: str(b.flight, 40),
      comentarios: ['Pedido desde el link de reservas', str(b.notes, 500)].filter(Boolean).join('. '),
    };
    try {
      const result = ingestQuote(db, payload, undefined, 'web');
      res.status(201).json({ ok: true, code: result.reservation.code });
    } catch {
      // Queda en la bandeja del cotizador para que la gestione una persona; al público no se le muestran detalles.
      res.status(202).json({ ok: true, pending_review: true });
    }
  });

  return router;
}

module.exports = { chatRoutes, parseFaq, FAQ_DEFAULT };
