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
function rentalDays(pickupAt, returnAt, graceHours = 2, hourlyHours = 0) {
  const ms = parseLocal(returnAt) - parseLocal(pickupAt);
  if (!(ms > 0)) fail(400, 'La fecha de devolución debe ser posterior a la de retiro');
  const hours = ms / 3600000;
  const full = Math.floor(hours / 24);
  const rest = hours - full * 24;
  // Con precio por hora, las horas de más se cobran aparte hasta el tope; recién con más es otro día.
  return Math.max(1, full + (rest > graceHours + (full >= 1 ? hourlyHours : 0) ? 1 : 0));
}

/** Horas de más con precio por hora: hasta cuántas se cobran así (0 = no hay precio por hora). */
const hourlyMax = (settings) => (Number(settings.late_hour_fee) > 0 ? Number(settings.late_hour_max) || 4 : 0);
/** El límite de km de la categoría rige en alquileres de hasta km_limit_max_days días (0 = siempre). */
const kmLimited = (settings, days) => !(Number(settings.km_limit_max_days) > 0) || days <= Number(settings.km_limit_max_days);
/** "25/12/2026, 1/1/2027" → fechas AAAA-MM-DD. */
function holidaySet(text) {
  const out = new Set();
  for (const h of String(text || '').split(',')) {
    const m = h.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) out.add(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
  }
  return out;
}

function seasonMultiplier(seasons, dateStr) {
  let mult = 1;
  for (const s of seasons) {
    if (dateStr >= s.start_date && dateStr <= s.end_date) mult = Math.max(mult, s.multiplier);
  }
  return mult;
}

/** Recargo por conductor menor: lo paga quien el día del retiro no llegó a la edad que cargó la agencia. Sin fecha de nacimiento no se cobra. */
function youngDriverFee(db, settings, input) {
  const fee = Number(settings.young_driver_fee) || 0;
  if (!(fee > 0) || !input.pickup_at) return 0;
  const birth = String(input.birth_date || (input.customer_id && (db.prepare('SELECT birth_date FROM customers WHERE id = ?').get(input.customer_id) || {}).birth_date) || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) return 0;
  const day = String(input.pickup_at).slice(0, 10);
  const age = Number(day.slice(0, 4)) - Number(birth.slice(0, 4)) - (day.slice(5) < birth.slice(5) ? 1 : 0);
  return age < (Number(settings.young_driver_age) || 21) ? fee : 0;
}

