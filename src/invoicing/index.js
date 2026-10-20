'use strict';

/**
 * Factura electrónica desde una reserva. SOLO MODO DE PRUEBA: ninguna factura emitida acá tiene validez fiscal.
 *
 * Interfaz común: cada proveedor (un país) exporta
 *   validateSettings(settings)            → lista de problemas con los datos fiscales de la empresa
 *   emit(invoice, settings, { mode })     → { number, auth_code, auth_due, request, response }
 * y este módulo arma la factura a partir de la reserva, la numera, la guarda y la devuelve.
 *
 * Modos (Ajustes → Factura electrónica):
 *   - "simulado": arma el pedido real del organismo (XML) pero no lo envía: el código de autorización es inventado.
 *   - "homologacion": envía al servidor de prueba del organismo. Necesita el certificado de prueba de la
 *     empresa, que todavía no está cargado: por eso hoy responde con un error que explica qué falta.
 *   No hay modo "produccion": para facturar de verdad falta lo que dice "Qué falta para producción" en cada proveedor.
 */
const { getSettings } = require('../db');
const { fail } = require('../util');
const { getReservation } = require('../reservations');

const PROVIDERS = { arca: require('./arca'), sii: require('./sii') };
const MODES = ['simulado', 'homologacion'];

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** Datos de la factura a partir de la reserva (importe final con los cargos de la devolución, si los hay). */
function invoiceFromReservation(r, s) {
  const total = round2(r.balance ? r.balance.due : r.total);
  const rate = Number(s.tax_rate) || 0;
  // Los precios del sistema pueden venir con o sin impuesto: la factura siempre discrimina neto + impuesto.
  const included = s.prices_include_tax !== '0';
  const net = included ? round2(total / (1 + rate / 100)) : total;
  const tax = included ? round2(total - net) : round2((total * rate) / 100);
  return {
    reservation_id: r.id,
    reservation_code: r.code,
    concept: `Alquiler de vehículo ${r.category_code} · ${r.days} día(s) · reserva ${r.code}`,
    service_from: String(r.pickup_at).slice(0, 10),
    service_to: String(r.return_at).slice(0, 10),
    customer: { name: r.customer_name, doc_type: r.customer_doc_type || 'DNI', doc_number: r.customer_doc || '', address: r.customer_address || '' },
    currency: s.currency || 'ARS',
    tax_rate: rate,
    net,
    tax,
    total: round2(net + tax),
  };
}

/** Problemas que impiden facturar con la configuración actual (vacío = se puede). */
function settingsProblems(s) {
  const provider = PROVIDERS[s.invoice_provider];
  if (!provider) return ['Elegí el sistema de factura electrónica (ARCA para Argentina, SII para Chile) en Ajustes → Empresa y contrato'];
  if (!MODES.includes(s.invoice_mode)) return ['El modo de facturación tiene que ser "simulado" u "homologacion"'];
  return provider.validateSettings(s);
}

async function emitForReservation(db, reservationId, userId) {
  const s = getSettings(db);
  const problems = settingsProblems(s);
  if (problems.length) fail(400, problems.join('. '));
  const r = getReservation(db, reservationId);
  if (!r) fail(404, 'Reserva inexistente');
  if (['pendiente', 'cancelada', 'no_show'].includes(r.status)) fail(400, 'Sólo se factura una reserva confirmada, en curso o finalizada');
  if (db.prepare("SELECT 1 FROM invoices WHERE reservation_id = ? AND status = 'emitida'").get(r.id)) fail(409, 'Esta reserva ya tiene una factura emitida');

  const provider = PROVIDERS[s.invoice_provider];
  const inv = invoiceFromReservation(r, s);
  if (!(inv.total > 0)) fail(400, 'La reserva no tiene importe para facturar');
  const type = provider.invoiceType(inv, s);
  const pos = Number(s.invoice_point_of_sale) || 1;
  const last = db.prepare('SELECT MAX(number) AS n FROM invoices WHERE provider = ? AND type = ? AND point_of_sale = ? AND mode = ?').get(s.invoice_provider, type.code, pos, s.invoice_mode).n;
  const number = (last || 0) + 1;

  const result = await provider.emit({ ...inv, type, point_of_sale: pos, number, date: new Date().toISOString().slice(0, 10) }, s, { mode: s.invoice_mode });
  const row = db
    .prepare(
      `INSERT INTO invoices (reservation_id, provider, mode, type, type_name, point_of_sale, number, auth_code, auth_due, customer_name, customer_doc_type,
         customer_doc, currency, net, tax, total, status, request, response, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'emitida', ?, ?, ?)`,
    )
    .run(
      r.id,
      s.invoice_provider,
      s.invoice_mode,
      type.code,
      type.name,
      pos,
      result.number,
      result.auth_code,
      result.auth_due,
      inv.customer.name,
      inv.customer.doc_type,
      inv.customer.doc_number,
      inv.currency,
      inv.net,
      inv.tax,
      inv.total,
      result.request,
      result.response,
      userId || null,
    );
  db.prepare('INSERT INTO reservation_log (reservation_id, user_id, action, detail) VALUES (?, ?, ?, ?)').run(
    r.id,
    userId || null,
    'factura_emitida',
    JSON.stringify({ factura: `${type.name} ${String(pos).padStart(5, '0')}-${String(result.number).padStart(8, '0')}`, modo: s.invoice_mode }),
  );
  return getInvoice(db, Number(row.lastInsertRowid));
}

function getInvoice(db, id) {
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
}

function listInvoices(db, reservationId) {
  return db.prepare('SELECT id, reservation_id, provider, mode, type, type_name, point_of_sale, number, auth_code, auth_due, customer_name, customer_doc, currency, net, tax, total, status, created_at FROM invoices WHERE reservation_id = ? ORDER BY id').all(reservationId);
}

module.exports = { PROVIDERS, MODES, invoiceFromReservation, settingsProblems, emitForReservation, getInvoice, listInvoices };
