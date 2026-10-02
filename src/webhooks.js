'use strict';

const crypto = require('node:crypto');
const { getSetting } = require('./db');

/**
 * Notifica eventos de reservas al cotizador (u otro sistema) vía webhook saliente.
 * El cuerpo se firma con HMAC-SHA256 en el header X-Signature usando webhook_secret.
 * Es "fire and forget": nunca bloquea ni hace fallar la operación que lo dispara.
 */
function emit(db, event, data) {
  const url = getSetting(db, 'webhook_url');
  if (!url) return Promise.resolve(null);
  const body = JSON.stringify({ event, sent_at: new Date().toISOString(), data });
  const signature = crypto.createHmac('sha256', getSetting(db, 'webhook_secret') || '').update(body).digest('hex');
  const log = db.prepare('INSERT INTO webhook_log (event, url, status, response) VALUES (?, ?, ?, ?)');

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Event': event, 'X-Signature': signature },
    body,
    signal: AbortSignal.timeout(8000),
  })
    .then(async (res) => {
      const text = (await res.text()).slice(0, 500);
      log.run(event, url, res.status, text);
      return res.status;
    })
    .catch((err) => {
      try {
        log.run(event, url, 0, String(err.message || err).slice(0, 500));
      } catch {
        /* la base pudo cerrarse (tests) */
      }
      return 0;
    });
}

module.exports = { emit };
