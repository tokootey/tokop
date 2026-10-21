'use strict';

const { parseLocal } = require('./util');

/**
 * Política de devolución de dinero al cancelar (cada empresa la configura en Ajustes):
 *   - cancela con `refund_full_hours` horas o más antes del retiro → 100 % de lo pagado;
 *   - con `refund_partial_hours` horas o más → `refund_partial_pct` %;
 *   - con menos, o si no se presenta → nada.
 * Sólo calcula y deja registrado cuánto corresponde: no mueve plata. La garantía (depósito) va aparte y se devuelve entera.
 */
const DEFAULTS = { full: 72, partial: 24, pct: 50 };

function policyOf(s) {
  const num = (v, d) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? d : Number(v));
  const full = Math.max(0, num(s.refund_full_hours, DEFAULTS.full));
  return {
    full,
    partial: Math.min(full, Math.max(0, num(s.refund_partial_hours, DEFAULTS.partial))),
    pct: Math.min(100, Math.max(0, num(s.refund_partial_pct, DEFAULTS.pct))),
  };
}

/**
 * Cuánto corresponde devolver de una reserva (con su balance) si se cancela en `at`.
 * `reason`: 'cancelada' o 'no_show' (si no se presentó, no hay devolución).
 */
function refundFor(r, settings, at = new Date(), reason = 'cancelada') {
  const p = policyOf(settings);
  const hours = Math.round(((parseLocal(r.pickup_at) - at) / 3600000) * 10) / 10;
  const pct = reason === 'no_show' ? 0 : hours >= p.full ? 100 : hours >= p.partial ? p.pct : 0;
  const paid = Math.max(0, (r.balance && r.balance.paid) || 0);
  return {
    hours_before: hours,
    percent: pct,
    paid,
    amount: Math.round(paid * pct) / 100,
    rule: reason === 'no_show' ? 'no se presentó' : hours >= p.full ? `${p.full} h o más antes` : hours >= p.partial ? `entre ${p.full} y ${p.partial} h antes` : `menos de ${p.partial} h antes`,
  };
}

module.exports = { refundFor, policyOf };
