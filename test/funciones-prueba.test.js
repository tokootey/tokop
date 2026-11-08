'use strict';

/* Funciones en prueba (se activan por agencia): intervalo, precios por demanda, firma, fotos y tarjeta. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, getSetting, setSetting } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { openPlatform } = require('../src/platform');
const { seed } = require('../src/seed');
const { computeQuote, parseDynamicRules } = require('../src/pricing');
const { isVehicleFree, availableVehicles } = require('../src/availability');
const R = require('../src/reservations');
const D = require('../src/delivery');
const P = require('../src/payments');
const { fmtLocal } = require('../src/util');

function setup(pro = true) {
  const db = openDb(':memory:');
  ensureAdmin(db);
  seed(db);
  if (pro) setSetting(db, 'pro_features', '1');
  const car = db.prepare("SELECT id, category_id FROM vehicles WHERE plate = 'AF123BC'").get();
  const customer = db.prepare('SELECT id FROM customers ORDER BY id').get().id;
  const at = (days, hour = 10) => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return fmtLocal(d);
  };
  const book = (from, to, extra = {}) =>
    R.createReservation(db, { customer_id: customer, category_id: car.category_id, vehicle_id: car.id, pickup_at: from, return_at: to, status: 'confirmada', allow_overbooking: true, ...extra });
  return { db, car, at, book };
}
const PNG = `data:image/png;base64,${Buffer.from('\x89PNG\r\n\x1a\n-firma-', 'latin1').toString('base64')}`;
const TERMS = [{ title: '1. OBJETO', body: 'Se alquila el auto.' }];

test('intervalo: no deja pegar un alquiler a la devolución del anterior, y apagado no cambia nada', () => {
  const { db, car, at, book } = setup();
  book(at(40), at(42));
  const params = (from, to) => ({ vehicle_id: car.id, pickup_at: from, return_at: to });
  assert.equal(isVehicleFree(db, params(at(42), at(44))), true, 'sin intervalo sale a la hora que vuelve');
  setSetting(db, 'turnaround_minutes', '120');
  assert.equal(isVehicleFree(db, params(at(42), at(44))), false);
  assert.equal(isVehicleFree(db, params(at(42, 11), at(44))), false);
  assert.equal(isVehicleFree(db, params(at(42, 12), at(44))), true, 'a las dos horas ya está libre');
  assert.equal(isVehicleFree(db, params(at(38), at(40))), false, 'tampoco pegado antes');
  assert.ok(!availableVehicles(db, { category_id: car.category_id, pickup_at: at(42), return_at: at(44) }).some((v) => v.id === car.id));
  // Una agencia sin las funciones activadas no se ve afectada aunque tenga el dato.
  setSetting(db, 'pro_features', '0');
  assert.equal(isVehicleFree(db, params(at(42), at(44))), true);
});

test('precios por demanda: sube según la ocupación y una reserva hecha conserva su precio', () => {
  const { db, car, at, book } = setup();
  assert.deepEqual(parseDynamicRules('90:20, 70:10'), [{ from: 70, pct: 10 }, { from: 90, pct: 20 }]);
  assert.equal(parseDynamicRules('mucho'), null);
  const range = { category_id: car.category_id, pickup_at: at(60), return_at: at(62) };
  const before = computeQuote(db, range);
  assert.equal(before.dynamic_extra, 0);
  const fleet = db.prepare("SELECT COUNT(*) n FROM vehicles WHERE category_id = ? AND status NOT IN ('mantenimiento', 'fuera_servicio')").get(car.category_id).n;
  setSetting(db, 'dynamic_pricing_rules', '1:10');
  const first = book(at(60), at(62));
  assert.equal(first.pricing.dynamic_pct, 0, 'la primera reserva no se encarece sola');
  const after = computeQuote(db, range);
  assert.equal(after.dynamic_pct, 10, `con ${fleet} autos y uno reservado`);
  assert.equal(after.dynamic_extra, Math.round((before.base + before.season_extra) * 10) / 100);
  assert.ok(after.total > before.total);
  // Cambiar las notas de una reserva no le cambia el precio aunque ahora haya más demanda.
  const second = book(at(60), at(62), { vehicle_id: null });
  assert.equal(second.pricing.dynamic_pct, 10);
  setSetting(db, 'dynamic_pricing_rules', '1:50');
  assert.equal(R.updateReservation(db, second.id, { notes: 'hola' }, null).total, second.total);
  setSetting(db, 'pro_features', '0');
  assert.equal(computeQuote(db, range).dynamic_extra, 0);
});

test('firma: el cliente firma una copia fija; si la reserva cambia, hay que pedirla de nuevo', () => {
  const { db, at, book } = setup();
  const settings = { company_name: 'Austral', currency: 'ARS', locale: 'es-AR' };
  const r = book(at(50), at(52));
  const s = D.requestSignature(db, r.id, TERMS, settings, null);
  assert.equal(D.viewContract(db, s.token).can_sign, true);
  const client = { ip: '200.1.1.1', userAgent: 'test' };
  const good = { name: 'Ana López', doc: '30111222', accepted: true, image: PNG };
  assert.throws(() => D.sign(db, s.token, { ...good, accepted: false }, client), /aceptar/);
  assert.throws(() => D.sign(db, s.token, { ...good, image: 'data:image/png;base64,AAAA' }, client), /firma/);
  assert.throws(() => D.sign(db, s.token, { ...good, doc: '' }, client), /documento/);
  const ok = D.sign(db, s.token, good, client);
  assert.match(ok.hash, /^[0-9a-f]{64}$/);
  assert.throws(() => D.sign(db, s.token, good, client), /ya está firmado/);
  const state = D.stateOf(db, R.getReservation(db, r.id));
  assert.equal(state.name, 'Ana López');
  assert.equal(state.ip, '200.1.1.1');
  assert.equal(state.stale, false);
  assert.equal(D.viewContract(db, s.token).signed.name, 'Ana López');
  // Pedirla de nuevo sin cambios no borra lo firmado.
  assert.equal(D.requestSignature(db, r.id, TERMS, settings, null).signed_at, state.signed_at);

  R.updateReservation(db, r.id, { return_at: at(53) }, null);
  assert.equal(D.stateOf(db, R.getReservation(db, r.id)).stale, true);
  assert.equal(D.viewContract(db, s.token).can_sign, false);
  const again = D.requestSignature(db, r.id, TERMS, settings, null);
  assert.equal(again.signed_at, null);
  assert.equal(D.viewContract(db, s.token).can_sign, true);
  assert.ok(R.getReservation(db, r.id).log.some((l) => l.action === 'firma_anulada'));
});

test('tarjeta: crea el link y registra el pago una sola vez, consultándolo a Mercado Pago', async (t) => {
  const { db, at, book } = setup();
  const r = book(at(70), at(72), { status: 'pendiente' });
  await assert.rejects(P.createPayLink(db, r.id, { base: 'https://x.test' }), /Conectá Mercado Pago/);
  setSetting(db, 'mp_access_token', 'TEST-123');
  setSetting(db, 'card_pay_pct', '50');
  const calls = [];
  const payment = { id: 777, status: 'approved', transaction_amount: 1000, external_reference: r.code };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/checkout/preferences')) return new Response(JSON.stringify({ init_point: 'https://mp.test/pagar' }), { status: 201 });
    return new Response(JSON.stringify(payment), { status: 200 });
  });
  const link = await P.createPayLink(db, r.id, { base: 'https://x.test', query: '?empresa=sur' });
  assert.equal(link.url, 'https://mp.test/pagar');
  assert.equal(link.amount, Math.round(r.total * 50) / 100);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.external_reference, r.code);
  assert.equal(sent.notification_url, 'https://x.test/api/public/mp/aviso?empresa=sur');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer TEST-123');
  await assert.rejects(P.createPayLink(db, r.id, { base: 'https://x.test', amount: r.total + 1 }), /saldo/);

  assert.deepEqual(await P.handleNotice(db, 'abc/../1'), { ignored: true });
  payment.status = 'rejected';
  assert.deepEqual(await P.handleNotice(db, 777), { ignored: true });
  assert.equal(R.getReservation(db, r.id).payments.length, 0);
  payment.status = 'approved';
  assert.deepEqual(await P.handleNotice(db, 777), { registered: true });
  assert.deepEqual(await P.handleNotice(db, 777), { duplicated: true });
  const paid = R.getReservation(db, r.id);
  assert.equal(paid.payments.length, 1);
  assert.equal(paid.payments[0].amount, 1000);
  assert.equal(paid.payments[0].reference, 'MP 777');
  assert.equal(paid.status, 'confirmada');
});

test('API: apagado por defecto, el Access Token nunca sale y la agencia no se activa sola', async () => {
  const { db, at, book } = setup(false);
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-'));
  const server = createApp(db, { uploadsDir: uploads }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const req = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) });
    if (!cookie && res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    await req('POST', '/api/auth/login', { email: 'admin@rentacar.local', password: 'admin123' });
    await req('POST', '/api/auth/password', { current: 'admin123', password: 'Ushuaia2026Segura' });
    const r = book(at(80), at(82));
    assert.equal((await req('POST', `/api/reservations/${r.id}/signature`, { terms: TERMS })).status, 403);
    assert.equal((await req('GET', `/api/reservations/${r.id}`)).data.signature, null);
    await req('PUT', '/api/settings', { pro_features: '1' });
    assert.equal(getSetting(db, 'pro_features'), '0', 'la activa solo el dueño de Floty');

    setSetting(db, 'pro_features', '1');
    assert.equal((await req('PUT', '/api/settings', { dynamic_pricing_rules: 'mucho' })).status, 400);
    assert.equal((await req('PUT', '/api/integration', { card_pay_pct: 0 })).status, 400);
    assert.equal((await req('PUT', '/api/integration', { mp_access_token: 'APP_USR-secreto', webform_site: 'https://www.mipagina.com/cotizar' })).status, 200);
    assert.equal(getSetting(db, 'webform_allowed_origins'), 'https://www.mipagina.com,https://mipagina.com');
    const settings = await req('GET', '/api/settings');
    const integration = await req('GET', '/api/integration');
    assert.equal(settings.data.mp_connected, true);
    assert.equal(integration.data.cards.connected, true);
    assert.ok(!JSON.stringify(settings.data).includes('APP_USR-secreto'));
    assert.ok(!JSON.stringify(integration.data).includes('APP_USR-secreto'));

    // El cliente firma y ve las fotos sin usuario, sólo con el link.
    const s = (await req('POST', `/api/reservations/${r.id}/signature`, { terms: TERMS })).data;
    const anon = (p, init) => fetch(base + p, init);
    assert.equal((await anon('/api/public/entrega/contrato/no-existe')).status, 404);
    const contract = await (await anon(`/api/public/entrega/contrato/${s.token}`)).json();
    assert.equal(contract.can_sign, true);
    assert.equal(contract.terms[0].title, '1. OBJETO');
    const signed = await anon(`/api/public/entrega/contrato/${s.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ana López', doc: '30111222', accepted: true, image: PNG }) });
    assert.equal(signed.status, 200);

    const rel = path.join(String(r.id), 'foto.jpg');
    fs.mkdirSync(path.join(uploads, String(r.id)), { recursive: true });
    fs.writeFileSync(path.join(uploads, rel), Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    db.prepare("INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path) VALUES (?, 'entrega', 'frente.jpg', 'image/jpeg', 4, ?)").run(r.id, rel);
    db.prepare("INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path) VALUES (?, 'contrato', 'c.pdf', 'application/pdf', 4, ?)").run(r.id, rel);
    const photos = await (await anon(`/api/public/entrega/fotos/${s.photos_token}`)).json();
    assert.deepEqual(photos.photos.map((p) => p.name), ['frente.jpg'], 'sólo las fotos de la entrega');
    const image = await anon(`/api/public/entrega/fotos/${s.photos_token}/${photos.photos[0].id}`);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    const other = db.prepare("SELECT id FROM reservation_files WHERE stage = 'contrato'").get().id;
    assert.equal((await anon(`/api/public/entrega/fotos/${s.photos_token}/${other}`)).status, 404);
    // El link de firma no abre las fotos.
    assert.equal((await anon(`/api/public/entrega/fotos/${s.token}`)).status, 404);

    // Anonimizar al cliente borra su firma.
    await req('POST', `/api/customers/${r.customer_id}/anonymize`, {});
    assert.equal((await anon(`/api/public/entrega/contrato/${s.token}`)).status, 404);
  } finally {
    server.close();
    db.close();
  }
});

test('panel: se activa por agencia, con valores de ejemplo la primera vez', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-panel-'));
  const file = path.join(dir, 'rentacar.db');
  const platform = openPlatform(openDb(file), file);
  const a = platform.create({ name: 'Prueba Uno', country: 'AR', admin_name: 'Ana', admin_email: 'ana@uno.test' }).company.id;
  const b = platform.create({ name: 'Prueba Dos', country: 'AR', admin_name: 'Beto', admin_email: 'beto@dos.test' }).company.id;
  assert.equal(platform.stats(a).pro_features, 0);
  assert.equal(platform.updateProfile(a, { pro_features: 1 }).pro_features, 1);
  assert.equal(getSetting(platform.get(a).db, 'turnaround_minutes'), '120');
  assert.equal(platform.stats(b).pro_features, 0, 'la otra agencia no cambia');
  assert.equal(getSetting(platform.get(b).db, 'turnaround_minutes'), '0');
  platform.updateProfile(a, { pro_features: 0 });
  assert.equal(platform.stats(a).pro_features, 0);
});
