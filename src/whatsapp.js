'use strict';

const { getSettings } = require('./db');
const { fail } = require('./util');

/** ¿La agencia conectó su WhatsApp (Cloud API de Meta)? Sin esto, los mensajes salen con el link wa.me de siempre. */
const configured = (s) => Boolean(s.wa_phone_id && s.wa_token && s.wa_template);

/**
 * Manda un mensaje con la plantilla aprobada de la agencia, que tiene una sola variable ({{1}}) con el texto.
 * Meta no deja mandar texto libre a quien no escribió en las últimas 24 h: por eso va siempre por plantilla.
 */
async function send(db, phone, text) {
  const s = getSettings(db);
  if (!configured(s)) fail(400, 'WhatsApp no está conectado');
  const to = String(phone || '').replace(/\D/g, '');
  if (to.length < 8) fail(400, 'El cliente no tiene un WhatsApp válido');
  // Meta rechaza variables con saltos de línea o tabulaciones.
  const body = String(text || '').replace(/\s*\n\s*/g, ' · ').replace(/\s+/g, ' ').trim().slice(0, 900);
  if (!body) fail(400, 'Falta el mensaje');
  let res;
  try {
    res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(s.wa_phone_id)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.wa_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: { name: s.wa_template, language: { code: s.wa_template_lang || 'es' }, components: [{ type: 'body', parameters: [{ type: 'text', text: body }] }] },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    fail(502, 'No se pudo conectar con WhatsApp. Probá de nuevo o mandalo con el botón de siempre.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(502, `WhatsApp no lo mandó: ${(data.error && (data.error.error_data?.details || data.error.message)) || res.status}`);
  return { id: data.messages && data.messages[0] && data.messages[0].id };
}

module.exports = { configured, send };
