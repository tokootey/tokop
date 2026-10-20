'use strict';

/**
 * SII, Chile: Documento Tributario Electrónico (DTE). Boleta electrónica (tipo 39) para personas y
 * Factura electrónica (tipo 33) para empresas con RUT. SOLO PRUEBA. Ambiente de certificación: maullin.sii.cl
 *
 * Qué falta para producción (y también para usar certificación de verdad):
 *   1. El RUT de cada agencia, inscripta como emisor electrónico en el SII.
 *   2. Un certificado digital (.pfx) de una persona autorizada por la empresa, para firmar cada DTE (XMLDSig)
 *      y para pedir el token de la API del SII.
 *   3. Los folios autorizados (archivo CAF) de cada tipo de documento, que da el SII; el número de cada
 *      boleta sale de ahí y el timbre (TED) se firma con la clave del CAF.
 *   4. Enviar el DTE firmado (boletas: API REST de boleta electrónica; facturas: EnvioDTE) y guardar el Track ID.
 * Nada de eso está cargado: con el modo "homologacion" se avisa qué falta y no se emite nada.
 */
const crypto = require('node:crypto');
const { fail } = require('../util');

// Número inventado de n dígitos (sin randomInt: la demo del navegador no lo tiene).
const randomDigits = (n) => [...crypto.randomBytes(n)].map((b, i) => (i === 0 ? 1 + (b % 9) : b % 10)).join('');

/** RUT válido (módulo 11, dígito verificador 0-9 o K). */
function validRut(rut) {
  const m = String(rut || '')
    .replace(/[.\s]/g, '')
    .toUpperCase()
    .match(/^(\d{7,8})-?([\dK])$/);
  if (!m) return false;
  let sum = 0;
  let mul = 2;
  for (let i = m[1].length - 1; i >= 0; i--) {
    sum += Number(m[1][i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const r = 11 - (sum % 11);
  const dv = r === 11 ? '0' : r === 10 ? 'K' : String(r);
  return dv === m[2];
}

const cleanRut = (rut) => {
  const s = String(rut || '').replace(/[.\s-]/g, '').toUpperCase();
  return `${s.slice(0, -1)}-${s.slice(-1)}`;
};

function validateSettings(s) {
  const p = [];
  if (!validRut(s.invoice_tax_id)) p.push('Cargá un RUT de prueba válido (por ejemplo 11.111.111-1) en Ajustes → Factura electrónica');
  return p;
}

function invoiceType(inv) {
  return inv.customer.doc_type === 'RUT' && validRut(inv.customer.doc_number) ? { code: 33, name: 'Factura electrónica', letter: '' } : { code: 39, name: 'Boleta electrónica', letter: '' };
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** DTE sin firmar (Encabezado, Detalle y TED de prueba). En Chile los montos van en pesos enteros. */
function buildRequest(inv, s) {
  const boleta = inv.type.code === 39;
  const total = Math.round(inv.total);
  const neto = Math.round(inv.net);
  const iva = total - neto;
  const receptor = boleta ? '66666666-6' : cleanRut(inv.customer.doc_number); // 66666666-6: consumidor final
  return `<?xml version="1.0" encoding="ISO-8859-1"?>
<DTE version="1.0"><Documento ID="T${inv.type.code}F${inv.number}">
<Encabezado>
<IdDoc><TipoDTE>${inv.type.code}</TipoDTE><Folio>${inv.number}</Folio><FchEmis>${inv.date}</FchEmis>${boleta ? '<IndServicio>3</IndServicio>' : ''}</IdDoc>
<Emisor><RUTEmisor>${cleanRut(s.invoice_tax_id)}</RUTEmisor><${boleta ? 'RznSocEmisor' : 'RznSoc'}>${esc(s.company_name)}</${boleta ? 'RznSocEmisor' : 'RznSoc'}><${boleta ? 'GiroEmisor' : 'GiroEmis'}>Arriendo de vehículos</${boleta ? 'GiroEmisor' : 'GiroEmis'}><DirOrigen>${esc(s.company_address)}</DirOrigen></Emisor>
<Receptor><RUTRecep>${receptor}</RUTRecep><RznSocRecep>${esc(inv.customer.name)}</RznSocRecep></Receptor>
<Totales>${boleta ? `<MntNeto>${neto}</MntNeto><IVA>${iva}</IVA>` : `<MntNeto>${neto}</MntNeto><TasaIVA>${inv.tax_rate}</TasaIVA><IVA>${iva}</IVA>`}<MntTotal>${total}</MntTotal></Totales>
</Encabezado>
<Detalle><NroLinDet>1</NroLinDet><NmbItem>${esc(inv.concept)}</NmbItem><QtyItem>1</QtyItem><PrcItem>${boleta ? total : neto}</PrcItem><MontoItem>${boleta ? total : neto}</MontoItem></Detalle>
<TED version="1.0"><DD><RE>${cleanRut(s.invoice_tax_id)}</RE><TD>${inv.type.code}</TD><F>${inv.number}</F><FE>${inv.date}</FE><MNT>${total}</MNT></DD><FRMT algoritmo="SHA1withRSA">SIMULADO</FRMT></TED>
</Documento></DTE>`;
}

async function emit(inv, s, { mode }) {
  const request = buildRequest(inv, s);
  if (mode === 'homologacion') {
    fail(400, 'Para enviar a certificación del SII (maullin.sii.cl) faltan el certificado digital (.pfx) y los folios (CAF) de prueba de la empresa. Mientras tanto, usá el modo "simulado".');
  }
  const trackId = randomDigits(10);
  const response = JSON.stringify({ simulado: true, estado: 'ACEPTADO', trackId, observaciones: 'Documento SIMULADO: no fue enviado al SII y no tiene validez tributaria' });
  return { number: inv.number, auth_code: trackId, auth_due: null, request, response };
}

module.exports = { validRut, validateSettings, invoiceType, buildRequest, emit, label: 'SII (Chile)' };
