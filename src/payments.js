'use strict';

const { getSettings } = require('./db');
const { fail, round2 } = require('./util');
const R = require('./reservations');

/**
 * Cobro con tarjeta por Mercado Pago (Checkout Pro): el cliente paga en la página de Mercado Pago, así que
 * los datos de la tarjeta nunca pasan por Floty. Cada agencia cobra en su cuenta, con su Access Token.
 */
const MP = 'https://api.mercadopago.com';
const NO_DECIMALS = ['CLP', 'COP', 'PYG'];

const cardsOn = (s) => s.pro_features === '1' && Boolean(s.mp_access_token);
const auth = (s) => ({ Authorization: `Bearer ${s.mp_access_token}`, 'Content-Type': 'application/json' });
const baseOf = (req) => `${req.protocol}://${req.get('host')}`;

/** Crea el link de pago de una reserva. Sin importe, cobra el porcentaje configurado del saldo. */
async function createPayLink(db, id, { base, query = '', amount } = {}) {
  const s = getSettings(db);
  if (!cardsOn(s)) fail(403, 'Conectá Mercado Pago para cobrar con tarjeta');
  const r = R.getReservation(db, id);
  if (!r) fail(404, 'Reserva inexistente');
  if (['cancelada', 'no_show'].includes(r.status)) fail(409, 'La reserva está cancelada');
  const pending = r.balance.pending;
  if (!(pending > 0)) fail(409, 'La reserva no tiene saldo a cobrar');
  let charge = amount === undefined || amount === null ? (pending * (Number(s.card_pay_pct) || 100)) / 100 : Number(amount);
  if (!(charge > 0) || charge > pending) fail(400, 'El importe tiene que ser mayor que cero y no pasar del saldo');
  charge = NO_DECIMALS.includes(s.currency) ? Math.ceil(charge) : round2(charge);
  const back = `${base}/pago-listo${query}`;
  const secure = base.startsWith('https://'); // Mercado Pago sólo acepta avisos y regresos automáticos a direcciones https
  const res = await fetch(`${MP}/checkout/preferences`, {
    method: 'POST',
    headers: auth(s),
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      items: [{ id: r.code, title: `${s.company_name || 'Reserva'} · ${r.code}`, quantity: 1, unit_price: charge, currency_id: s.currency }],
      external_reference: r.code,
      ...(r.customer_email ? { payer: { email: r.customer_email } } : {}),
      back_urls: { success: back, pending: back, failure: back },
      ...(secure ? { auto_return: 'approved', notification_url: `${base}/api/public/mp/aviso${query}` } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.init_point) fail(502, 'Mercado Pago no pudo crear el link de pago. Revisá el Access Token.');
  R.log(db, r.id, null, 'link_de_pago', `${charge}`);
  return { url: data.init_point, amount: charge };
}

/** Para los pedidos que llegan del cotizador: si falla, el pedido entra igual y se cobra después. */
async function payUrlFor(db, code, req, query) {
  if (!code || !cardsOn(getSettings(db))) return null;
  try {
    return (await createPayLink(db, code, { base: baseOf(req), query })).url;
  } catch (err) {
    console.error('No se pudo crear el link de pago', err.message);
    return null;
  }
}

/**
 * Aviso de Mercado Pago. No se le cree al aviso: se consulta el pago con la clave de la agencia.
 * Un pago ya registrado no se vuelve a cargar; una reserva pendiente que se paga queda confirmada.
 * shortcut: una devolución hecha en Mercado Pago no se refleja sola; se carga a mano. Agregarlo cuando se cobre de verdad.
 */
async function handleNotice(db, id) {
  const s = getSettings(db);
  if (!cardsOn(s) || !/^\d+$/.test(String(id))) return { ignored: true };
  const res = await fetch(`${MP}/v1/payments/${id}`, { headers: auth(s), signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return { ignored: true };
  if (!res.ok) fail(502, 'No se pudo consultar el pago');
  const p = await res.json();
  if (p.status !== 'approved' || !(Number(p.transaction_amount) > 0)) return { ignored: true };
  const r = R.getReservation(db, String(p.external_reference || ''));
  if (!r) return { ignored: true };
  const reference = `MP ${p.id}`;
  if (db.prepare('SELECT 1 FROM payments WHERE reservation_id = ? AND reference = ?').get(r.id, reference)) return { duplicated: true };
  R.addPayment(db, r.id, { amount: p.transaction_amount, method: 'mercadopago', reference, notes: 'Pago con tarjeta por Mercado Pago' });
  if (r.status === 'pendiente') R.changeStatus(db, r.id, 'confirmada', null, 'Pagó con tarjeta');
  return { registered: true };
}

module.exports = { cardsOn, createPayLink, payUrlFor, handleNotice, baseOf };
