'use strict';

/* Link de pago del banco (NeoPayment): lo arma el banco por reserva y, cuando avisa que se pagó, el cobro entra solo. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { start, at } = require('./etapa2-helper');
const { setSetting } = require('../src/db');

/** Un banco de mentira con lo mínimo de la API: token, crear, ver y anular un link. */
async function fakeBank() {
  const checkouts = new Map();
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      const send = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      if (req.url === '/oauth/token') return send(200, { token_type: 'Bearer', expires_in: 3600, access_token: 't0k3n' });
      if (req.headers.authorization !== 'Bearer t0k3n') return send(401, { message: 'unauthorized_access' });
      if (req.method === 'POST' && req.url === '/api/v2/checkout') {
        const b = JSON.parse(raw);
        const slug = `Slug${String(checkouts.size + 1).padStart(4, '0')}`;
        checkouts.set(slug, { slug, status: 'created', amount: b.amount, payment_link: `https://banco.test/checkout/${slug}`, metadatas: b.metadatas, webhook: b.webhook, url_ok: b.url_ok, url_ko: b.url_ko, transactions: [] });
        return send(200, { status: 'ok', data: checkouts.get(slug) });
      }
      const m = req.url.match(/^\/api\/v2\/checkout\/(\w+)(\/cancel)?$/);
      const c = m && checkouts.get(m[1]);
      if (!c) return send(404, { message: 'not found' });
      if (m[2]) c.status = 'canceled';
      send(200, { status: 'ok', data: c });
    });
  });
  await new Promise((r) => server.listen(0, r));
  return { url: `http://127.0.0.1:${server.address().port}`, checkouts, calls, close: () => server.close() };
}

