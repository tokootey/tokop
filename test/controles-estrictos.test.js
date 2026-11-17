'use strict';

/* "Controles estrictos del contrato": con el ajuste prendido no se entrega ni se cierra si falta algo, tampoco como administrador. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, at } = require('./etapa2-helper');

test('controles estrictos: apagados no cambian nada; prendidos frenan la entrega y el cierre hasta completar todo', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const out = (r, body) => call('POST', `/api/reservations/${r.id}/checkout`, { out_at: at(0, 9), ...body });
    const missing = async (r, q = '') => (await call('GET', `/api/reservations/${r.id}/open-missing${q}`)).data.missing;

    // Apagado (como siempre): se entrega sin pagos, garantía ni firma.
    const plain = app.reserve();
    assert.deepEqual(await missing(plain), []);
    assert.equal((await out(plain)).data.status, 'en_curso');

    assert.equal((await call('PUT', '/api/settings', { strict_contract: 1, country: 'PA', currency: 'USD' })).status, 200);
    const r = app.reserve({ vehicle_id: 2 });
    app.db.prepare('UPDATE reservations SET deposit = 100 WHERE id = ?').run(r.id);

    // Antes de abrir la ventana de entrega: documentos, garantía, pago y firma. En la pre-entrega la firma no se pide.
    const before = await missing(r);
    assert.equal(before.length, 5);
    assert.match(before.join('|'), /licencia.*cédula o del pasaporte.*garantía \(USD 100\.00; recibido USD 0\.00\).*cobrar el alquiler.*firma del cliente/);
    assert.equal((await missing(r, '?firma=0')).length, 4);
    // El administrador tampoco pasa: la entrega se rechaza y dice todo lo que falta, también lo de la ventana.
    const blocked = await out(r);
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /No se puede abrir el contrato\. Falta: .*kilometraje de salida.*combustible de salida.*Panapass de salida.*garantía.*firma/);
    assert.equal(app.db.prepare('SELECT status FROM reservations WHERE id = ?').get(r.id).status, 'confirmada');

    // Se completa: fotos de los documentos, pago, garantía y el contrato firmado en papel.
    for (const kind of ['carnet_frente', 'dni_frente']) app.db.prepare("INSERT INTO customer_files (customer_id, kind, name, mime, size, path) VALUES (?, ?, 'd.jpg', 'image/jpeg', 1, 'x')").run(r.customer_id, kind);
    await call('POST', `/api/reservations/${r.id}/payments`, { amount: r.total, kind: 'pago' });
    await call('POST', `/api/reservations/${r.id}/payments`, { amount: 100, kind: 'garantia' });
    assert.deepEqual(await missing(r), ['la firma del cliente (digital, o la foto del contrato firmado en papel)']);
    app.db.prepare("INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path) VALUES (?, 'firmado', 'c.jpg', 'image/jpeg', 1, 'x')").run(r.id);
    assert.deepEqual(await missing(r), []);
    // Falta un dato de la ventana: sigue sin abrirse. Con todo, se entrega.
    assert.match((await out(r, { out_km: 2000, out_fuel: 8 })).data.error, /Falta: el saldo de Panapass de salida\.$/);
    assert.equal((await out(r, { out_km: 2000, out_fuel: 8, out_panapass: 10 })).data.status, 'en_curso');

    // Devolución: sin Panapass no se registra; con km de más queda saldo y el contrato no se cierra hasta cobrarlo.
    const back = (body) => call('POST', `/api/reservations/${r.id}/checkin`, { in_at: at(3, 8), ...body });
    assert.match((await back({ in_km: 2500, in_fuel: 8 })).data.error, /No se puede registrar la devolución\. Falta: el saldo de Panapass de devolución\.$/);
    const returned = (await back({ in_km: 2500, in_fuel: 8, in_panapass: 10 })).data;
    assert.deepEqual([returned.status, returned.contract.closed_at, returned.contract.pending_note], ['finalizada', null, 'Saldo sin cobrar']);
    assert.ok(returned.balance.pending > 0);
    assert.equal((await call('POST', `/api/reservations/${r.id}/close-contract`)).status, 409);
    await call('POST', `/api/reservations/${r.id}/payments`, { amount: returned.balance.pending, kind: 'pago' });
    assert.ok((await call('POST', `/api/reservations/${r.id}/close-contract`)).data.contract.closed_at);
  } finally {
    app.close();
  }
});

test('marca de la agencia en las páginas del cliente: sólo con el ajuste prendido', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const r = app.reserve();
    const logo = 'data:image/png;base64,iVBORw0KGgo=';
    await call('PUT', '/api/settings', { company_logo: logo });
    const token = (await call('POST', `/api/reservations/${r.id}/card-link`)).data.card_token;
    const card = async () => (await fetch(`${app.base}/api/public/entrega/tarjeta/${token}`)).json();
    // Apagado: la página de la tarjeta no recibe ni el logo ni la etiqueta.
    assert.deepEqual([(await card()).branded, (await card()).logo], [undefined, undefined]);
    await call('PUT', '/api/settings', { public_branding: 1 });
    assert.deepEqual([(await card()).branded, (await card()).logo], [true, logo]);
  } finally {
    app.close();
  }
});

test('perfil de contabilidad: consulta todo y sólo carga gastos de los autos', async () => {
  const app = await start();
  try {
    const call = await app.as('contable');
    const r = app.reserve();
    // Consulta: reservas, caja, autos y estadísticas.
    for (const p of [`/api/reservations/${r.id}`, '/api/cash', '/api/vehicles', '/api/expenses', '/api/stats']) assert.equal((await call('GET', p)).status, 200, p);
    // Carga y corrige gastos de un auto.
    const gasto = await call('POST', '/api/expenses', { vehicle_id: 1, date: at(0).slice(0, 10), kind: 'combustible', description: 'Nafta', amount: 20 });
    assert.equal(gasto.status, 201);
    assert.equal((await call('PUT', `/api/expenses/${gasto.data.id}`, { amount: 25 })).status, 200);
    // Todo lo demás queda cerrado: cobrar, entregar, cambiar un auto, borrarlo o borrar un gasto.
    const denied = [
      ['POST', `/api/reservations/${r.id}/payments`, { amount: 10 }],
      ['POST', `/api/reservations/${r.id}/checkout`, {}],
      ['POST', '/api/reservations', {}],
      ['PUT', '/api/vehicles/1', { km: 5 }],
      ['DELETE', '/api/vehicles/1'],
      ['DELETE', `/api/expenses/${gasto.data.id}`],
      ['PUT', '/api/settings', { company_name: 'x' }],
    ];
    for (const [m, p, b] of denied) assert.equal((await call(m, p, b)).status, 403, `${m} ${p}`);
    assert.equal(app.db.prepare('SELECT km FROM vehicles WHERE id = 1').get().km, 1000);
    // El operador sigue sin ver las estadísticas ni poder borrar autos.
    const op = await app.as('operador');
    assert.deepEqual([(await op('GET', '/api/stats')).status, (await op('DELETE', '/api/vehicles/3')).status], [403, 403]);
  } finally {
    app.close();
  }
});

test('punto de entrega (aeropuerto): se elige en las reservas, va después de las sucursales y el auto no queda ahí', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    // Tocumen pasa a ser sólo punto de entrega: Centro queda primero en la lista (es la opción que viene elegida).
    assert.equal((await call('PUT', '/api/branches/1', { pickup_only: 1 })).status, 200);
    assert.deepEqual((await call('GET', '/api/branches')).data.map((b) => [b.name, b.pickup_only]), [['Centro', 0], ['Tocumen', 1]]);
    // Un auto de Centro se retira y se devuelve en el aeropuerto: sigue figurando en Centro.
    const r = app.rent({ vehicle_id: 2, pickup_branch_id: 1, return_branch_id: 1 });
    const back = await call('POST', `/api/reservations/${r.id}/checkin`, { in_km: 2100, in_fuel: 8, in_at: at(3, 8), return_branch_id: 1 });
    assert.equal(back.data.status, 'finalizada');
    assert.equal(app.db.prepare('SELECT branch_id FROM vehicles WHERE id = 2').get().branch_id, 2);
    // Devuelto en una sucursal de verdad, el auto sí queda ahí (como siempre).
    await call('PUT', '/api/branches/1', { pickup_only: 0 });
    const r2 = app.rent({ vehicle_id: 2, pickup_at: at(5, 8), return_at: at(6, 8), out_at: at(5, 9) });
    await call('POST', `/api/reservations/${r2.id}/checkin`, { in_km: 2200, in_fuel: 8, in_at: at(6, 8), return_branch_id: 1 });
    assert.equal(app.db.prepare('SELECT branch_id FROM vehicles WHERE id = 2').get().branch_id, 1);
  } finally {
    app.close();
  }
});

test('contrato para firmar: guarda también la versión en inglés si la agencia la manda', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const r = app.reserve();
    const es = [{ title: '1. OBJETO.', body: 'Texto en español.' }];
    const en = [{ title: '1. PURPOSE.', body: 'Text in English.' }];
    const view = async (token) => (await fetch(`${app.base}/api/public/entrega/contrato/${token}`)).json();
    // Como siempre: sin versión en inglés, el contrato trae sólo sus condiciones.
    const a = (await call('POST', `/api/reservations/${r.id}/signature`, { terms: es })).data;
    assert.deepEqual([(await view(a.token)).terms, (await view(a.token)).terms_en], [es, undefined]);
    // Con las dos, el cliente recibe las dos y la página elige según el idioma.
    const r2 = app.reserve({ vehicle_id: 2 });
    const b = (await call('POST', `/api/reservations/${r2.id}/signature`, { terms: es, terms_en: en })).data;
    assert.deepEqual([(await view(b.token)).terms, (await view(b.token)).terms_en], [es, en]);
  } finally {
    app.close();
  }
});

test('firma de cada conductor adicional: su propio link, sobre el mismo contrato del cliente', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const r = app.reserve();
    await call('POST', `/api/reservations/${r.id}/parties`, { drivers: [{ full_name: 'Pedro Altamiranda', doc_number: '8-457-985' }, { full_name: 'Rubén López', doc_number: '8-457-955' }] });
    const link = (i) => call('POST', `/api/reservations/${r.id}/driver-link`, { index: i });
    const pub = (token) => `${app.base}/api/public/entrega/contrato/${token}`;
    const sign = (token, body) => fetch(pub(token), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    // Sin el contrato del cliente pedido, todavía no hay qué firmar.
    assert.equal((await link(0)).status, 409);
    await call('POST', `/api/reservations/${r.id}/signature`, { terms: [{ title: '1. OBJETO.', body: 'Texto.' }] });
    const [a, b] = [(await link(0)).data, (await link(1)).data];
    assert.deepEqual([a.name, b.name, a.token === b.token, (await link(0)).data.token === a.token], ['Pedro Altamiranda', 'Rubén López', false, true]);
    assert.equal((await link(5)).status, 404);
    // El conductor ve el contrato con su nombre y lo firma; no abre el alquiler ni firma por el cliente.
    const view = await (await fetch(pub(a.token))).json();
    assert.deepEqual([view.driver, view.can_sign, view.terms.length], [{ name: 'Pedro Altamiranda', doc: '8-457-985' }, true, 1]);
    assert.equal((await sign(a.token, { name: 'Pedro Altamiranda', doc: '8-457-985', accepted: true, image: 'x' })).status, 400);
    assert.equal((await sign(a.token, { name: 'Pedro Altamiranda', doc: '8-457-985', accepted: true, image })).status, 200);
    assert.equal((await sign(a.token, { name: 'Pedro Altamiranda', doc: '8-457-985', accepted: true, image })).status, 409);
    const state = (await call('GET', `/api/reservations/${r.id}`)).data;
    assert.equal(state.status, 'confirmada');
    assert.equal(state.signature.signed_at, null);
    assert.deepEqual(state.signature.drivers.map((d) => [d.name, Boolean(d.signed_at), d.requested]), [['Pedro Altamiranda', true, true], ['Rubén López', false, true]]);
    // Si lo sacan de la reserva, su link deja de servir.
    await call('POST', `/api/reservations/${r.id}/parties`, { drivers: [{ full_name: 'Pedro Altamiranda', doc_number: '8-457-985' }] });
    assert.equal((await fetch(pub(b.token))).status, 404);
  } finally {
    app.close();
  }
});
