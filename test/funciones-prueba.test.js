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

test('tarjeta: guarda sólo titular, marca, últimos 4 y vencimiento, y rechaza el número completo', () => {
  const { db, at, book } = setup();
  const r = book(at(70), at(72), { status: 'pendiente' });
  const token = D.cardLink(db, r.id).card_token;
  assert.equal(D.viewCard(db, token).card, null);
  const good = { holder: 'Ana López', brand: 'Visa', last4: '4242', exp: '12/40', accepted: true };
  const client = { ip: '200.1.1.1' };
  assert.throws(() => D.saveCard(db, token, { ...good, last4: '4242424242424242' }, client), /número completo/);
  assert.throws(() => D.saveCard(db, token, { ...good, holder: '4242 4242 4242 4242' }, client), /número completo/);
  assert.throws(() => D.saveCard(db, token, { ...good, number: '4242424242424242' }, client), /número completo/);
  assert.throws(() => D.saveCard(db, token, { ...good, last4: '42' }, client), /número/);
  assert.throws(() => D.saveCard(db, token, { ...good, exp: '01/20' }, client), /vencida/);
  assert.throws(() => D.saveCard(db, token, { ...good, exp: '13/40' }, client), /MM\/AA/);
  assert.throws(() => D.saveCard(db, token, { ...good, accepted: false }, client), /presentar/);
  assert.equal(D.viewCard(db, token).card, null, 'nada de lo rechazado quedó guardado');
  D.saveCard(db, token, { ...good, cvv: '123' }, client);
  assert.deepEqual(D.viewCard(db, token).card, { holder: 'Ana López', brand: 'Visa', last4: '4242', exp: '12/40' });
  const stored = JSON.stringify(db.prepare('SELECT * FROM delivery_links WHERE reservation_id = ?').get(r.id));
  assert.ok(!stored.includes('123"') && !stored.includes('42424242'), 'ni el código ni el número se guardan');
  assert.equal(D.stateOf(db, R.getReservation(db, r.id)).card.last4, '4242');
  assert.ok(R.getReservation(db, r.id).log.some((l) => l.action === 'tarjeta_dejada'));
  // Una reserva terminada ya no recibe tarjetas.
  R.changeStatus(db, r.id, 'cancelada', null);
  assert.throws(() => D.viewCard(db, token), /ya no está disponible/);
});

