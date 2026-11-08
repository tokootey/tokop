'use strict';

const { getSettings } = require('./db');
const { parseLocal, fmtLocal, round2, fail } = require('./util');
const { isChoferes, carPeriod, periodsBetween, periodRate, carRate, addPeriod } = require('./choferes');
const { categoryAvailability } = require('./availability');

/** "70:10, 90:20" → desde 70 % de ocupación sube 10 %, desde 90 % sube 20 %. Devuelve null si está mal escrito. */
function parseDynamicRules(text) {
  const parts = String(text || '').split(',').map((p) => p.trim()).filter(Boolean);
  const rules = parts.map((p) => p.match(/^(\d{1,3}(?:\.\d+)?)\s*:\s*(\d{1,3}(?:\.\d+)?)$/));
  if (rules.some((m) => !m || Number(m[1]) > 100)) return null;
  return rules.map((m) => ({ from: Number(m[1]), pct: Number(m[2]) })).sort((a, b) => a.from - b.from);
}

/** Recargo según qué tan ocupada está la categoría en esas fechas (la propia reserva no cuenta). */
function dynamicPct(db, settings, input) {
  if (settings.pro_features !== '1' || isChoferes(settings)) return 0;
  const rules = parseDynamicRules(settings.dynamic_pricing_rules);
  if (!rules || !rules.length) return 0;
  const c = categoryAvailability(db, input).find((x) => x.id === Number(input.category_id));
  if (!c || !(c.fleet > 0)) return 0;
  const occupancy = (c.booked / c.fleet) * 100;
  return rules.filter((r) => occupancy >= r.from).reduce((_, r) => r.pct, 0);
}

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
  let perDay = days >= 7 && category.weekly_rate > 0 ? category.weekly_rate / 7 : category.daily_rate;

  const seasons = db.prepare('SELECT * FROM seasons').all();
  let base = 0;
  let seasonExtra = 0;
  const start = parseLocal(input.pickup_at);
  // Choferes: se cobra por período entero (día, semana o mes), sin temporadas.
  const choferes = isChoferes(settings);
  const period = choferes ? carPeriod(db, input.vehicle_id, settings) : null;
  const periods = choferes ? periodsBetween(input.pickup_at, input.return_at, period) : null;
  if (choferes) {
    perDay = periodRate(category, period);
    base = perDay * periods;
    // Si el auto ya está asignado y tiene precio propio, la cotización sale con ese precio.
    const car = carRate(db, input.vehicle_id, period, settings.holidays);
    if (car) {
      base = 0;
      for (let i = 0, start = input.pickup_at; i < periods; i++, start = addPeriod(start, period)) base += car(start);
      perDay = base / periods;
    }
  }
  for (let i = 0; i < (choferes ? 0 : days); i++) {
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
    extrasLines.push({ extra_id: extra.id, name: extra.name, quantity: qty, amount: round2(amount), kind: extra.kind || 'adicional', deductible: extra.deductible || 0 });
  }
  if (extrasLines.filter((l) => l.kind === 'seguro').length > 1) fail(400, 'Elegí un solo seguro para la reserva');
  const extrasTotal = extrasLines.reduce((a, l) => a + l.amount, 0);

  const oneWay =
    input.pickup_branch_id && input.return_branch_id && Number(input.pickup_branch_id) !== Number(input.return_branch_id)
      ? Number(settings.one_way_fee) || 0
      : 0;

  // Una reserva ya hecha conserva su recargo mientras no cambie de fechas o categoría (dynamic_pct viene de updateReservation).
  const demandPct = input.dynamic_pct !== undefined ? Number(input.dynamic_pct) || 0 : dynamicPct(db, settings, input);
  const demandExtra = ((base + seasonExtra) * demandPct) / 100;

  const subtotal = base + seasonExtra + demandExtra + extrasTotal + oneWay;
  const discountPct = Math.min(100, Math.max(0, Number(input.discount_pct) || 0));
  // El porcentaje y el monto fijo (por ejemplo 10.000 para redondear) se suman; nunca más que el subtotal.
  const discountAmount = Math.max(0, Number(input.discount_amount) || 0);
  const discount = Math.min(subtotal, (subtotal * discountPct) / 100 + discountAmount);
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
    dynamic_pct: demandPct,
    dynamic_extra: round2(demandExtra),
    extras: extrasLines,
    extras_total: round2(extrasTotal),
    one_way_fee: round2(oneWay),
    subtotal: round2(subtotal),
    discount_pct: discountPct,
    discount_amount: round2(discountAmount),
    discount: round2(discount),
    tax_rate: taxRate,
    tax_included: included,
    tax: round2(tax),
    total: round2(total),
    deposit: round2(category.deposit),
    km_included: choferes ? (category.km_per_period > 0 ? category.km_per_period * periods : null) : category.km_per_day > 0 ? category.km_per_day * days : null,
    ...(choferes ? { period, periods } : {}),
    currency: settings.currency,
  };
}

/**
 * Cargos al devolver el vehículo: km excedentes, combustible faltante, días de demora y daños.
 */
function computeReturnCharges(db, reservation, contract, input, { byPeriods = false } = {}) {
  const settings = getSettings(db);
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(reservation.category_id);
  const lines = [];

  const kmDriven = Math.max(0, Number(input.in_km) - Number(contract.out_km));
  // Por períodos (choferes) los km y la demora ya se cobraron con la renovación y la lectura de km.
  if (category.km_per_day > 0 && !byPeriods) {
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
  if (lateDays > 0 && !byPeriods) {
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

module.exports = { rentalDays, computeQuote, computeReturnCharges, parseDynamicRules };
