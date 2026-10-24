'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { getSetting } = require('./db');
const { fail } = require('./util');

/**
 * Entrega y devolución en un hotel: el auto se lleva al hotel del cliente.
 * Los datos los carga la agencia, o el cliente con un link propio de la reserva (/hotel/<código>).
 * Se guardan como JSON en reservations.hotel; el lugar se muestra como "Hotel: <nombre>" en todas las pantallas.
 */
const TEXT_MAX = { name: 120, address: 200, room: 30, contact: 80, notes: 500 };

/** Normaliza lo que viene del formulario. null = no hay entrega ni devolución en hotel. */
function normalizeHotel(h) {
  if (!h || typeof h !== 'object') return null;
  const flag = (v) => v === true || v === 1 || v === '1' || v === 'on';
  const out = { deliver: flag(h.deliver) ? 1 : 0, return: flag(h.return) ? 1 : 0 };
  if (!out.deliver && !out.return) return null;
  for (const [k, max] of Object.entries(TEXT_MAX)) out[k] = String(h[k] ?? '').trim().slice(0, max);
  out.label = out.name ? `${out.name}${out.room ? ` · hab. ${out.room}` : ''}` : 'a confirmar';
  return out;
}

/** Falta lo básico para llevar el auto: el nombre y la dirección del hotel. */
const hotelMissing = (h) => Boolean(h && (!h.name || !h.address));

/** SQL del lugar de retiro o devolución: el hotel si corresponde, si no la sucursal. */
const placeSql = (flag, branch) => `CASE WHEN json_extract(r.hotel, '$.${flag}') = 1 THEN 'Hotel: ' || json_extract(r.hotel, '$.label') ELSE ${branch}.name END`;

/** Guarda los datos del hotel; la primera vez crea el código del link para el cliente. */
function saveHotel(db, id, input, userId, log) {
  const h = normalizeHotel(input);
  const r = db.prepare('SELECT hotel_token FROM reservations WHERE id = ?').get(id);
  const token = h && !r.hotel_token ? crypto.randomBytes(18).toString('base64url') : r.hotel_token;
  db.prepare('UPDATE reservations SET hotel = ?, hotel_token = ? WHERE id = ?').run(h ? JSON.stringify(h) : null, token, id);
  if (log) log(db, id, userId, 'hotel', h ? { hotel: h.label, entrega: Boolean(h.deliver), devolucion: Boolean(h.return) } : 'sin hotel');
  return h;
}

/** Página del cliente: ver y completar los datos del hotel de su reserva. Sin usuario: el código del link es la llave. */
function hotelRoutes(db, log) {
  const router = express.Router();
  const find = (token) => {
    const r = db
      .prepare(
        `SELECT r.id, r.code, r.status, r.pickup_at, r.return_at, r.hotel, c.full_name AS customer_name
         FROM reservations r JOIN customers c ON c.id = r.customer_id WHERE r.hotel_token = ?`,
      )
      .get(String(token || ''));
    if (!r || !r.hotel || !['pendiente', 'confirmada', 'en_curso'].includes(r.status)) fail(404, 'Este link ya no está disponible');
    return { ...r, hotel: JSON.parse(r.hotel) };
  };
  router.get('/:token', (req, res) => {
    const r = find(req.params.token);
    res.json({
      company: getSetting(db, 'company_name') || '',
      code: r.code,
      first_name: String(r.customer_name || '').split(' ')[0],
      pickup_at: r.pickup_at,
      return_at: r.return_at,
      hotel: r.hotel,
    });
  });
  router.post('/:token', (req, res) => {
    const r = find(req.params.token);
    const b = req.body || {};
    if (!String(b.name || '').trim() || !String(b.address || '').trim()) fail(400, 'Poné el nombre y la dirección del hotel');
    // El cliente completa los datos; si la entrega o la devolución son en el hotel lo decide la agencia.
    const h = saveHotel(db, r.id, { ...b, deliver: r.hotel.deliver, return: r.hotel.return }, null, null);
    log(db, r.id, null, 'hotel_completado_por_cliente', { hotel: h.label });
    res.json({ ok: true, hotel: h });
  });
  return router;
}

module.exports = { normalizeHotel, hotelMissing, placeSql, saveHotel, hotelRoutes };
