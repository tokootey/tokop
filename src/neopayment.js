'use strict';

const { getSettings } = require('./db');
const { fail } = require('./util');
const R = require('./reservations');

/**
 * Pasarela NeoPayment (la usan Metrobank y otros bancos): el banco arma el link de pago de cada reserva
 * y avisa cuando el cliente pagó. La tarjeta se carga en la página del banco: por acá no pasa ningún dato suyo.
 * Sin estos tres datos, el link de pago es el fijo de siempre (payment_link_url).
 */
const configured = (s) => Boolean(s.neo_host && s.neo_client_id && s.neo_client_secret);

const tokens = new Map(); // host|client_id → { token, until }: el banco los da por una hora
const cents = (n) => Math.round(Number(n) * 100);
const SLUG = /^[A-Za-z0-9]{6,40}$/;

async function call(s, method, path, body, auth = true) {
  let res;
  try {
    res = await fetch(String(s.neo_host).replace(/\/+$/, '') + path, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Floty/1.0', ...(auth ? { Authorization: `Bearer ${await token(s)}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(4500), // el aviso del banco espera 10 segundos: token + consulta tienen que entrar
    });
  } catch (e) {
    if (e.status) throw e;
    fail(502, 'No se pudo conectar con el banco. Probá de nuevo en un rato.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 404) fail(404, 'Pago inexistente');
  if (!res.ok) fail(502, `El banco rechazó el pedido: ${String(data.message || res.status).slice(0, 200)}`);
  return data;
}

async function token(s) {
  const key = `${s.neo_host}|${s.neo_client_id}`;
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const d = await call(s, 'POST', '/oauth/token', { grant_type: 'client_credentials', client_id: s.neo_client_id, client_secret: s.neo_client_secret }, false);
  if (!d.access_token) fail(502, 'El banco no aceptó las credenciales');
  tokens.set(key, { token: d.access_token, until: Date.now() + (Number(d.expires_in) || 3600) * 1000 - 60000 });
  return d.access_token;
}

/**
 * Le pregunta al banco por un link de pago y anota los cobros aprobados que falten.
 * El aviso del banco no viene firmado: lo único que se le cree es el código del link; el estado y el importe se le preguntan al banco.
 */
async function settle(db, slug) {
  const s = getSettings(db);
  // Sólo links que armó esta agencia: con un código cualquiera no se molesta al banco.
  const own = configured(s) && SLUG.test(String(slug || '')) && db.prepare('SELECT id, code FROM reservations WHERE pay_slug = ?').get(String(slug));
  if (!own) fail(404, 'Pago inexistente');
  const checkout = (await call(s, 'GET', `/api/v2/checkout/${slug}`)).data || {};
  if (String((checkout.metadatas || {}).payment_reference || '') !== own.code) fail(404, 'Pago inexistente');
  const r = R.getReservation(db, own.id);
  for (const tx of checkout.transactions || []) {
    // "orphan" (el banco no supo si se cobró) y el resto no se anotan: los revisa la agencia con el banco.
    if (tx.status !== 'authorized' || tx.type !== 'sale' || tx.reversal_tx) continue;
    const reference = `neopayment ${tx.id}`;
    if (db.prepare('SELECT 1 FROM payments WHERE reservation_id = ? AND reference = ?').get(r.id, reference)) continue;
    R.addPayment(db, r.id, { amount: Number(tx.amount) / 100, kind: 'pago', method: 'link de pago', reference, notes: 'Entró solo: lo avisó el banco' }, null);
  }
  return { checkout, reservation: R.getReservation(db, r.id) };
}

/**
 * Link de pago del banco por lo que falta pagar de la reserva.
 * Si el anterior sigue abierto y es por el mismo importe, es el mismo link; si cambió el importe, el viejo se anula.
 */
async function link(db, id, req, query = '') {
  const s = getSettings(db);
  if (!configured(s)) fail(400, 'El banco no está conectado');
  let r = R.getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  if (r.pay_slug) {
    // Primero se mira el link anterior: si ya lo pagó y el aviso no llegó, el cobro entra ahora.
    const old = await settle(db, r.pay_slug).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
    if (old) {
      r = old.reservation;
      const open = ['created', 'pending'].includes(old.checkout.status);
      if (open && old.checkout.amount === cents(r.balance.pending) && old.checkout.payment_link) return { url: old.checkout.payment_link, pending: r.balance.pending };
      // Si no se deja anular es que lo están pagando: no se arma otro, para no cobrar dos veces.
      if (open) await call(s, 'GET', `/api/v2/checkout/${r.pay_slug}/cancel`).catch(() => fail(409, 'El cliente está pagando el link anterior. Probá de nuevo en un minuto.'));
    }
  }
  if (!(r.balance.pending > 0.005)) return { paid: true, pending: 0, status: r.status };
  if (!['pendiente', 'confirmada'].includes(r.status)) fail(409, 'Esta reserva ya no se puede cobrar con link de pago');
  const base = `${req.protocol}://${req.get('host')}`;
  // Al terminar, el banco devuelve al cliente a la página de la agencia, que le dice cómo salió (public/app.js, bookingPage).
  const back = (how) => `${base}/reservar${query}${query ? '&' : '?'}pago=${how}`;
  const d = (
    await call(s, 'POST', '/api/v2/checkout', {
      amount: cents(r.balance.pending),
      currency_code: s.currency,
      return_url: back('no'),
      url_ok: back('ok'),
      url_ko: back('no'),
      webhook: `${base}/api/public/pagos/neopayment${query}`,
      source: base,
      metadatas: {
        payment_reference: r.code,
        customer_name: r.customer_name || undefined,
        customer_email: r.customer_email || undefined,
      },
    })
  ).data;
  if (!d || !SLUG.test(String(d.slug || '')) || !d.payment_link) fail(502, 'El banco no devolvió el link de pago');
  db.prepare('UPDATE reservations SET pay_slug = ? WHERE id = ?').run(d.slug, r.id);
  R.log(db, r.id, req.user && req.user.id, 'link_de_pago', `${s.currency} ${r.balance.pending}`);
  return { url: d.payment_link, pending: r.balance.pending };
}

module.exports = { configured, settle, link };
