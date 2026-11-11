'use strict';

const { round2, fmtLocal, parseLocal } = require('./util');

// Cómo mueve la caja cada movimiento: los pagos y las garantías entran, las devoluciones salen.
const SIGN = { pago: 1, devolucion: -1, garantia: 1, devolucion_garantia: -1 };
// payments.created_at está en hora universal ("2026-11-11 14:30:00").
const utc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

/**
 * Caja de un día: los movimientos de plata de esa fecha (hora de la agencia), de una sucursal o de todas.
 * La garantía solo cuenta en efectivo: con tarjeta es una preautorización y no entra plata.
 * No entran los pagos con un repuesto ni los que se trajeron del sistema anterior.
 * La sucursal es donde se cobró; en los movimientos viejos, la de retiro de la reserva.
 */
function cashDay(db, date, branch) {
  const start = parseLocal(`${date}T00:00`);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  const rows = db
    .prepare(
      `SELECT p.id, p.created_at, p.kind, COALESCE(p.method, 'efectivo') AS method, p.amount, p.reference, r.id AS reservation_id, r.code,
              c.full_name AS customer_name, b.name AS branch_name
       FROM payments p JOIN reservations r ON r.id = p.reservation_id JOIN customers c ON c.id = r.customer_id
       LEFT JOIN branches b ON b.id = COALESCE(p.branch_id, r.pickup_branch_id)
       WHERE p.created_at >= ? AND p.created_at < ? AND COALESCE(p.method, 'efectivo') NOT IN ('repuesto', 'importado')
         AND (p.kind IN ('pago', 'devolucion') OR COALESCE(p.method, 'efectivo') = 'efectivo')
         ${branch ? `AND COALESCE(p.branch_id, r.pickup_branch_id) = ${Number(branch)}` : ''}
       ORDER BY p.created_at, p.id`,
    )
    .all(utc(start), utc(end))
    .map(({ created_at, ...p }) => ({ ...p, at: fmtLocal(new Date(`${created_at.replace(' ', 'T')}Z`)), amount: round2((SIGN[p.kind] || 1) * p.amount) }));
  const byMethod = {};
  for (const p of rows) byMethod[p.method] = round2((byMethod[p.method] || 0) + p.amount);
  return {
    date,
    rows,
    by_method: Object.entries(byMethod).map(([method, amount]) => ({ method, amount })),
    total: round2(rows.reduce((a, p) => a + p.amount, 0)),
    cash: byMethod.efectivo || 0,
  };
}

module.exports = { cashDay };
