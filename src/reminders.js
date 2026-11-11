'use strict';

const { getSettings } = require('./db');
const { fail, fmtLocal, nowLocal, parseLocal } = require('./util');
const whatsapp = require('./whatsapp');

/**
 * Recordatorio al cliente 12 horas antes de retirar el auto.
 * Con el WhatsApp de la agencia conectado y la opción activada, sale solo (lo corre el servidor cada 10 minutos).
 * Si no, la pantalla Hoy lista los que hay que mandar, con el mensaje ya escrito.
 */
const HOURS = 12;
const FAILED = 'error'; // lo intentó el servidor y falló: queda en Hoy para mandarlo a mano, y no se reintenta solo

const log = (db, id, userId, action, detail) =>
  db.prepare('INSERT INTO reservation_log (reservation_id, user_id, action, detail) VALUES (?, ?, ?, ?)').run(id, userId || null, action, detail || null);

/** El texto que recibe el cliente. shortcut: solo en español; sumar el inglés cuando la reserva guarde el idioma del cliente. */
function textOf(r, settings, now = nowLocal()) {
  const day = r.pickup_at.slice(0, 10) === now.slice(0, 10) ? 'hoy' : `el ${r.pickup_at.slice(8, 10)}/${r.pickup_at.slice(5, 7)}`;
  const car = r.vehicle_plate ? `${[r.vehicle_brand, r.vehicle_model].filter(Boolean).join(' ')} (${r.vehicle_plate})`.trim() : 'auto';
  return [
    `Hola ${String(r.customer_name || '').split(' ')[0]}! Te recordamos que ${day} a las ${r.pickup_at.slice(11, 16)} retirás tu ${car}${r.pickup_branch_name ? ` en ${r.pickup_branch_name}` : ''}.`,
    'Traé tu licencia de conducir y tu documento.',
    `Reserva ${r.code}. ${settings.company_name || ''}`.trim(),
  ].join('\n');
}

/** Reservas confirmadas que salen en las próximas 12 horas y todavía no tienen el recordatorio mandado. */
function pending(db, now = nowLocal(), { retryFailed = true } = {}) {
  const until = fmtLocal(new Date(parseLocal(now).getTime() + HOURS * 3600000));
  const settings = getSettings(db);
  return db
    .prepare(
      `SELECT r.id, r.code, r.pickup_at, r.reminder_at, c.full_name AS customer_name, c.phone AS customer_phone,
              v.plate AS vehicle_plate, v.brand AS vehicle_brand, v.model AS vehicle_model, b.name AS pickup_branch_name
       FROM reservations r JOIN customers c ON c.id = r.customer_id
       LEFT JOIN vehicles v ON v.id = r.vehicle_id LEFT JOIN branches b ON b.id = r.pickup_branch_id
       WHERE r.status = 'confirmada' AND r.pickup_at > ? AND r.pickup_at <= ? AND c.phone IS NOT NULL AND c.phone <> ''
         AND (r.reminder_at IS NULL${retryFailed ? ` OR r.reminder_at = '${FAILED}'` : ''})
       ORDER BY r.pickup_at`,
    )
    .all(now, until)
    .map((r) => ({ ...r, text: textOf(r, settings, now) }));
}

const mark = (db, id, value) => db.prepare('UPDATE reservations SET reminder_at = ? WHERE id = ?').run(value, id);

/** Lo corre el servidor: manda los que tocan, una sola vez cada uno. Devuelve cuántos salieron. */
async function sendDue(db, now = nowLocal()) {
  const s = getSettings(db);
  if (s.reminder_auto !== '1' || !whatsapp.configured(s)) return 0;
  let sent = 0;
  for (const r of pending(db, now, { retryFailed: false })) {
    try {
      await whatsapp.send(db, r.customer_phone, r.text);
      mark(db, r.id, now);
      log(db, r.id, null, 'recordatorio_enviado', 'Automático, por WhatsApp');
      sent += 1;
    } catch (e) {
      mark(db, r.id, FAILED);
      log(db, r.id, null, 'recordatorio_fallido', e.message);
    }
  }
  return sent;
}

/** Desde la pantalla Hoy: con WhatsApp conectado lo manda el sistema; si no, queda anotado que la agencia lo mandó con su WhatsApp. */
async function sendOne(db, id, userId, now = nowLocal()) {
  const r = pending(db, now).find((x) => x.id === Number(id));
  if (!r) fail(409, 'Esta reserva ya no tiene un recordatorio para mandar');
  const api = whatsapp.configured(getSettings(db));
  if (api) await whatsapp.send(db, r.customer_phone, r.text);
  mark(db, r.id, now);
  log(db, r.id, userId, 'recordatorio_enviado', api ? 'Por WhatsApp' : 'Con el WhatsApp de la agencia');
  return { ok: true, api };
}

module.exports = { HOURS, textOf, pending, sendDue, sendOne };