test('API: apagado por defecto y la agencia no se activa sola', async () => {
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
    // La firma del contrato la tienen todas las agencias; la tarjeta y la pre-entrega siguen siendo de prueba.
    assert.equal((await req('GET', `/api/reservations/${r.id}`)).data.signature, null);
    assert.equal((await req('POST', `/api/reservations/${r.id}/signature`, { terms: TERMS })).status, 200);
    assert.equal((await req('GET', `/api/reservations/${r.id}`)).data.signature.requested, true);
    assert.equal((await req('POST', `/api/reservations/${r.id}/card-link`)).status, 403);
    await req('PUT', '/api/settings', { pro_features: '1' });
    assert.equal(getSetting(db, 'pro_features'), '0', 'la activa solo el dueño de Floty');

    setSetting(db, 'pro_features', '1');
    assert.equal((await req('PUT', '/api/settings', { dynamic_pricing_rules: 'mucho' })).status, 400);
    assert.equal((await req('PUT', '/api/integration', { webform_site: 'https://www.mipagina.com/cotizar' })).status, 200);
    assert.equal(getSetting(db, 'webform_allowed_origins'), 'https://www.mipagina.com,https://mipagina.com');

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

    // La tarjeta se deja con su propio link, y el de firma no sirve para eso.
    const card = (await req('POST', `/api/reservations/${r.id}/card-link`)).data.card_token;
    assert.equal((await anon(`/api/public/entrega/tarjeta/${s.token}`)).status, 404);
    const left = await anon(`/api/public/entrega/tarjeta/${card}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ holder: 'Ana López', brand: 'Visa', last4: '4242', exp: '12/40', accepted: true }) });
    assert.equal(left.status, 200);
    assert.equal((await req('GET', `/api/reservations/${r.id}`)).data.signature.card.last4, '4242');

    // Anonimizar al cliente borra su firma y su tarjeta.
    await req('POST', `/api/customers/${r.customer_id}/anonymize`, {});
    assert.equal((await anon(`/api/public/entrega/contrato/${s.token}`)).status, 404);
  } finally {
    server.close();
    db.close();
  }
});

test('entrega express: el cliente ve dónde quedó el auto y sube las fotos de la devolución con su link', async () => {
  const { db, car, at, book } = setup();
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-dev-'));
  const server = createApp(db, { uploadsDir: uploads }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const send = (token, body = JPG, type = 'image/jpeg') => fetch(`${base}/api/public/entrega/devolucion/${token}?name=frente.jpg`, { method: 'POST', headers: { 'Content-Type': type }, body });
  try {
    const r = book(at(90), at(92));
    assert.throws(() => D.returnLink(db, r.id), /en curso/, 'antes de entregar no hay link de devolución');
    R.checkout(db, r.id, { vehicle_id: car.id, out_km: 16000, out_fuel: 6, out_notes: 'Rayón en la puerta' }, null);
    D.setLeftPlace(db, r.id, ' Aeropuerto, lugar 45 ', null);

    const photosToken = D.photosLink(db, r.id).photos_token;
    const photos = await (await fetch(`${base}/api/public/entrega/fotos/${photosToken}`)).json();
    assert.equal(photos.left_place, 'Aeropuerto, lugar 45');
    assert.equal(photos.condition.out_notes, 'Rayón en la puerta');

    const { return_token: token } = D.returnLink(db, r.id);
    assert.equal(D.returnLink(db, r.id).return_token, token, 'el link no cambia');
    assert.equal((await send('no-existe')).status, 404);
    assert.equal((await send(photosToken)).status, 404, 'el link de ver fotos no sirve para subir');
    assert.equal((await send(token, Buffer.from('<svg/>'), 'image/svg+xml')).status, 415);
    assert.equal((await send(token, Buffer.from('%PDF-1.4'), 'application/pdf')).status, 415, 'sólo fotos');
    assert.equal((await send(token, Buffer.from('no es foto'))).status, 415, 'se mira el contenido, no lo que dice ser');
    assert.equal((await send(token)).status, 201);

    const files = db.prepare('SELECT * FROM reservation_files WHERE reservation_id = ?').all(r.id);
    assert.deepEqual(files.map((f) => [f.stage, f.name, f.created_by]), [['devolucion', 'Cliente: frente.jpg', null]]);

    // Tope: un link público no puede llenar el disco.
    const row = db.prepare('INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path) VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 29; i += 1) row.run(r.id, 'devolucion', `f${i}`, 'image/jpeg', 4, 'x');
    assert.equal((await send(token)).status, 409);
    db.prepare("DELETE FROM reservation_files WHERE name LIKE 'f%'").run();

    // Registrada la devolución, el link se cierra.
    R.checkin(db, r.id, { in_km: 16100, in_fuel: 6 }, null);
    assert.equal((await (await fetch(`${base}/api/public/entrega/devolucion/${token}`)).json()).can_upload, false);
    assert.equal((await send(token)).status, 409);

    // Apagada la función, el link no responde.
    setSetting(db, 'pro_features', '0');
    assert.equal((await fetch(`${base}/api/public/entrega/devolucion/${token}`)).status, 404);
  } finally {
    server.close();
    db.close();
  }
});

test('entrega express: el cliente ve las fotos al firmar y el lugar del auto recién después', () => {
  const { db, car, at, book } = setup();
  const r = book(at(100), at(101));
  R.checkout(db, r.id, { vehicle_id: car.id, out_km: 16000, out_fuel: 6, out_notes: 'Rayón' }, null);
  db.prepare("INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path) VALUES (?, 'entrega', 'frente.jpg', 'image/jpeg', 4, 'x')").run(r.id);
  D.setLeftPlace(db, r.id, 'Aeropuerto, lugar 45', null);
  assert.equal(D.deliveryPhotos(db, D.photosLink(db, r.id).photos_token).left_place, 'Aeropuerto, lugar 45', 'sin firma pedida se ve');

  const s = D.requestSignature(db, r.id, TERMS, { company_name: 'X' }, null);
  const before = D.viewContract(db, s.token);
  assert.deepEqual(before.photos.map((p) => p.name), ['frente.jpg']);
  assert.equal(before.condition.out_notes, 'Rayón');
  assert.equal(before.left_place, null, 'antes de firmar no se ve en el contrato');
  assert.equal(D.deliveryPhotos(db, s.photos_token).left_place, null, 'ni en el link de fotos');

  const signed = D.sign(db, s.token, { name: 'Ana López', doc: '30111222', accepted: true, image: PNG }, { ip: '1.1.1.1', userAgent: 'x' });
  assert.equal(signed.left_place, 'Aeropuerto, lugar 45');
  assert.equal(D.viewContract(db, s.token).left_place, 'Aeropuerto, lugar 45');
  assert.equal(D.deliveryPhotos(db, s.photos_token).left_place, 'Aeropuerto, lugar 45');
  const log = R.getReservation(db, r.id).log.find((l) => l.action === 'firma_cliente');
  assert.match(String(log.detail), /frente\.jpg/, 'queda qué fotos había al firmar');
});

test('pre-entrega: el alquiler arranca recién cuando el cliente firma', () => {
  const { db, car, at, book } = setup();
  const client = { ip: '1.1.1.1', userAgent: 'x' };
  const good = { name: 'Ana López', doc: '30111222', accepted: true, image: PNG };
  const pre = { vehicle_id: car.id, left_place: 'Aeropuerto, lugar 45', out_km: 16000, out_fuel: 6, out_notes: 'Rayón', terms: TERMS };
  const r = book(at(105), at(106));

  assert.throws(() => D.preDeliver(db, r.id, { ...pre, left_place: '' }, { company_name: 'X' }, null), /dónde queda/);
  assert.throws(() => D.preDeliver(db, r.id, { ...pre, out_km: 1 }, { company_name: 'X' }, null), /km de salida/, 'valida lo mismo que la entrega');

  const s = D.preDeliver(db, r.id, pre, { company_name: 'X' }, null);
  let now = R.getReservation(db, r.id);
  assert.equal(now.status, 'confirmada');
  assert.equal(now.contract, null, 'todavía no hay contrato abierto');
  assert.notEqual(db.prepare('SELECT status FROM vehicles WHERE id = ?').get(car.id).status, 'alquilado');
  assert.equal(D.viewContract(db, s.token).condition.out_notes, 'Rayón', 've el estado antes de firmar');
  assert.equal(D.viewContract(db, s.token).left_place, null);
  assert.throws(() => D.returnLink(db, r.id), /en curso/);

  // Corregir la pre-entrega antes de que firme.
  D.preDeliver(db, r.id, { ...pre, out_km: 16010 }, { company_name: 'X' }, null);
  assert.equal(D.viewContract(db, s.token).condition.out_km, 16010);

  // Si ya no se puede entregar, la firma no se guarda.
  db.prepare("UPDATE vehicles SET status = 'alquilado' WHERE id = ?").run(car.id);
  assert.throws(() => D.sign(db, s.token, good, client), /Escribile a la agencia/);
  now = R.getReservation(db, r.id);
  assert.equal(now.status, 'confirmada');
  assert.equal(D.stateOf(db, now).signed_at, null);
  assert.ok(now.log.some((l) => l.action === 'entrega_fallida'), 'la agencia ve el motivo');
  db.prepare("UPDATE vehicles SET status = 'disponible' WHERE id = ?").run(car.id);

  // Firmó: se completa la entrega con los datos de la pre-entrega.
  const signed = D.sign(db, s.token, good, client);
  assert.equal(signed.left_place, 'Aeropuerto, lugar 45');
  now = R.getReservation(db, r.id);
  assert.equal(now.status, 'en_curso');
  assert.equal(now.contract.out_km, 16010);
  assert.equal(now.contract.out_notes, 'Rayón');
  assert.equal(db.prepare('SELECT status FROM vehicles WHERE id = ?').get(car.id).status, 'alquilado');
  assert.equal(D.viewContract(db, s.token).stale, false, 'completar la entrega no invalida la firma');
  assert.equal(D.stateOf(db, now).pre_delivery, null);
  assert.ok(D.returnLink(db, r.id).return_token);
});

test('pre-entrega: si la agencia entrega en persona antes de la firma, no se entrega dos veces', () => {
  const { db, car, at, book } = setup();
  const r = book(at(110), at(111));
  const s = D.preDeliver(db, r.id, { vehicle_id: car.id, left_place: 'Oficina', out_km: 16000, out_fuel: 6, terms: TERMS }, { company_name: 'X' }, null);
  R.checkout(db, r.id, { vehicle_id: car.id, out_km: 16000, out_fuel: 6 }, null);
  assert.equal(D.sign(db, s.token, { name: 'Ana López', doc: '30111222', accepted: true, image: PNG }, { ip: '1.1.1.1', userAgent: 'x' }).ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contracts WHERE reservation_id = ?').get(r.id).n, 1);
});

test('entrega express: una fila creada antes del link de devolución recibe su código', () => {
  const { db, car, at, book } = setup();
  const r = book(at(95), at(96));
  R.checkout(db, r.id, { vehicle_id: car.id, out_km: 16000, out_fuel: 6 }, null);
  db.prepare("INSERT INTO delivery_links (reservation_id, token, photos_token, card_token) VALUES (?, 'a', 'b', 'c')").run(r.id);
  assert.ok(D.returnLink(db, r.id).return_token);
  assert.equal(db.prepare('SELECT token FROM delivery_links WHERE reservation_id = ?').get(r.id).token, 'a');
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

test('ejemplo para presentar: el mismo auto sube según la disponibilidad, sólo en una agencia vacía', () => {
  const { demandExample } = require('../src/demand-example');
  const empty = openDb(':memory:');
  const [calm, filling, full] = demandExample(empty);
  assert.deepEqual([calm.pct, filling.pct, full.pct], [0, 10, 20]);
  assert.ok(calm.total < filling.total && filling.total < full.total);
  assert.equal(calm.currency, 'USD');
  assert.equal(getSetting(empty, 'country'), 'PA');
  assert.equal(getSetting(empty, 'pro_features'), '1');
  // Volver a pedirlo no duplica nada.
  const cars = empty.prepare('SELECT COUNT(*) n FROM vehicles').get().n;
  assert.deepEqual(demandExample(empty), [calm, filling, full]);
  assert.equal(empty.prepare('SELECT COUNT(*) n FROM vehicles').get().n, cars);
  // Una agencia con datos no se toca.
  const { db } = setup();
  const before = db.prepare('SELECT COUNT(*) n FROM vehicles').get().n;
  assert.throws(() => demandExample(db), /agencia vacía/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vehicles').get().n, before);
});

test('cotizador: los adicionales y el lugar de devolución cambian el precio y llegan a la reserva', async () => {
  const { demandExample } = require('../src/demand-example');
  const db = openDb(':memory:');
  ensureAdmin(db);
  const [calm] = demandExample(db);
  const server = createApp(db, { uploadsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'quoter-')) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/public/chat`;
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  try {
    const cfg = await (await fetch(`${base}/config`)).json();
    assert.equal(cfg.phone_hint, '+507 6123 4567');
    assert.ok(cfg.extras.some((x) => x.code === 'EJG'));
    const search = { pickup_at: calm.pickup_at, return_at: calm.return_at, pickup_branch: 'PTY' };
    const suv = async (extra) => (await post('/quote', { ...search, ...extra })).data.options.find((o) => o.code === 'EJS');
    const plain = await suv({});
    assert.equal(plain.high_demand, false);
    const withGps = await suv({ extras: ['EJG', 'NO-EXISTE'] });
    assert.ok(withGps.total > plain.total);
    const booked = await post('/book', { ...search, return_branch: 'PAC', extras: ['EJG'], category: 'EJS', name: 'Ana López', phone: '+507 6123 4567' });
    assert.equal(booked.status, 201);
    assert.match(booked.data.card_url, /\/tarjeta\//);
    const r = R.getReservation(db, booked.data.code);
    assert.equal(r.total, withGps.total, 'el cliente paga lo que vio');
    assert.equal(r.extras[0].name, 'GPS');
    assert.equal(r.return_branch_name, 'Oficina Ciudad de Panamá');
  } finally {
    server.close();
    db.close();
  }
});

test('whatsapp: sin conectar no manda; conectado manda la plantilla con el texto en una línea', async () => {
  const W = require('../src/whatsapp');
  const { db } = setup();
  await assert.rejects(W.send(db, '+507 6000 0000', 'Hola'), /no está conectado/);
  setSetting(db, 'wa_phone_id', '123456');
  setSetting(db, 'wa_token', 'TOKEN');
  setSetting(db, 'wa_template', 'floty_aviso');
  const real = global.fetch;
  let call;
  global.fetch = async (url, opts) => {
    call = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) };
  };
  try {
    await assert.rejects(W.send(db, '12', 'Hola'), /WhatsApp válido/);
    assert.deepEqual(await W.send(db, '+507 6000-0000', 'Hola Ana!\nContrato: https://x/1\n  Fotos: https://x/2'), { id: 'wamid.1' });
    assert.equal(call.url, 'https://graph.facebook.com/v21.0/123456/messages');
    assert.equal(call.opts.headers.Authorization, 'Bearer TOKEN');
    assert.equal(call.body.to, '50760000000');
    assert.equal(call.body.template.name, 'floty_aviso');
    assert.equal(call.body.template.components[0].parameters[0].text, 'Hola Ana! · Contrato: https://x/1 · Fotos: https://x/2');
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Template not found' } }) });
    await assert.rejects(W.send(db, '50760000000', 'Hola'), /Template not found/);
  } finally {
    global.fetch = real;
  }
});

