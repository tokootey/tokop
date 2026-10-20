'use strict';

/* Factura electrónica en modo de prueba: ARCA (Argentina) y SII (Chile). Ninguna sale del sistema. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { seed } = require('../src/seed');
const arca = require('../src/invoicing/arca');
const sii = require('../src/invoicing/sii');

// Identificaciones inventadas, con dígito verificador válido (no son de nadie).
const CUIT_PRUEBA = '20123456786';
const RUT_PRUEBA = '11.111.111-1';

let server;
let base;
let cookie;
let db;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/** Reserva confirmada nueva para el cliente indicado. */
async function reservation(customer) {
  const c = await call('POST', '/api/customers', customer);
  const cat = db.prepare('SELECT id FROM categories ORDER BY id LIMIT 1').get().id;
  const br = db.prepare('SELECT id FROM branches ORDER BY id LIMIT 1').get().id;
  const r = await call('POST', '/api/reservations', {
    customer_id: c.data.id,
    category_id: cat,
    pickup_branch_id: br,
    return_branch_id: br,
    pickup_at: '2027-05-10T10:00',
    return_at: '2027-05-13T10:00',
    status: 'confirmada',
    allow_overbooking: true,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

const settings = (s) => call('PUT', '/api/settings', s);

test.before(async () => {
  db = openDb(':memory:');
  ensureAdmin(db);
  seed(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  let res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@rentacar.local', password: 'admin123' }) });
  cookie = res.headers.get('set-cookie').split(';')[0];
  res = await call('POST', '/api/auth/password', { current: 'admin123', password: 'Factura2026Prueba' });
  assert.equal(res.status, 200);
});

test.after(() => server.close());

test('dígitos verificadores de CUIT y RUT', () => {
  assert.equal(arca.validCuit(CUIT_PRUEBA), true);
  assert.equal(arca.validCuit('20-12345678-6'), true);
  assert.equal(arca.validCuit('20123456780'), false);
  assert.equal(sii.validRut(RUT_PRUEBA), true);
  assert.equal(sii.validRut('76.086.428-5'), true);
  assert.equal(sii.validRut('11.111.111-2'), false);
});

test('sin datos fiscales no se factura, y se explica qué falta', async () => {
  const r = await reservation({ full_name: 'Sin Config', doc_type: 'DNI', doc_number: '30111222' });
  const res = await call('POST', `/api/reservations/${r.id}/invoice`);
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Elegí el sistema de factura electrónica/);
  await settings({ invoice_provider: 'arca', invoice_tax_id: '20123456780' });
  assert.match((await call('POST', `/api/reservations/${r.id}/invoice`)).data.error, /CUIT de prueba válido/);
});

test('ARCA simulado: Factura B a consumidor final, con el pedido WSFE completo', async () => {
  await settings({ invoice_provider: 'arca', invoice_mode: 'simulado', invoice_tax_id: CUIT_PRUEBA, invoice_tax_condition: 'RI', invoice_point_of_sale: '3', tax_rate: '21', prices_include_tax: '1' });
  const r = await reservation({ full_name: 'Consumidor Final', doc_type: 'DNI', doc_number: '30111222' });
  const res = await call('POST', `/api/reservations/${r.id}/invoice`);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const inv = res.data;
  assert.equal(inv.type_name, 'Factura B');
  assert.equal(inv.mode, 'simulado');
  assert.equal(inv.point_of_sale, 3);
  assert.equal(inv.number, 1);
  assert.match(inv.auth_code, /^\d{14}$/); // CAE inventado
  assert.equal(inv.total, r.total);
  assert.equal(Math.round((inv.net + inv.tax) * 100), Math.round(inv.total * 100));
  assert.equal(Math.round(inv.net * 1.21 * 100) / 100, Math.round(inv.total * 100) / 100);
  for (const tag of ['<ar:CbteTipo>6</ar:CbteTipo>', '<ar:PtoVta>3</ar:PtoVta>', '<ar:DocTipo>96</ar:DocTipo>', '<ar:DocNro>30111222</ar:DocNro>', '<ar:Concepto>2</ar:Concepto>', '<ar:CondicionIVAReceptorId>5</ar:CondicionIVAReceptorId>', '<ar:Id>5</ar:Id>', `<ar:Cuit>${CUIT_PRUEBA}</ar:Cuit>`, '<ar:FchServDesde>20270510</ar:FchServDesde>']) {
    assert.ok(inv.request.includes(tag), tag);
  }
  assert.match(JSON.parse(inv.response).Observaciones, /SIMULADO/);

  // Una sola factura por reserva; la reserva la muestra y queda en su historial.
  assert.equal((await call('POST', `/api/reservations/${r.id}/invoice`)).status, 409);
  const detail = (await call('GET', `/api/reservations/${r.id}`)).data;
  assert.equal(detail.invoices.length, 1);
  assert.ok(detail.log.some((l) => l.action === 'factura_emitida'));

  // La siguiente factura B del mismo punto de venta es la número 2.
  const r2 = await reservation({ full_name: 'Otro Cliente', doc_type: 'Pasaporte', doc_number: 'AB123456' });
  const inv2 = (await call('POST', `/api/reservations/${r2.id}/invoice`)).data;
  assert.equal(inv2.number, 2);
  assert.ok(inv2.request.includes('<ar:DocTipo>94</ar:DocTipo>'));
});

test('ARCA: Factura A a una empresa con CUIT y Factura C para monotributistas', async () => {
  const empresa = await reservation({ full_name: 'Turismo SA', doc_type: 'CUIT', doc_number: '30-12345678-1' });
  const resA = await call('POST', `/api/reservations/${empresa.id}/invoice`);
  assert.equal(resA.status, 201, JSON.stringify(resA.data));
  assert.equal(resA.data.type_name, 'Factura A');
  for (const tag of ['<ar:CbteTipo>1</ar:CbteTipo>', '<ar:DocTipo>80</ar:DocTipo>', '<ar:DocNro>30123456781</ar:DocNro>', '<ar:CondicionIVAReceptorId>1</ar:CondicionIVAReceptorId>']) {
    assert.ok(resA.data.request.includes(tag), tag);
  }

  await settings({ invoice_tax_condition: 'MONO' });
  const r = await reservation({ full_name: 'Cliente Mono', doc_type: 'DNI', doc_number: '28999888' });
  const c = (await call('POST', `/api/reservations/${r.id}/invoice`)).data;
  assert.equal(c.type_name, 'Factura C');
  assert.ok(c.request.includes('<ar:ImpIVA>0.00</ar:ImpIVA>'));
  assert.ok(!c.request.includes('<ar:Iva>'));
  await settings({ invoice_tax_condition: 'RI' });
});

test('ARCA homologación: avisa que falta el certificado y no emite nada', async () => {
  await settings({ invoice_mode: 'homologacion' });
  const r = await reservation({ full_name: 'Homo', doc_type: 'DNI', doc_number: '27111222' });
  const res = await call('POST', `/api/reservations/${r.id}/invoice`);
  assert.equal(res.status, 400);
  assert.match(res.data.error, /certificado/);
  assert.equal((await call('GET', `/api/reservations/${r.id}`)).data.invoices.length, 0);
  await settings({ invoice_mode: 'simulado' });
});

test('no se factura una reserva pendiente ni cancelada', async () => {
  const r = await reservation({ full_name: 'Pendiente', doc_type: 'DNI', doc_number: '26111222' });
  await call('POST', `/api/reservations/${r.id}/status`, { status: 'cancelada' });
  const res = await call('POST', `/api/reservations/${r.id}/invoice`);
  assert.equal(res.status, 400);
});

test('SII simulado: boleta electrónica en pesos enteros, con el DTE armado', async () => {
  await settings({ invoice_provider: 'sii', invoice_tax_id: RUT_PRUEBA, tax_rate: '19', currency: 'CLP', company_name: 'Agencia de Prueba' });
  const r = await reservation({ full_name: 'Persona Chile', doc_type: 'CI', doc_number: '12345' });
  const res = await call('POST', `/api/reservations/${r.id}/invoice`);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const inv = res.data;
  assert.equal(inv.type_name, 'Boleta electrónica');
  assert.equal(inv.number, 1);
  for (const tag of ['<TipoDTE>39</TipoDTE>', '<Folio>1</Folio>', '<RUTEmisor>11111111-1</RUTEmisor>', '<RUTRecep>66666666-6</RUTRecep>', `<MntTotal>${Math.round(inv.total)}</MntTotal>`, 'Agencia de Prueba']) {
    assert.ok(inv.request.includes(tag), tag);
  }
  assert.match(JSON.parse(inv.response).observaciones, /SIMULADO/);

  // Con RUT de empresa: factura electrónica (tipo 33).
  const emp = await reservation({ full_name: 'Empresa Chile', doc_type: 'RUT', doc_number: '76.086.428-5' });
  const f = (await call('POST', `/api/reservations/${emp.id}/invoice`)).data;
  assert.equal(f.type_name, 'Factura electrónica');
  assert.ok(f.request.includes('<RUTRecep>76086428-5</RUTRecep>'));

  await settings({ invoice_mode: 'homologacion' });
  const h = await reservation({ full_name: 'Homo Chile', doc_type: 'CI', doc_number: '999' });
  assert.match((await call('POST', `/api/reservations/${h.id}/invoice`)).data.error, /folios \(CAF\)/);
});
