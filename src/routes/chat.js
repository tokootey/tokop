'use strict';

const express = require('express');
const { getSettings } = require('../db');
const { computeQuote, youngDriverFee, rentalDays } = require('../pricing');
const { categoryAvailability, OUT_OF_FLEET } = require('../availability');
const { ingestQuote } = require('../integration');
const { cardUrlFor, docsLink } = require('../delivery');
const { saveHotel, withHotelExtra, hotelExtra } = require('../hotel');
const R = require('../reservations');
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

// Ejemplo de WhatsApp en el formulario, según el país de la agencia.
const PHONE_HINT = { AR: '+54 9 2901 555123', PA: '+507 6123 4567', CL: '+56 9 1234 5678', UY: '+598 91 234 567', PE: '+51 912 345 678', CO: '+57 312 345 6789', MX: '+52 55 1234 5678', CR: '+506 8123 4567', ES: '+34 612 345 678' };

/** Categorías que en esas fechas sólo tienen libres autos "de consulta": en la web se ofrecen por WhatsApp, sin reserva. */
function inquiryOnly(db, pickup_at, return_at) {
  const marked = new Map(
    db.prepare(`SELECT category_id, COUNT(*) AS n FROM vehicles WHERE web_inquiry = 1 AND status NOT IN (${OUT_OF_FLEET.map(() => '?').join(',')}) GROUP BY category_id`).all(...OUT_OF_FLEET).map((r) => [r.category_id, r.n]),
  );
  if (!marked.size || !pickup_at || !return_at) return new Set();
  return new Set(categoryAvailability(db, { pickup_at, return_at }).filter((x) => x.available > 0 && x.available <= (marked.get(x.id) || 0)).map((x) => x.code));
}

// Hora de la agencia: el servidor corre en una sola zona y "después de las 20:00" tiene que ser la hora de ella.
// shortcut: sólo países de una zona horaria; el resto usa la hora del servidor hasta que la zona sea un ajuste de cada empresa.
const ZONES = { PA: 'America/Panama', UY: 'America/Montevideo', PY: 'America/Asuncion', BO: 'America/La_Paz', PE: 'America/Lima', CO: 'America/Bogota', CR: 'America/Costa_Rica', DO: 'America/Santo_Domingo', GT: 'America/Guatemala' };
const agencyNow = (country, date = new Date()) => (ZONES[country] ? date.toLocaleString('sv-SE', { timeZone: ZONES[country] }).slice(0, 16).replace(' ', 'T') : nowLocal());
/** Reserva express: se retira en menos de 24 hs en un lugar sin personal de la agencia (un hotel, o una sucursal marcada así). En la oficina nunca. */
const in24h = (now) => new Date(Date.parse(`${now}:00Z`) + 24 * 3600 * 1000).toISOString().slice(0, 16);
const isExpress = (now, pickup_at, offsite) => Boolean(offsite && pickup_at && pickup_at < in24h(now));
const hhmm = (v) => (/^[0-9]{2}:[0-9]{2}$/.test(v || '') ? v : '');

/**
 * Horario de retiro de la sucursal en el cotizador público. Devuelve el motivo si ese retiro no se acepta.
 * Una reserva hecha de noche (después de late_after, o de madrugada) no puede retirarse antes de late_pickup_from de la mañana siguiente.
 */
function pickupProblem(branch, pickup_at, now) {
  if (!branch || !pickup_at) return null;
  const from = hhmm(branch.pickup_from);
  if (from && pickup_at.slice(11, 16) < from) return `En ${branch.name} los autos se retiran a partir de las ${from}. Elegí otro horario.`;
  const after = hhmm(branch.late_after);
  const lateFrom = hhmm(branch.late_pickup_from);
  if (!after || !lateFrom) return null;
  const time = now.slice(11, 16);
  let day = now.slice(0, 10);
  if (time >= after) {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    day = d.toISOString().slice(0, 10);
  } else if (time >= lateFrom) return null;
  if (pickup_at < `${day}T${lateFrom}`) return `Las reservas hechas después de las ${after} en ${branch.name} se retiran a partir de las ${lateFrom} del día siguiente. Elegí otro horario.`;
  return null;
}

/** Con recargo fuera de hora cargado, after_hours_to es además la última hora en que la agencia entrega autos. */
function lastPickupProblem(settings, pickup_at) {
  const to = hhmm(settings.after_hours_to);
  return Number(settings.after_hours_fee) > 0 && to && pickup_at && pickup_at.slice(11, 16) > to ? `Entregamos autos hasta las ${to}. Elegí otro horario.` : null;
}
/** En el link de reservas no entra una licencia que ya venció o que vence antes de devolver el auto. */
function licenseProblem(expiry, return_at) {
  if (!expiry || !return_at || expiry >= return_at.slice(0, 10)) return null;
  return expiry < nowLocal().slice(0, 10) ? 'Tu licencia de conducir está vencida. Para reservar necesitás una licencia vigente.' : 'Tu licencia de conducir vence antes de la devolución. Para reservar tiene que estar vigente todo el alquiler.';
}

