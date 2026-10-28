'use strict';

const express = require('express');
const { requireAdmin } = require('../auth');
const { normDate } = require('../util');

/**
 * Estadísticas de la agencia en un período (por fecha de retiro): qué autos y categorías se piden más,
 * cuánto se usa la flota, qué seguros y adicionales se llevan, de dónde vienen las reservas, daños y taller.
 * Sólo administradores: muestra lo cobrado, lo que falta cobrar y el resultado (cobrado menos taller).
 */
const ACTIVE = "r.status NOT IN ('cancelada','no_show')";
// Lo cobrado de una reserva: pagos menos devoluciones de dinero (la garantía no es ingreso).
const PAID = `(SELECT COALESCE(SUM(CASE WHEN p.kind = 'pago' THEN p.amount WHEN p.kind = 'devolucion' THEN -p.amount ELSE 0 END), 0)
  FROM payments p WHERE p.reservation_id = r.id)`;
const pad2 = (n) => String(n).padStart(2, '0');

function statsRoutes(db) {
  const router = express.Router();
  router.get('/stats', requireAdmin, (req, res) => res.json(computeStats(db, req.query)));
  return router;
}

/** Las estadísticas de una base: cada agencia ve las suyas y el dueño de Floty, las de cada agencia. */
function computeStats(db, query = {}) {
  // Por defecto: el mes en curso (un período cerrado, sin mezclar lo pasado con lo que viene).
  const now = new Date();
  const to = normDate(query.to) || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate())}`;
  const from = normDate(query.from) || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
  const periodDays = Math.max(1, Math.round((new Date(`${to}T12:00`) - new Date(`${from}T12:00`)) / 86400000) + 1);
  const inPeriod = 'substr(r.pickup_at, 1, 10) BETWEEN ? AND ?';
  const all = (sql, ...p) => db.prepare(sql).all(from, to, ...p);
  const one = (sql) => db.prepare(sql).get(from, to);

  const totals = one(`SELECT COUNT(*) AS requested,
      SUM(CASE WHEN ${ACTIVE} THEN 1 ELSE 0 END) AS rentals,
      SUM(CASE WHEN r.status IN ('cancelada','no_show') THEN 1 ELSE 0 END) AS cancelled,
      COALESCE(SUM(CASE WHEN ${ACTIVE} THEN COALESCE(c.final_total, r.total) ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ${ACTIVE} AND r.status IN ('pendiente','confirmada') THEN r.total ELSE 0 END), 0) AS booked_ahead,
      COALESCE(SUM(${PAID}), 0) AS collected,
      COALESCE(SUM(CASE WHEN ${ACTIVE} THEN r.days ELSE 0 END), 0) AS days
    FROM reservations r LEFT JOIN contracts c ON c.reservation_id = r.id WHERE ${inPeriod}`);
  // Taller del período (por fecha de entrada): lo que se resta para ver el resultado.
  const shopTotal = db.prepare('SELECT COALESCE(SUM(cost), 0) AS cost FROM maintenance WHERE start_date BETWEEN ? AND ?').get(from, to).cost;

  const categoryShop = db.prepare(
    'SELECT COALESCE(SUM(m.cost), 0) AS cost FROM maintenance m JOIN vehicles v ON v.id = m.vehicle_id WHERE v.category_id = ? AND m.start_date BETWEEN ? AND ?',
  );
  // Demanda por categoría, con la ocupación: días alquilados sobre los días que tenía la flota de esa categoría.
  const categories = all(
    `SELECT cat.id, cat.code, cat.name,
       COUNT(r.id) AS requested,
       SUM(CASE WHEN ${ACTIVE} THEN 1 ELSE 0 END) AS rentals,
       COALESCE(SUM(CASE WHEN ${ACTIVE} THEN r.days ELSE 0 END), 0) AS days,
       COALESCE(SUM(CASE WHEN ${ACTIVE} THEN r.total ELSE 0 END), 0) AS revenue,
       COALESCE(SUM(CASE WHEN r.id IS NOT NULL THEN ${PAID} ELSE 0 END), 0) AS collected,
       (SELECT COUNT(*) FROM vehicles v WHERE v.category_id = cat.id) AS fleet
     FROM categories cat LEFT JOIN reservations r ON r.category_id = cat.id AND ${inPeriod}
     GROUP BY cat.id`,
  )
    .map((c) => {
      const shop_cost = categoryShop.get(c.id, from, to).cost;
      return { ...c, shop_cost, net: c.collected - shop_cost, occupancy: c.fleet ? Math.min(100, Math.round((c.days / (c.fleet * periodDays)) * 100)) : null };
    })
    // Primero las que más dejan (resultado), no las que más se alquilan.
    .sort((a, b) => b.net - a.net || b.requested - a.requested || a.code.localeCompare(b.code));

  const shopCost = db.prepare('SELECT COALESCE(SUM(cost), 0) AS cost FROM maintenance WHERE vehicle_id = ? AND start_date BETWEEN ? AND ?');
  // Modelos más pedidos (marca y modelo del auto asignado) y cada auto con lo que rindió.
  const models = all(
    `SELECT v.brand, v.model, COUNT(*) AS rentals, SUM(r.days) AS days, SUM(r.total) AS revenue
     FROM reservations r JOIN vehicles v ON v.id = r.vehicle_id WHERE ${inPeriod} AND ${ACTIVE}
     GROUP BY v.brand, v.model ORDER BY revenue DESC, rentals DESC LIMIT 10`,
  );
  const vehicles = all(
    `SELECT v.id, v.plate, v.brand, v.model, cat.code AS category_code,
       COUNT(r.id) AS rentals, COALESCE(SUM(r.days), 0) AS days, COALESCE(SUM(r.total), 0) AS revenue,
       COALESCE(SUM(CASE WHEN r.id IS NOT NULL THEN ${PAID} ELSE 0 END), 0) AS collected
     FROM vehicles v JOIN categories cat ON cat.id = v.category_id
     LEFT JOIN reservations r ON r.vehicle_id = v.id AND ${inPeriod} AND ${ACTIVE}
     GROUP BY v.id`,
  )
    .map((v) => {
      const shop_cost = shopCost.get(v.id, from, to).cost;
      return { ...v, shop_cost, net: v.collected - shop_cost, occupancy: Math.min(100, Math.round((v.days / periodDays) * 100)) };
    })
    .sort((a, b) => b.net - a.net || a.plate.localeCompare(b.plate));

  // Seguros y adicionales que se llevan (en reservas que se concretaron o están por concretarse).
  const addons = all(
    `SELECT e.name, e.kind, e.deductible, COUNT(*) AS times
     FROM reservation_extras re JOIN extras e ON e.id = re.extra_id JOIN reservations r ON r.id = re.reservation_id
     WHERE ${inPeriod} AND ${ACTIVE} GROUP BY e.id ORDER BY times DESC`,
  );
  const withInsurance = one(
    `SELECT COUNT(DISTINCT r.id) AS n FROM reservations r JOIN reservation_extras re ON re.reservation_id = r.id
     JOIN extras e ON e.id = re.extra_id AND e.kind = 'seguro' WHERE ${inPeriod} AND ${ACTIVE}`,
  ).n;

  const sources = all(
    `SELECT r.source, COUNT(*) AS requested, SUM(CASE WHEN ${ACTIVE} THEN 1 ELSE 0 END) AS rentals,
       COALESCE(SUM(CASE WHEN ${ACTIVE} THEN r.total ELSE 0 END), 0) AS revenue
     FROM reservations r WHERE ${inPeriod} GROUP BY r.source ORDER BY requested DESC`,
  );

  // Daños: devoluciones con cargo por daños o con daños anotados.
  const damages = all(
    `SELECT r.code, r.id, v.plate, v.brand, v.model, c.in_at, c.charges, c.damages
     FROM contracts c JOIN reservations r ON r.id = c.reservation_id LEFT JOIN vehicles v ON v.id = r.vehicle_id
     WHERE ${inPeriod} AND c.in_at IS NOT NULL`,
  )
    .map((c) => {
      const charges = c.charges ? JSON.parse(c.charges) : { lines: [] };
      const amount = (charges.lines || []).filter((l) => l.concept === 'Daños').reduce((a, l) => a + l.amount, 0);
      const noted = ((c.damages ? JSON.parse(c.damages) : {}).in || []).length;
      return { id: c.id, code: c.code, plate: c.plate, vehicle: [c.brand, c.model].filter(Boolean).join(' '), at: c.in_at, amount, noted };
    })
    .filter((d) => d.amount > 0 || d.noted > 0);

  const shop = db
    .prepare(
      `SELECT m.kind, COUNT(*) AS jobs, COALESCE(SUM(m.cost), 0) AS cost FROM maintenance m
       WHERE m.start_date BETWEEN ? AND ? GROUP BY m.kind ORDER BY cost DESC`,
    )
    .all(from, to);

  return {
    from,
    to,
    period_days: periodDays,
    totals: {
      ...totals,
      to_collect: Math.max(0, totals.revenue - totals.collected),
      shop_cost: shopTotal,
      net: totals.collected - shopTotal,
      avg_ticket: totals.rentals ? Math.round(totals.revenue / totals.rentals) : 0,
      avg_days: totals.rentals ? Math.round((totals.days / totals.rentals) * 10) / 10 : 0,
      with_insurance: withInsurance,
    },
    categories,
    models,
    vehicles,
    insurance: addons.filter((a) => a.kind === 'seguro'),
    extras: addons.filter((a) => a.kind !== 'seguro'),
    sources,
    damages,
    shop,
  };
}

module.exports = { statsRoutes, computeStats };