test('el banco arma el link, avisa el pago y la reserva se confirma sola', async () => {
  const app = await start();
  const bank = await fakeBank();
  try {
    setSetting(app.db, 'neo_host', bank.url);
    setSetting(app.db, 'neo_client_id', 'cliente');
    setSetting(app.db, 'neo_client_secret', 'secreto');
    const call = await app.as('admin');
    const notify = async (body) => (await fetch(`${app.base}/api/public/pagos/neopayment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status;
    const payments = (id) => app.db.prepare("SELECT amount, method FROM payments WHERE reservation_id = ? AND kind = 'pago'").all(id).map((p) => ({ ...p }));

    // La clave del banco no vuelve nunca al navegador.
    const settings = (await call('GET', '/api/settings')).data;
    assert.equal(settings.pay_gateway, true);
    assert.equal(settings.neo_client_secret, undefined);

    const r = app.reserve({ name: 'Ana', status: 'pendiente' });
    const first = (await call('POST', `/api/reservations/${r.id}/pay-link`)).data;
    assert.equal(first.url, 'https://banco.test/checkout/Slug0001');
    const made = bank.checkouts.get('Slug0001');
    assert.equal(made.amount, Math.round(r.total * 100));
    assert.equal(made.metadatas.payment_reference, r.code);
    assert.match(made.webhook, /\/api\/public\/pagos\/neopayment$/);
    // Al terminar, el banco devuelve al cliente a la página de la agencia, que le dice cómo salió.
    assert.match(made.url_ok, /\/reservar\?pago=ok$/);
    assert.match(made.url_ko, /\/reservar\?pago=no$/);
    // Pedirlo de nuevo sin que cambie el importe da el mismo link: no quedan dos links pagables.
    assert.equal((await call('POST', `/api/reservations/${r.id}/pay-link`)).data.url, first.url);
    assert.equal(bank.checkouts.size, 1);

    // Un aviso con un código que no es de la agencia no llega ni a consultar al banco.
    const before = bank.calls.length;
    assert.equal(await notify({ status: 'authorized', metadatas: { checkout_slug: 'Inventado1' } }), 404);
    assert.equal(bank.calls.length, before);
    // Un aviso falso de "pagado" sobre un link sin pagar no anota nada: manda lo que dice el banco.
    assert.equal(await notify({ status: 'authorized', amount: 999999, metadatas: { checkout_slug: 'Slug0001' } }), 200);
    assert.equal(payments(r.id).length, 0);

    // "orphan": el banco no supo si se cobró. No se anota.
    made.transactions.push({ id: 70, type: 'sale', status: 'orphan', amount: made.amount });
    assert.equal(await notify({ metadatas: { checkout_slug: 'Slug0001' } }), 200);
    assert.equal(payments(r.id).length, 0);

    // El cliente paga: el cobro entra solo y la reserva pasa a confirmada. El aviso repetido no lo anota dos veces.
    made.status = 'finished';
    made.transactions.push({ id: 71, type: 'sale', status: 'authorized', amount: made.amount });
    assert.equal(await notify({ metadatas: { checkout_slug: 'Slug0001' } }), 200);
    assert.equal(await notify({ metadatas: { checkout_slug: 'Slug0001' } }), 200);
    assert.deepEqual(payments(r.id), [{ amount: r.total, method: 'link de pago' }]);
    const after = (await call('GET', `/api/reservations/${r.id}`)).data;
    assert.equal(after.status, 'confirmada');
    assert.equal(after.balance.pending, 0);
    assert.deepEqual((await call('POST', `/api/reservations/${r.id}/pay-link`)).data, { paid: true, pending: 0, status: 'confirmada' });

    // El aviso no llegó: al pedir el link otra vez, el cobro entra en ese momento.
    const r2 = app.reserve({ name: 'Beto', status: 'pendiente', vehicle_id: 2 });
    await call('POST', `/api/reservations/${r2.id}/pay-link`);
    const second = bank.checkouts.get('Slug0002');
    second.status = 'finished';
    second.transactions.push({ id: 72, type: 'sale', status: 'authorized', amount: second.amount });
    assert.equal((await call('POST', `/api/reservations/${r2.id}/pay-link`)).data.paid, true);
    assert.equal(payments(r2.id).length, 1);

    // Cambió el importe: el link viejo se anula y sale uno nuevo por lo que falta.
    const r3 = app.reserve({ name: 'Caro', status: 'pendiente', vehicle_id: 3, category_id: 2 });
    await call('POST', `/api/reservations/${r3.id}/pay-link`);
    await call('POST', `/api/reservations/${r3.id}/payments`, { kind: 'pago', method: 'efectivo', amount: 10 });
    const again = (await call('POST', `/api/reservations/${r3.id}/pay-link`)).data;
    assert.equal(bank.checkouts.get('Slug0003').status, 'canceled');
    assert.equal(again.url, 'https://banco.test/checkout/Slug0004');
    assert.equal(bank.checkouts.get('Slug0004').amount, Math.round((r3.total - 10) * 100));

    // Link de reservas: el cliente elige. Con tarjeta recibe el link del banco de su reserva, que sigue pendiente hasta que paga.
    setSetting(app.db, 'chat_enabled', '1');
    const bookAs = async (body) => {
      const res = await fetch(`${app.base}/api/public/chat/book`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category: 'ECO', phone: '+507 6000 1111', ...body }) });
      return { status: res.status, data: await res.json() };
    };
    assert.equal((await (await fetch(`${app.base}/api/public/chat/config`)).json()).pay_gateway, true);
    const card = await bookAs({ pickup_at: at(20), return_at: at(23), name: 'Turista Tarjeta', pay: 'tarjeta' });
    assert.equal(card.status, 201, JSON.stringify(card.data));
    assert.equal(card.data.pay_url, 'https://banco.test/checkout/Slug0005');
    assert.equal(bank.checkouts.get('Slug0005').metadatas.payment_reference, card.data.code);
    const saved = (code) => app.db.prepare('SELECT status, notes FROM reservations WHERE code = ?').get(code);
    assert.equal(saved(card.data.code).status, 'pendiente');
    assert.match(saved(card.data.code).notes, /tarjeta/);
    // En efectivo o por transferencia sólo deja el pedido: no se arma ningún link y lo confirma la agencia.
    const cash = await bookAs({ pickup_at: at(30), return_at: at(33), name: 'Turista Efectivo' });
    assert.equal(cash.status, 201, JSON.stringify(cash.data));
    assert.equal(cash.data.pay_url, undefined);
    assert.equal(bank.checkouts.size, 5);
    assert.match(saved(cash.data.code).notes, /efectivo o por transferencia/);
  } finally {
    bank.close();
    app.close();
  }
});

test('sin el banco conectado no hay link del banco', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const r = app.reserve({ status: 'pendiente' });
    assert.equal((await call('POST', `/api/reservations/${r.id}/pay-link`)).status, 400);
    assert.equal((await call('GET', '/api/settings')).data.pay_gateway, false);
    // La agencia no se conecta sola desde Configuración: los datos del banco los carga el dueño de Floty, agencia por agencia.
    await call('PUT', '/api/settings', { neo_host: 'https://banco.test', neo_client_id: 'cliente', neo_client_secret: 'secreto' });
    assert.equal((await call('GET', '/api/settings')).data.pay_gateway, false);
  } finally {
    app.close();
  }
});
