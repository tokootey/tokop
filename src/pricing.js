'use strict';

const { getSettings } = require('./db');
const { parseLocal, fmtLocal, round2, fail } = require('./util');

/**
 * Días a cobrar: bloques de 24 h. Las horas que excedan el último bloque
 * sólo suman un día si superan la tolerancia (grace_hours).
 */
function rentalDays(pickupAt, returnAt, graceHours = 2) {
  const ms = parseLocal(returnAt) - parseLocal(pickupAt);
  if (!(ms > 0)) fail(400, 'La fecha de devolución debe ser posterior a la de retiro');
  const hours = ms / 3600000;
  const full = Math.floor(hours / 24);
  const rest = hours - full * 24;
  return Math.max(1, full + (rest > graceHours ? 1 : 0));
}

function seasonMultiplier(seasons, dateStr) {
  let mult = 1;
  for (const s of seasons) {
    if (dateStr >= s.start_date && dateStr <= s.end_date) mult = Math.max(mult, s.multiplier);
  }
  return mult;
}

/**
 * Calcula la cotización de un alquiler.
 * @returns desglose con base, temporada, adicionales, recargo one-way, descuento, impuestos y total.
 */
function computeQuote(db, input) {
  const settings = getSettings(db);
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(input.category_id);
  if (!category) fail(400, 'Categoría inexistente');

  const graceHours = Number(settings.grace_hours) || 0;
  const days = rentalDays(input.pickup_at, input.return_at, graceHours);

  // Tarifa diaria: si es 7 días o más y la categoría tiene tarifa semanal, se prorratea.
  const perDay = days >= 7 && category.weekly_rate > 0 ? category.weekly_rate / 7 : category.daily_rate;

  const seasons = db.prepare('SELECT * FROM seasons').all();
  let base = 0;
  let seasonExtra = 0;
  const start = parseLocal(input.pickup_at);
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const mult = seasonMultiplier(seasons, fmtLocal(d).slice(0, 10));
    base += perDay;
    seasonExtra += perDay * (mult - 1);
  }

  const extrasLines = [];
  for (const item of input.extras || []) {
    const extra = db.prepare('SELECT * FROM extras WHERE id = ?').get(item.extra_id);
    if (!extra) fail(400, `Adicional inexistente (${item.extra_id})`);
    const qty = Math.max(1, Number(item.quantity) || 1);
    let amount = extra.charge_type === 'fijo' ? extra.price * qty : extra.price * days * qty;
    if (extra.max_price > 0) amount = Math.min(amount, extra.max_price * qty);
    extrasLines.push({ extra_id: extra.id, name: extra.name, quantity: qty, amount: round2(amount) });
  }
  const extrasTotal = extrasLines.reduce((a, l) => a + l.amount, 0);

  const oneWay =
    input.pickup_branch_id && input.return_branch_id && Number(input.pickup_branch_id) !== Number(input.return_branch_id)
      ? Number(settings.one_way_fee) || 0
      : 0;

  const subtotal = base + seasonExtra + extrasTotal + oneWay;
  const discountPct = Math.min(100, Math.max(0, Number(input.discount_pct) || 0));
  const discount = (subtotal * discountPct) / 100;
  const afterDiscount = subtotal - discount;

  const taxRate = Number(settings.tax_rate) || 0;
  const included = settings.prices_include_tax === '1';
  const tax = included ? afterDiscount - afterDiscount / (1 + taxRate / 100) : (afterDiscount * taxRate) / 100;
  const total = included ? afterDiscount : afterDiscount + tax;

  return {
    category: { id: category.id, code: category.code, name: category.name },
    days,
    per_day: round2(perDay),
    base: round2(base),
    season_extra: round2(seasonExtra),
    extras: extrasLines,
    extras_total: round2(extrasTotal),
    one_way_fee: round2(oneWay),
    subtotal: round2(subtotal),
    discount_pct: discountPct,
    discount: round2(discount),
    tax_rate: taxRate,
    tax_included: included,
    tax: round2(tax),
    total: round2(total),
    deposit: round2(category.deposit),
    km_included: category.km_per_day > 0 ? category.km_per_day * days : null,
    currency: settings.currency,
  };
}

/**
 * Cargos al devolver el vehículo: km excedentes, combustible faltante, días de demora y daños.
 */
function computeReturnCharges(db, reservation, contract, input) {
  const settings = getSettings(db);
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(reservation.category_id);
  const lines = [];

  const kmDriven = Math.max(0, Number(input.in_km) - Number(contract.out_km));
  if (category.km_per_day > 0) {
    const allowed = category.km_per_day * reservation.days;
    const excess = kmDriven - allowed;
    if (excess > 0 && category.extra_km_rate > 0) {
      lines.push({ concept: `Km excedentes (${excess} km)`, amount: round2(excess * category.extra_km_rate) });
    }
  }

  const missingEighths = Math.max(0, Number(contract.out_fuel) - Number(input.in_fuel));
  const perEighth = Number(settings.fuel_charge_per_eighth) || 0;
  if (missingEighths > 0 && perEighth > 0) {
    lines.push({ concept: `Combustible faltante (${missingEighths}/8)`, amount: round2(missingEighths * perEighth) });
  }

  // Demora: horas pasadas de la devolución pactada, con la misma tolerancia que el cálculo de días.
  const lateHours = (parseLocal(input.in_at) - parseLocal(reservation.return_at)) / 3600000;
  const grace = Number(settings.grace_hours) || 0;
  const lateDays = lateHours > grace ? Math.ceil((lateHours - grace) / 24) : 0;
  if (lateDays > 0) {
    const perDay = reservation.days > 0 ? reservation.total / reservation.days : category.daily_rate;
    lines.push({ concept: `Días adicionales por demora (${lateDays})`, amount: round2(lateDays * perDay) });
  }

  const damage = Number(input.damage_charge) || 0;
  if (damage > 0) lines.push({ concept: 'Daños', amount: round2(damage) });

  for (const c of input.other_charges || []) {
    if (Number(c.amount)) lines.push({ concept: String(c.concept || 'Otro cargo'), amount: round2(c.amount) });
  }

  return { km_driven: kmDriven, lines, total: round2(lines.reduce((a, l) => a + l.amount, 0)) };
}

module.exports = { rentalDays, computeQuote, computeReturnCharges };
