'use strict';

const express = require('express');
const { requireApiKey } = require('../auth');
const { computeQuote } = require('../pricing');
const { categoryAvailability } = require('../availability');
const { ingestQuote, reservationFromQuote, findByCodeOrName } = require('../integration');
const { getReservation, changeStatus, publicView } = require('../reservations');
const { getSetting } = require('../db');
const { fail, normDateTime } = require('../util');

/**
 * API pública para el cotizador (autenticada con X-API-Key).
 * Permite consultar catálogo, disponibilidad y precios, y crear/consultar/cancelar reservas.
 */
function publicRoutes(db) {
  const router = express.Router();
  router.use(requireApiKey(db));

  router.get('/catalog', (_req, res) => {
    res.json({
      currency: getSetting(db, 'currency'),
      branches: db.prepare('SELECT code, name, address, phone FROM branches WHERE active = 1 ORDER BY name').all(),
      categories: db
        .prepare(
          'SELECT code, name, description, daily_rate, weekly_rate, deposit, km_per_day, extra_km_rate, seats, transmission FROM categories WHERE active = 1 ORDER BY daily_rate',
        )
        .all(),
      extras: db.prepare('SELECT code, name, price, charge_type, max_price FROM extras WHERE active = 1 ORDER BY name').all(),
    });
  });

  const parseRange = (src) => {
    const pickup_at = normDateTime(src.pickup_at);
    const return_at = normDateTime(src.return_at);
    if (!pickup_at || !return_at) fail(400, 'pickup_at y return_at son obligatorios (YYYY-MM-DDTHH:MM)');
    const pickupBranch = findByCodeOrName(db, 'branches', src.pickup_branch);
    const returnBranch = findByCodeOrName(db, 'branches', src.return_branch) || pickupBranch;
    const extras = (Array.isArray(src.extras) ? src.extras : src.extras ? String(src.extras).split(',') : []).map((e) => {
      const key = typeof e === 'object' ? e.code : e;
      const extra = findByCodeOrName(db, 'extras', key);
      if (!extra) fail(422, `Adicional desconocido: "${key}"`);
      return { extra_id: extra.id, quantity: (typeof e === 'object' && e.quantity) || 1 };
    });
    return {
      pickup_at,
      return_at,
      pickup_branch_id: pickupBranch ? pickupBranch.id : null,
      return_branch_id: returnBranch ? returnBranch.id : null,
      extras,
    };
  };

  /** GET /availability?pickup_at=...&return_at=...&pickup_branch=...&return_branch=...&extras=GPS,SILLA */
  router.get('/availability', (req, res) => {
    const range = parseRange(req.query);
    res.json(
      categoryAvailability(db, range).map((c) => {
        const q = computeQuote(db, { ...range, category_id: c.id });
        return {
          category_code: c.code,
          category_name: c.name,
          available: c.available,
          days: q.days,
          total: q.total,
          deposit: q.deposit,
          currency: q.currency,
          breakdown: q,
        };
      }),
    );
  });

  /** POST /quote { category_code, pickup_at, return_at, pickup_branch, return_branch, extras } */
  router.post('/quote', (req, res) => {
    const range = parseRange(req.body || {});
    const cat = findByCodeOrName(db, 'categories', req.body.category_code);
    if (!cat) fail(422, 'category_code desconocido');
    const avail = categoryAvailability(db, range).find((c) => c.id === cat.id);
    res.json({ available: avail ? avail.available : 0, ...computeQuote(db, { ...range, category_id: cat.id }) });
  });

  /**
   * POST /reservations — crea una reserva a partir de una cotización aceptada, en formato canónico:
   * { id, customer: {...}, category_code, pickup_at, return_at, pickup_branch, return_branch, extras, total, flight, notes }
   */
  router.post('/reservations', (req, res) => {
    const b = req.body || {};
    const { reservation, duplicated } = reservationFromQuote(db, {
      external_id: b.id || b.external_id,
      customer: b.customer || {},
      category_code: b.category_code,
      pickup_at: b.pickup_at,
      return_at: b.return_at,
      pickup_branch: b.pickup_branch,
      return_branch: b.return_branch,
      extras: b.extras,
      total: b.total,
      flight: b.flight,
      notes: b.notes,
    });
    res.status(duplicated ? 200 : 201).json({ duplicated, reservation: publicView(reservation) });
  });

  router.get('/reservations/:code', (req, res) => {
    const r = getReservation(db, req.params.code) || findByExternal(req.params.code);
    if (!r) fail(404, 'Reserva inexistente');
    res.json(publicView(r));
  });

  router.post('/reservations/:code/cancel', (req, res) => {
    const r = getReservation(db, req.params.code) || findByExternal(req.params.code);
    if (!r) fail(404, 'Reserva inexistente');
    res.json(publicView(changeStatus(db, r.id, 'cancelada', null, (req.body && req.body.reason) || 'Cancelada desde el cotizador')));
  });

  /**
   * POST /quotes/inbound — webhook genérico: el cotizador envía la cotización en SU formato
   * y se traduce con el mapeo configurado en la pantalla "Cotizador".
   */
  router.post('/quotes/inbound', (req, res) => {
    const result = ingestQuote(db, req.body || {});
    res.status(result.duplicated ? 200 : 201).json(result);
  });

  function findByExternal(externalId) {
    const row = db.prepare('SELECT id FROM reservations WHERE external_id = ? ORDER BY id DESC LIMIT 1').get(String(externalId));
    return row ? getReservation(db, row.id) : null;
  }

  return router;
}

module.exports = { publicRoutes };