const str = (v, max = MAX_TEXT) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));

function chatRoutes(db, { publicQuery = '' } = {}) {
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

  // Sucursal de retiro: la que eligió el cliente, o la única que hay.
  const pickupBranch = (code) => {
    if (code) return db.prepare('SELECT * FROM branches WHERE code = ? AND active = 1').get(str(code, 20));
    const all = db.prepare('SELECT * FROM branches WHERE active = 1').all();
    return all.length === 1 ? all[0] : null;
  };
  // Con entrega en hotel el auto sale de la oficina: la primera sucursal con personal.
  const officeCode = () => (db.prepare('SELECT code FROM branches WHERE active = 1 ORDER BY express_24h, name').get() || {}).code;
  const checkPickup = (req, code, pickup_at) => {
    const problem = pickupProblem(pickupBranch(code), pickup_at, agencyNow(req.settings.country)) || lastPickupProblem(req.settings, pickup_at);
    if (problem) fail(400, problem);
  };

  router.get('/config', (req, res) => {
    const s = req.settings;
    res.json({
      company: s.company_name,
      welcome: s.chat_welcome || `¡Hola! Elegí las fechas y te mostramos los autos disponibles de ${s.company_name} con su precio.`,
      whatsapp: str(s.chat_whatsapp, 30).replace(/[^\d]/g, ''),
      currency: s.currency,
      locale: s.locale,
      young_driver: Number(s.young_driver_fee) > 0 ? { age: Number(s.young_driver_age) || 21, fee: Number(s.young_driver_fee) } : null,
      after_hours: Number(s.after_hours_fee) > 0 ? { fee: Number(s.after_hours_fee), from: hhmm(s.after_hours_from) || '20:00', to: hhmm(s.after_hours_to) || '23:00' } : null,
      payment_link: String(s.payment_link_url || '').trim(),
      hotel: s.chat_hotel === '1' ? { fee: (hotelExtra(db) || {}).price || 0 } : null,
      express_places: db.prepare('SELECT code FROM branches WHERE active = 1 AND express_24h = 1').all().map((x) => x.code),
      express_before: in24h(agencyNow(s.country)),
      amex_by_whatsapp: s.country === 'PA', // en Panamá, Amex se cobra aparte: el cliente lo pide por WhatsApp
      phone_hint: PHONE_HINT[s.country] || '+00 000 000 000',
      branches: db.prepare('SELECT code, name FROM branches WHERE active = 1 ORDER BY name').all(),
      extras: db.prepare("SELECT code, name, price, charge_type, kind, deductible FROM extras WHERE active = 1 AND price > 0 AND code <> 'HOTEL' AND kind <> 'recargo' ORDER BY kind DESC, name").all(),
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
    const hotel = req.settings.chat_hotel === '1' && Boolean(b.hotel);
    const pickupCode = hotel ? officeCode() : b.pickup_branch;
    checkPickup(req, pickupCode, pickup_at);
    const branch = pickupCode ? db.prepare('SELECT id FROM branches WHERE code = ? AND active = 1').get(str(pickupCode, 20)) : null;
    const returnBranch = b.return_branch ? db.prepare('SELECT id FROM branches WHERE code = ? AND active = 1').get(str(b.return_branch, 20)) : null;
    const pickedExtras = (Array.isArray(b.extras) ? b.extras : []).slice(0, 10).map((code) => db.prepare("SELECT id FROM extras WHERE code = ? AND active = 1 AND code <> 'HOTEL'").get(str(code, 20))).filter(Boolean);
    const range = {
      pickup_at,
      return_at,
      pickup_branch_id: branch ? branch.id : null,
      return_branch_id: returnBranch ? returnBranch.id : branch ? branch.id : null,
      extras: withHotelExtra(db, pickedExtras.map((e) => ({ extra_id: e.id, quantity: 1 })), hotel),
    };
    const inquiry = inquiryOnly(db, pickup_at, return_at);
    const options = categoryAvailability(db, range)
      .filter((c) => c.available > 0)
      .map((c) => {
        // Sin precio: la agencia lo conversa por WhatsApp.
        if (inquiry.has(c.code)) return { code: c.code, name: c.name, description: c.description || '', seats: c.seats, transmission: c.transmission, inquiry_only: true, total: Infinity };
        const q = computeQuote(db, { ...range, category_id: c.id });
        // Al público sólo se le muestra lo necesario: nunca cuántos autos quedan exactamente.
        return { code: c.code, name: c.name, description: c.description || '', seats: c.seats, transmission: c.transmission, days: q.days, total: q.total, deposit: q.deposit, few_left: c.available <= 1, high_demand: q.dynamic_pct > 0, promo: q.promo, one_way_fee: q.one_way_fee, after_hours_fee: q.after_hours_fee };
      })
      .sort((a, b2) => a.total - b2.total)
      .map((o) => (o.inquiry_only ? { ...o, total: null } : o));
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
    const hotel = req.settings.chat_hotel === '1' && b.hotel && typeof b.hotel === 'object' ? b.hotel : null;
    if (hotel && (!str(hotel.name, 120) || !str(hotel.address, 200))) fail(400, 'Poné el nombre y la dirección del hotel');
    const pickupCode = hotel ? officeCode() : str(b.pickup_branch, 20);
    checkPickup(req, pickupCode, normDateTime(str(b.pickup_at, 20)));
    if (inquiryOnly(db, normDateTime(str(b.pickup_at, 20)), normDateTime(str(b.return_at, 20))).has(str(b.category, 20))) fail(409, 'Ese auto se reserva hablando con la agencia por WhatsApp');
    // Conductor menor (con recargo cargado): alquila por 2 días como mínimo.
    const s = req.settings;
    const birth = str(b.birth_date, 10);
    if (birth && youngDriverFee(db, s, { birth_date: birth, pickup_at: normDateTime(str(b.pickup_at, 20)) }) && rentalDays(normDateTime(str(b.pickup_at, 20)), normDateTime(str(b.return_at, 20)), Number(s.grace_hours) || 0) < 2) {
      fail(400, `Los conductores menores de ${Number(s.young_driver_age) || 21} años alquilan por 2 días como mínimo`);
    }
    const expiry = str(b.license_expiry, 10);
    const expired = licenseProblem(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(expiry) ? expiry : '', normDateTime(str(b.return_at, 20)));
    if (expired) fail(400, expired);
    const payload = {
      nombre: name,
      email,
      telefono: phone,
      vehiculo: str(b.category, 20),
      fecha_retiro: str(b.pickup_at, 20),
      fecha_devolucion: str(b.return_at, 20),
      lugar_retiro: pickupCode,
      lugar_devolucion: str(b.return_branch || pickupCode, 20),
      adicionales: (Array.isArray(b.extras) ? b.extras : []).slice(0, 10).map((x) => str(x, 20)).join(','),
      vuelo: str(b.flight, 40),
      comentarios: ['Pedido desde el link de reservas', str(b.notes, 500)].filter(Boolean).join('. '),
    };
    let result;
    try {
      result = ingestQuote(db, payload, undefined, 'web');
    } catch {
      // Queda en la bandeja del cotizador para que la gestione una persona; al público no se le muestran detalles.
      return res.status(202).json({ ok: true, pending_review: true });
    }
    const rid = db.prepare('SELECT id FROM reservations WHERE code = ?').get(result.reservation.code).id;
    if (hotel) {
      try {
        const h = saveHotel(db, rid, { ...hotel, deliver: 1, return: hotel.return ? 1 : 0 }, null, R.log);
        R.updateReservation(db, rid, { extras: withHotelExtra(db, R.getReservation(db, rid).extras, h) }, null);
      } catch {
        // la reserva ya entró: los datos del hotel los completa la agencia
      }
    }
    const place = pickupBranch(pickupCode);
    const express = isExpress(agencyNow(s.country), normDateTime(str(b.pickup_at, 20)), Boolean(hotel) || Boolean(place && place.express_24h));
    if (express) {
      db.prepare('UPDATE reservations SET express = 1 WHERE id = ?').run(rid);
      R.log(db, rid, null, 'reserva_express', hotel ? 'Menos de 24 hs, entrega en hotel' : `Menos de 24 hs en ${place.name}`);
    }
    // Lo que el cliente completó al reservar va directo a su ficha, sin pisar lo que ya cargó la agencia.
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    const extra = {
      doc_number: str(b.doc_number, 40),
      address: str(b.address, 200),
      birth_date: isDate(str(b.birth_date, 10)) ? str(b.birth_date, 10) : '',
      license_number: str(b.license_number, 40),
      license_expiry: isDate(str(b.license_expiry, 10)) ? str(b.license_expiry, 10) : '',
    };
    for (const [f, v] of Object.entries(extra)) {
      if (v) db.prepare(`UPDATE customers SET ${f} = ? WHERE id = (SELECT customer_id FROM reservations WHERE code = ?) AND (${f} IS NULL OR ${f} = '')`).run(v, result.reservation.code);
    }
    // Con la fecha de nacimiento ya en la ficha, el precio se rearma por si corresponde el recargo por conductor menor.
    if (extra.birth_date && Number(req.settings.young_driver_fee) > 0) {
      try {
        R.updateReservation(db, db.prepare('SELECT id FROM reservations WHERE code = ?').get(result.reservation.code).id, {}, null);
      } catch {
        // la reserva ya entró: el recargo lo revisa la agencia
      }
    }
    const card_url = cardUrlFor(db, result.reservation.code, req, publicQuery);
    // Express: el cliente sigue ahí mismo con sus datos y las fotos de la licencia.
    const docs_url = express ? `${req.protocol}://${req.get('host')}/datos/${docsLink(db, rid).docs_token}${publicQuery}` : null;
    res.status(201).json({ ok: true, code: result.reservation.code, ...(card_url ? { card_url } : {}), ...(express ? { express: true, docs_url } : {}) });
  });

  return router;
}

module.exports = { isExpress, chatRoutes, parseFaq, FAQ_DEFAULT, pickupProblem, agencyNow, lastPickupProblem, licenseProblem };