/** Fuera de hora: si el retiro o la devolución cae entre after_hours_from y after_hours_to (por ejemplo de 20:00 a 23:00) se paga un recargo fijo, una sola vez. */
function afterHoursFee(settings, input) {
  const fee = Number(settings.after_hours_fee) || 0;
  const late = (at) => {
    const time = String(at || '').slice(11, 16);
    return Boolean(time) && time >= (settings.after_hours_from || '20:00') && time <= (settings.after_hours_to || '23:00');
  };
  return fee > 0 && (late(input.pickup_at) || late(input.return_at)) ? fee : 0;
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
  const choferes = isChoferes(settings);
  const hourly = choferes ? 0 : hourlyMax(settings);
  const days = rentalDays(input.pickup_at, input.return_at, graceHours, hourly);
  // Horas pasadas del último día completo y de la tolerancia: se cobran por hora si la agencia les puso precio.
  const totalHours = (parseLocal(input.return_at) - parseLocal(input.pickup_at)) / 3600000;
  const overHours = Math.ceil(totalHours - Math.floor(totalHours / 24) * 24 - graceHours - 1e-9);
  const extraHours = hourly && totalHours >= 24 && overHours > 0 && overHours <= hourly ? overHours : 0;

  // Tarifa diaria: si es 7 días o más y la categoría tiene tarifa semanal, se prorratea.
  let perDay = days >= 7 && category.weekly_rate > 0 ? category.weekly_rate / 7 : category.daily_rate;
  if (!choferes) {
    // Tramos de días: desde 10 y desde 6 días la categoría puede tener su tarifa, sin importar qué día se retira.
    if (days >= 10 && category.rate_10 > 0) perDay = category.rate_10;
    else if (days >= 6 && category.rate_6 > 0) perDay = category.rate_6;
    // Fin de semana (lo prende la agencia): retirando viernes, sábado o domingo por hasta 5 días, todos los días van con esa tarifa.
    else if (settings.weekend_rates_on === '1' && category.weekend_rate > 0 && days <= 5 && [5, 6, 0].includes(parseLocal(input.pickup_at).getDay())) perDay = category.weekend_rate;
  }
  // Feriados (lo prende la agencia): sólo esos días van con la tarifa de feriado.
  const holidays = !choferes && settings.holiday_rates_on === '1' && category.holiday_rate > 0 ? holidaySet(settings.holidays) : new Set();

  const seasons = db.prepare('SELECT * FROM seasons').all();
  let base = 0;
  let seasonExtra = 0;
  const start = parseLocal(input.pickup_at);
  // Choferes: se cobra por período entero (día, semana o mes), sin temporadas.
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
  const promos = choferes ? [] : db.prepare('SELECT * FROM promotions WHERE active = 1 AND category_id = ? ORDER BY promo_rate').all(category.id);
  let promo = null;
  let promoDays = 0;
  let promoBase = 0;
  let promoDiscount = 0;
  for (let i = 0; i < (choferes ? 0 : days); i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const day = fmtLocal(d).slice(0, 10);
    const dayRate = holidays.has(day) ? category.holiday_rate : perDay;
    base += dayRate;
    // El precio de promo es final: esos días no suman temporada ni demanda. Si la tarifa semanal ya es más barata, queda esa.
    const p = promos.find((x) => day >= x.start_date && day <= x.end_date && x.promo_rate < dayRate);
    if (p) {
      promo ??= p;
      promoDays++;
      promoBase += dayRate;
      promoDiscount += dayRate - p.promo_rate;
    } else {
      seasonExtra += dayRate * (seasonMultiplier(seasons, day) - 1);
    }
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
  const demandExtra = ((base - promoBase + seasonExtra) * demandPct) / 100;

  const young = youngDriverFee(db, settings, input);
  const afterHours = choferes ? 0 : afterHoursFee(settings, input);
  // Recargo por entregar o devolver en una sucursal (por ejemplo el aeropuerto): una vez por lugar; gratis desde los días que cargó la agencia.
  const branchFees = choferes
    ? []
    : [...new Set([input.pickup_branch_id, input.return_branch_id].filter(Boolean).map(Number))]
        .map((id) => db.prepare('SELECT name, fee, fee_free_days FROM branches WHERE id = ?').get(id))
        .filter((b) => b && b.fee > 0 && !(b.fee_free_days > 0 && days >= b.fee_free_days))
        .map((b) => ({ name: b.name, amount: round2(b.fee) }));
  const branchFee = branchFees.reduce((a, b) => a + b.amount, 0);
  const extraHoursFee = extraHours * (Number(settings.late_hour_fee) || 0);
  const subtotal = base + seasonExtra + demandExtra - promoDiscount + extrasTotal + oneWay + young + afterHours + branchFee + extraHoursFee;
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
    promo_discount: round2(promoDiscount),
    promo: promo ? { name: promo.name, days: promoDays, before_total: round2(total + promoDiscount * (included ? 1 : 1 + taxRate / 100)) } : null,
    extras: extrasLines,
    extras_total: round2(extrasTotal),
    one_way_fee: round2(oneWay),
    young_driver_fee: round2(young),
    after_hours_fee: round2(afterHours),
    branch_fees: branchFees,
    branch_fee: round2(branchFee),
    extra_hours: extraHours,
    extra_hours_fee: round2(extraHoursFee),
    young_driver_age: young ? Number(settings.young_driver_age) || 21 : undefined,
    subtotal: round2(subtotal),
    discount_pct: discountPct,
    discount_amount: round2(discountAmount),
    discount: round2(discount),
    tax_rate: taxRate,
    tax_included: included,
    tax: round2(tax),
    total: round2(total),
    deposit: round2(category.deposit),
    km_included: choferes ? (category.km_per_period > 0 ? category.km_per_period * periods : null) : category.km_per_day > 0 && kmLimited(settings, days) ? category.km_per_day * days : null,
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
  // Km de más y combustible faltante: se avisan siempre, tengan o no un cargo configurado.
  const kmAllowed = category.km_per_day > 0 && !byPeriods && kmLimited(settings, reservation.days) ? category.km_per_day * reservation.days : null;
  const kmExcess = kmAllowed === null ? 0 : Math.max(0, kmDriven - kmAllowed);
  // Por períodos (choferes) los km y la demora ya se cobraron con la renovación y la lectura de km.
  if (kmExcess > 0 && category.extra_km_rate > 0) lines.push({ concept: `Km excedentes (${kmExcess} km)`, amount: round2(kmExcess * category.extra_km_rate) });

  const missingEighths = Math.max(0, Number(contract.out_fuel) - Number(input.in_fuel));
  const perEighth = Number(settings.fuel_charge_per_eighth) || 0;
  if (missingEighths > 0 && perEighth > 0) {
    lines.push({ concept: `Combustible faltante (${missingEighths}/8)`, amount: round2(missingEighths * perEighth) });
  }

  // Demora: horas pasadas de la devolución pactada, con la misma tolerancia que el cálculo de días.
  const lateHours = (parseLocal(input.in_at) - parseLocal(reservation.return_at)) / 3600000;
  const grace = Number(settings.grace_hours) || 0;
  let lateDays = lateHours > grace ? Math.ceil((lateHours - grace) / 24) : 0;
  // Con precio por hora: las horas de más del último día se cobran por hora hasta el tope; con más, es un día entero.
  const hourly = byPeriods ? 0 : hourlyMax(settings);
  let lateExtraHours = 0;
  if (hourly && lateHours > grace) {
    const fullDays = Math.floor((lateHours - grace) / 24);
    const h = Math.ceil(lateHours - grace - fullDays * 24 - 1e-9);
    if (h <= hourly) {
      lateDays = fullDays;
      lateExtraHours = h;
    }
  }
  if (lateExtraHours > 0) lines.push({ concept: `Horas adicionales (${lateExtraHours})`, amount: round2(lateExtraHours * Number(settings.late_hour_fee)) });
  if (lateDays > 0 && !byPeriods) {
    const perDay = reservation.days > 0 ? reservation.total / reservation.days : category.daily_rate;
    lines.push({ concept: `Días adicionales por demora (${lateDays})`, amount: round2(lateDays * perDay) });
  }

  const damage = Number(input.damage_charge) || 0;
  if (damage > 0) lines.push({ concept: 'Daños', amount: round2(damage) });

  for (const c of input.other_charges || []) {
    if (Number(c.amount)) lines.push({ concept: String(c.concept || 'Otro cargo'), amount: round2(c.amount) });
  }

  return { km_driven: kmDriven, km_allowed: kmAllowed, km_excess: kmExcess, late_days: byPeriods ? 0 : lateDays, late_hours: lateExtraHours, fuel_missing: missingEighths, lines, total: round2(lines.reduce((a, l) => a + l.amount, 0)) };
}

module.exports = { youngDriverFee, rentalDays, computeQuote, computeReturnCharges, parseDynamicRules };
