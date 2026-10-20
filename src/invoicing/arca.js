'use strict';

/**
 * ARCA (ex AFIP), Argentina: Web Service de Factura Electrónica (WSFE v1), operación FECAESolicitar.
 * SOLO PRUEBA. Servidor de homologación: https://wswhomo.afip.gov.ar/wsfev1/service.asmx
 *
 * Qué falta para producción (y también para usar homologación de verdad):
 *   1. El CUIT de cada agencia y su punto de venta para "Web Services" (se da de alta en ARCA con clave fiscal).
 *   2. Un certificado digital de la agencia (.crt + clave privada .key) asociado al servicio "wsfe",
 *      para pedir el permiso de acceso (Token y Sign) al WSAA: https://wsaahomo.afip.gov.ar/ws/services/LoginCms
 *      El pedido al WSAA se firma con ese certificado (CMS/PKCS#7); hace falta una librería de firma o openssl.
 *   3. Con Token y Sign, enviar el XML que arma `buildRequest` y leer el CAE de la respuesta.
 *   4. Para producción, cambiar las direcciones a servicios1.afip.gov.ar / wsaa.afip.gov.ar.
 * Nada de eso está cargado: con el modo "homologacion" se avisa qué falta y no se emite nada.
 */
const crypto = require('node:crypto');
const { fail } = require('../util');

// Número inventado de n dígitos (sin randomInt: la demo del navegador no lo tiene).
const randomDigits = (n) => [...crypto.randomBytes(n)].map((b, i) => (i === 0 ? 1 + (b % 9) : b % 10)).join('');

const HOMO_URL = 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx';

/** Dígito verificador del CUIT (módulo 11). */
function validCuit(cuit) {
  const d = String(cuit || '').replace(/\D/g, '');
  if (d.length !== 11) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = w.reduce((acc, k, i) => acc + k * Number(d[i]), 0);
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) return false;
  return check === Number(d[10]);
}

function validateSettings(s) {
  const p = [];
  if (!validCuit(s.invoice_tax_id)) p.push('Cargá un CUIT de prueba válido (11 dígitos) en Ajustes → Factura electrónica');
  if (!['RI', 'MONO'].includes(s.invoice_tax_condition)) p.push('Elegí la condición frente al IVA de la empresa (Responsable Inscripto o Monotributo)');
  if (!(Number(s.invoice_point_of_sale) >= 1 && Number(s.invoice_point_of_sale) <= 99998)) p.push('El punto de venta tiene que ser un número entre 1 y 99998');
  return p;
}

/** Tipo de comprobante según la condición de la empresa y del cliente. */
function invoiceType(inv, s) {
  if (s.invoice_tax_condition === 'MONO') return { code: 11, name: 'Factura C', letter: 'C' };
  // A un cliente con CUIT (empresa) se le hace Factura A; al resto (consumidor final), Factura B.
  return inv.customer.doc_type === 'CUIT' && validCuit(inv.customer.doc_number) ? { code: 1, name: 'Factura A', letter: 'A' } : { code: 6, name: 'Factura B', letter: 'B' };
}

/** Tipos de documento del receptor según la tabla de ARCA. */
function docOf(customer) {
  const n = String(customer.doc_number || '').replace(/\D/g, '');
  if (customer.doc_type === 'CUIT' && validCuit(n)) return { tipo: 80, nro: n };
  if (customer.doc_type === 'DNI' && n) return { tipo: 96, nro: n };
  if (customer.doc_type === 'Pasaporte' && n) return { tipo: 94, nro: n };
  return { tipo: 99, nro: '0' }; // consumidor final sin identificar
}

const ymd = (d) => String(d).replace(/-/g, '').slice(0, 8);
const amt = (n) => Number(n).toFixed(2);