test('links del cliente: la vista previa muestra el nombre de la agencia, no Floty', async () => {
  const title = async (server, p) => (await (await fetch(`http://127.0.0.1:${server.address().port}${p}`)).text()).match(/<title>([^<]*)<\/title>/)[1];
  const { db } = setup();
  setSetting(db, 'company_name', 'Rent <Sur> & Co');
  const one = createApp(db).listen(0);
  try {
    assert.equal(await title(one, '/firmar/abc'), 'Rent &lt;Sur&gt; &amp; Co');
    assert.equal(await title(one, '/fotos/abc'), 'Rent &lt;Sur&gt; &amp; Co');
    assert.match(await title(one, '/panel'), /Floty/, 'la app de la agencia no cambia');
  } finally {
    one.close();
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'titulo-'));
  const file = path.join(dir, 'rentacar.db');
  const platform = openPlatform(openDb(file), file);
  const b = platform.get(platform.create({ name: 'Prueba Dos', country: 'AR', admin_name: 'Beto', admin_email: 'beto@dos.test' }).company.id);
  setSetting(b.db, 'company_name', 'Autos Panamá');
  const many = createApp(platform.principal().db, { platform, uploadsDir: dir }).listen(0);
  try {
    assert.equal(await title(many, `/firmar/abc?empresa=${b.slug}`), 'Autos Panamá');
    assert.doesNotMatch(await title(many, '/firmar/abc?empresa=no-existe'), /Floty/);
  } finally {
    many.close();
  }
});

