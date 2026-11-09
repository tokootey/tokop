'use strict';

const crypto = require('node:crypto');
const { proOn, getSettings } = require('./db');
const { fail } = require('./util');
const R = require('./reservations');

/**
 * Firma electrónica del contrato y links para la entrega express (contrato y fotos, cada uno por su lado).
 * Lo que el cliente firma es una copia fija del contrato (snapshot): si después cambia la reserva, la firma
 * queda marcada y hay que pedirla de nuevo. La llave de cada link es su código, como en el link del hotel.
 */
const OPEN = ['pendiente', 'confirmada', 'en_curso'];
const newToken = () => crypto.randomBytes(18).toString('base64url');
const rowOf = (db, id) => db.prepare('SELECT * FROM delivery_links WHERE reservation_id = ?').get(id);

function ensureRow(db, id) {
  const row = rowOf(db, id);
  if (row) return row;
  db.prepare('INSERT INTO delivery_links (reservation_id, token, photos_token, card_token) VALUES (?, ?, ?, ?)').run(id, newToken(), newToken(), newToken());
  return rowOf(db, id);
}

function reservationOf(db, id) {
  if (!proOn(db)) fail(403, 'Esta función no está activada para tu agencia');
  const r = R.getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  return r;
}

/** ¿Lo firmado ya no coincide con la reserva? Un auto asignado después de firmar no cuenta como cambio. */
const changed = (snap, r) =>
  Boolean((snap.plate && snap.plate !== r.vehicle_plate) || snap.pickup_at !== r.pickup_at || snap.return_at !== r.return_at || snap.total !== r.total || snap.category_name !== r.category_name);

/** Lo que ve la agencia en la reserva. */
function stateOf(db, r) {
  if (!proOn(db)) return null;
  const row = rowOf(db, r.id);
  if (!row) return null;
  return {
    token: row.token,
    photos_token: row.photos_token,
    card_token: row.card_token,
    card: row.card_last4 ? { holder: row.card_holder, brand: row.card_brand, last4: row.card_last4, exp: row.card_exp, at: row.card_at } : null,
    requested: Boolean(row.snapshot),
    signed_at: row.signed_at,
    name: row.signed_name,
    doc: row.signed_doc,
    ip: row.signed_ip,
    hash: row.signed_hash,
    image: row.signed_image,
    stale: Boolean(row.snapshot && changed(JSON.parse(row.snapshot), r)),
  };
}

/** Deja el contrato listo para firmar. Las condiciones llegan armadas desde el panel de la agencia, con sus datos ya completos. */
function requestSignature(db, id, terms, settings, userId) {
  const r = reservationOf(db, id);
  if (!OPEN.includes(r.status)) fail(409, 'Sólo se pide la firma de una reserva pendiente, confirmada o en curso');
  if (!Array.isArray(terms) || !terms.length || terms.length > 80) fail(400, 'Faltan las condiciones del contrato');
  const row = ensureRow(db, r.id);
  const snap = row.snapshot && JSON.parse(row.snapshot);
  if (row.signed_at && !changed(snap, r)) return stateOf(db, r); // ya firmó este mismo contrato
  const snapshot = {
    company: settings.company_name,
    currency: settings.currency,
    locale: settings.locale,
    code: r.code,
    contract_number: r.contract ? r.contract.number : null,
    customer_name: r.customer_name,
    customer_doc: r.customer_doc,
    category_name: r.category_name,
    plate: r.vehicle_plate,
    vehicle: r.vehicle_plate ? `${r.vehicle_brand || ''} ${r.vehicle_model || ''}`.trim() : null,
    pickup_at: r.pickup_at,
    return_at: r.return_at,
    pickup_place: r.pickup_branch_name,
    return_place: r.return_branch_name,
    days: r.days,
    total: r.total,
    deposit: r.deposit,
    terms: terms.map((t) => ({ title: String(t.title || '').slice(0, 300), body: String(t.body || '').slice(0, 6000) })),
  };
  db.prepare(
    `UPDATE delivery_links SET snapshot = ?, signed_at = NULL, signed_name = NULL, signed_doc = NULL, signed_ip = NULL, signed_ua = NULL,
     signed_image = NULL, signed_hash = NULL WHERE reservation_id = ?`,
  ).run(JSON.stringify(snapshot), r.id);
  R.log(db, r.id, userId, row.signed_at ? 'firma_anulada' : 'firma_pedida', row.signed_at ? 'La reserva cambió después de firmar' : null);
  return stateOf(db, r);
}