/** XML de FECAESolicitar (WSFE v1) para un comprobante de servicios (Concepto 2). Token y Sign van vacíos hasta tener certificado. */
function buildRequest(inv, s, auth = { token: '', sign: '' }) {
  const doc = docOf(inv.customer);
  const isC = inv.type.code === 11;
  // Condición frente al IVA del receptor (obligatoria desde 2025): 1 = Resp. Inscripto, 5 = Consumidor Final.
  const condReceptor = inv.type.code === 1 ? 1 : 5;
  const iva = isC
    ? ''
    : `<ar:Iva><ar:AlicIva><ar:Id>${ivaId(inv.tax_rate)}</ar:Id><ar:BaseImp>${amt(inv.net)}</ar:BaseImp><ar:Importe>${amt(inv.tax)}</ar:Importe></ar:AlicIva></ar:Iva>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
<soapenv:Body><ar:FECAESolicitar>
<ar:Auth><ar:Token>${auth.token}</ar:Token><ar:Sign>${auth.sign}</ar:Sign><ar:Cuit>${String(s.invoice_tax_id).replace(/\D/g, '')}</ar:Cuit></ar:Auth>
<ar:FeCAEReq>
<ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${inv.point_of_sale}</ar:PtoVta><ar:CbteTipo>${inv.type.code}</ar:CbteTipo></ar:FeCabReq>
<ar:FeDetReq><ar:FECAEDetRequest>
<ar:Concepto>2</ar:Concepto><ar:DocTipo>${doc.tipo}</ar:DocTipo><ar:DocNro>${doc.nro}</ar:DocNro>
<ar:CbteDesde>${inv.number}</ar:CbteDesde><ar:CbteHasta>${inv.number}</ar:CbteHasta><ar:CbteFch>${ymd(inv.date)}</ar:CbteFch>
<ar:ImpTotal>${amt(inv.total)}</ar:ImpTotal><ar:ImpTotConc>0.00</ar:ImpTotConc><ar:ImpNeto>${amt(isC ? inv.total : inv.net)}</ar:ImpNeto>
<ar:ImpOpEx>0.00</ar:ImpOpEx><ar:ImpTrib>0.00</ar:ImpTrib><ar:ImpIVA>${amt(isC ? 0 : inv.tax)}</ar:ImpIVA>
<ar:FchServDesde>${ymd(inv.service_from)}</ar:FchServDesde><ar:FchServHasta>${ymd(inv.service_to)}</ar:FchServHasta><ar:FchVtoPago>${ymd(inv.date)}</ar:FchVtoPago>
<ar:MonId>${inv.currency === 'USD' ? 'DOL' : 'PES'}</ar:MonId><ar:MonCotiz>1</ar:MonCotiz>
<ar:CondicionIVAReceptorId>${condReceptor}</ar:CondicionIVAReceptorId>
${iva}
</ar:FECAEDetRequest></ar:FeDetReq>
</ar:FeCAEReq>
</ar:FECAESolicitar></soapenv:Body></soapenv:Envelope>`;
}

/** Código de alícuota de IVA de ARCA: 3 = 0%, 4 = 10,5%, 5 = 21%, 6 = 27%, 8 = 5%, 9 = 2,5%. */
function ivaId(rate) {
  return { 0: 3, 10.5: 4, 21: 5, 27: 6, 5: 8, 2.5: 9 }[Number(rate)] || 5;
}

async function emit(inv, s, { mode }) {
  const request = buildRequest(inv, s);
  if (mode === 'homologacion') {
    fail(
      400,
      `Para enviar a homologación de ARCA (${HOMO_URL}) falta el certificado de prueba de la empresa asociado a "wsfe" y su permiso del WSAA. Mientras tanto, usá el modo "simulado".`,
    );
  }
  // Simulado: el CAE es inventado (14 dígitos) y vence a los 10 días, como los reales.
  const cae = randomDigits(14);
  const due = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const response = JSON.stringify({ simulado: true, Resultado: 'A', CAE: cae, CAEFchVto: ymd(due), CbteDesde: inv.number, Observaciones: 'Comprobante SIMULADO: no fue enviado a ARCA y no tiene validez fiscal' });
  return { number: inv.number, auth_code: cae, auth_due: due, request, response };
}

module.exports = { validCuit, validateSettings, invoiceType, buildRequest, emit, label: 'ARCA (Argentina)' };