test('dominio propio: la pantalla recibe el dominio para armar los links del cliente sin la dirección de Floty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dominio-'));
  const file = path.join(dir, 'rentacar.db');
  const platform = openPlatform(openDb(file), file);
  const made = platform.create({ name: 'Ancon', country: 'PA', admin_name: 'Fer', admin_email: 'fer@ancon.test' });
  const server = createApp(platform.principal().db, { platform, uploadsDir: dir }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(made.admin) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const me = async () => (await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json()).company;
    assert.equal((await me()).domain, null);
    platform.setDomain(made.company.id, 'reservas.ancon.test');
    assert.equal((await me()).domain, 'reservas.ancon.test', 'sin reiniciar el servidor');
  } finally {
    server.close();
  }
});

test('firma: la tienen todas las agencias, también en autos para trabajo y sin las funciones en prueba', () => {
  const { seedChoferes } = require('../src/seed');
  for (const load of [seed, seedChoferes]) {
    const db = openDb(':memory:');
    ensureAdmin(db);
    load(db);
    assert.notEqual(getSetting(db, 'pro_features'), '1');
    const r = db.prepare("SELECT id FROM reservations WHERE status IN ('confirmada', 'en_curso') ORDER BY id").get();
    const s = D.requestSignature(db, r.id, TERMS, { company_name: 'X' }, null);
    assert.equal(D.viewContract(db, s.token).can_sign, true);
    D.sign(db, s.token, { name: 'Ana López', doc: '30111222', accepted: true, image: PNG }, { ip: '200.1.1.1', userAgent: 'test' });
    assert.equal(D.stateOf(db, R.getReservation(db, r.id)).name, 'Ana López');
    assert.throws(() => D.cardLink(db, r.id), /no está activada/);
    db.close();
  }
});