/** Link de las fotos de la entrega. */
function photosLink(db, id) {
  const r = reservationOf(db, id);
  return { photos_token: ensureRow(db, r.id).photos_token };
}

function publicContract(db, token) {
  const row = token && db.prepare('SELECT * FROM delivery_links WHERE token = ?').get(String(token));
  if (!row || !row.snapshot || !proOn(db)) fail(404, 'Este link ya no está disponible');
  const snap = JSON.parse(row.snapshot);
  const r = R.getReservation(db, row.reservation_id);
  const stale = changed(snap, r);
  return { row, r, snap, stale };
}

function viewContract(db, token) {
  const { row, r, snap, stale } = publicContract(db, token);
  return {
    ...snap,
    can_sign: !row.signed_at && !stale && OPEN.includes(r.status),
    stale,
    signed: row.signed_at ? { at: row.signed_at, name: row.signed_name, doc: row.signed_doc, hash: row.signed_hash, image: row.signed_image } : null,
  };
}

const PNG = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;
const validImage = (image) => {
  const m = typeof image === 'string' && image.length < 400000 && image.match(PNG);
  return Boolean(m) && Buffer.from(m[1], 'base64').subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n';
};

/** El cliente firma. Queda quién, cuándo, desde dónde y una huella de lo firmado. */
function sign(db, token, body, { ip, userAgent }) {
  const { row, r, stale } = publicContract(db, token);
  if (row.signed_at) fail(409, 'Este contrato ya está firmado');
  if (stale) fail(409, 'La reserva cambió: pedile a la agencia un link nuevo');
  if (!OPEN.includes(r.status)) fail(409, 'Esta reserva ya no se puede firmar');
  const name = String(body.name || '').trim().slice(0, 120);
  const doc = String(body.doc || '').trim().slice(0, 40);
  if (name.length < 3) fail(400, 'Escribí tu nombre y apellido');
  if (doc.length < 5) fail(400, 'Escribí tu número de documento');
  if (body.accepted !== true) fail(400, 'Tenés que aceptar el contrato para firmarlo');
  if (!validImage(body.image)) fail(400, 'Dibujá tu firma');
  const at = new Date().toISOString();
  const hash = crypto.createHash('sha256').update([row.snapshot, name, doc, at, body.image].join('|')).digest('hex');
  db.prepare('UPDATE delivery_links SET signed_at = ?, signed_name = ?, signed_doc = ?, signed_ip = ?, signed_ua = ?, signed_image = ?, signed_hash = ? WHERE reservation_id = ?').run(
    at,
    name,
    doc,
    String(ip || '').slice(0, 64),
    String(userAgent || '').slice(0, 300),
    body.image,
    hash,
    r.id,
  );
  R.log(db, r.id, null, 'firma_cliente', { nombre: name, documento: doc, huella: hash });
  return { ok: true, at, hash };
}

/** Fotos del auto al entregarlo, para el link del cliente. */
function deliveryPhotos(db, token) {
  const row = token && proOn(db) && db.prepare('SELECT reservation_id FROM delivery_links WHERE photos_token = ?').get(String(token));
  if (!row) fail(404, 'Este link ya no está disponible');
  const r = db.prepare('SELECT code FROM reservations WHERE id = ?').get(row.reservation_id);
  const files = db.prepare("SELECT id, name, mime, path FROM reservation_files WHERE reservation_id = ? AND stage = 'entrega' AND mime LIKE 'image/%' ORDER BY id").all(row.reservation_id);
  return { code: r.code, files };
}

/**
 * Tarjeta que deja el cliente: sirve para identificarla al retirar el auto, no para cobrarle.
 * El número completo y el código de seguridad nunca llegan al servidor (exigirían certificación PCI):
 * el navegador comprueba el número y manda sólo la marca y los últimos 4 dígitos.
 */
const CARD_BRANDS = ['Visa', 'Mastercard', 'American Express', 'Otra'];

function cardLink(db, id) {
  const r = reservationOf(db, id);
  return { card_token: ensureRow(db, r.id).card_token };
}

/** Link para que el cliente deje la tarjeta después de pedir una reserva por la web o la API. */
function cardUrlFor(db, code, req, query = '') {
  if (!code || !proOn(db)) return null;
  const r = db.prepare('SELECT id FROM reservations WHERE code = ?').get(String(code));
  return r ? `${req.protocol}://${req.get('host')}/tarjeta/${ensureRow(db, r.id).card_token}${query}` : null;
}

function cardOf(db, token) {
  const row = token && proOn(db) && db.prepare('SELECT * FROM delivery_links WHERE card_token = ?').get(String(token));
  if (!row) fail(404, 'Este link ya no está disponible');
  const r = R.getReservation(db, row.reservation_id);
  if (!OPEN.includes(r.status)) fail(404, 'Este link ya no está disponible');
  return { row, r };
}

function viewCard(db, token) {
  const { row, r } = cardOf(db, token);
  const s = getSettings(db);
  return {
    company: s.company_name || '',
    currency: s.currency,
    locale: s.locale,
    code: r.code,
    first_name: String(r.customer_name || '').split(' ')[0],
    deposit: r.deposit,
    card: row.card_last4 ? { holder: row.card_holder, brand: row.card_brand, last4: row.card_last4, exp: row.card_exp } : null,
  };
}

function saveCard(db, token, body, { ip }) {
  const { r } = cardOf(db, token);
  // Si algún dato trae un número de tarjeta, se rechaza sin guardar ni registrar nada.
  if (/\d[\d\s-]{7,}\d/.test(JSON.stringify(body))) fail(400, 'No mandes el número completo de la tarjeta');
  const holder = String(body.holder || '').trim().slice(0, 80);
  const brand = String(body.brand || '');
  const last4 = String(body.last4 || '');
  const exp = String(body.exp || '').trim();
  if (holder.length < 3) fail(400, 'Escribí el nombre del titular, como figura en la tarjeta');
  if (!CARD_BRANDS.includes(brand) || !/^\d{4}$/.test(last4)) fail(400, 'Revisá el número de la tarjeta');
  const m = exp.match(/^(0[1-9]|1[0-2])\/(\d{2})$/);
  if (!m) fail(400, 'Escribí el vencimiento como MM/AA');
  const now = new Date();
  if (2000 + Number(m[2]) < now.getFullYear() || (2000 + Number(m[2]) === now.getFullYear() && Number(m[1]) < now.getMonth() + 1)) fail(400, 'La tarjeta está vencida');
  if (body.accepted !== true) fail(400, 'Confirmá que vas a presentar esta tarjeta al retirar el auto');
  db.prepare('UPDATE delivery_links SET card_holder = ?, card_brand = ?, card_last4 = ?, card_exp = ?, card_at = ?, card_ip = ? WHERE reservation_id = ?').run(
    holder,
    brand,
    last4,
    exp,
    now.toISOString(),
    String(ip || '').slice(0, 64),
    r.id,
  );
  R.log(db, r.id, null, 'tarjeta_dejada', `${brand} terminada en ${last4}`);
  return { ok: true, card: { holder, brand, last4, exp } };
}

module.exports = { stateOf, requestSignature, photosLink, viewContract, sign, deliveryPhotos, cardLink, cardUrlFor, viewCard, saveCard };
