'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, getSetting, setSetting } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { seed } = require('../src/seed');
const { rentalDays } = require('../src/pricing');

let server;
let base;
let db;
let token; // cookie de sesión ("rc_session=...")
const ADMIN_PASSWORD = 'Ushuaia2026Segura';
let apiKey;

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Cookie: token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

/** Inicia sesión y devuelve la cookie de sesión. */
async function loginAs(email, password) {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const data = await res.json();
  if (res.status !== 200) return { status: res.status, data };
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { status: 200, data, cookie, raw: res.headers.get('set-cookie') };
}

test.before(async () => {
  db = openDb(':memory:');
  ensureAdmin(db);
  seed(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // El administrador de fábrica tiene que cambiar la contraseña antes de usar la app.
  const first = await loginAs('admin@rentacar.local', 'admin123');
  assert.equal(first.status, 200);
  assert.equal(first.data.must_change_password, true);
  token = first.cookie;
  assert.equal((await call('GET', '/api/reservations')).status, 403);
  assert.equal((await call('POST', '/api/auth/password', { current: 'admin123', password: ADMIN_PASSWORD })).status, 200);
  apiKey = getSetting(db, 'api_key');
});

test.after(() => server.close());

test('días de alquiler con tolerancia', () => {
  assert.equal(rentalDays('2027-01-01T10:00', '2027-01-04T10:00', 2), 3);
  assert.equal(rentalDays('2027-01-01T10:00', '2027-01-04T11:30', 2), 3);
  assert.equal(rentalDays('2027-01-01T10:00', '2027-01-04T13:00', 2), 4);
  assert.equal(rentalDays('2027-01-01T10:00', '2027-01-01T15:00', 2), 1);
});

test('rutas internas requieren sesión', async () => {
  const saved = token;
  token = null;
  const r = await call('GET', '/api/dashboard');
  token = saved;
  assert.equal(r.status, 401);
});

test('cotización: tarifa semanal, temporada y adicionales con tope', async () => {
  const cats = (await call('GET', '/api/categories')).data;
  const a = cats.find((c) => c.code === 'A');
  // Fuera de temporada, 7 días => tarifa semanal 210000 (IVA incluido)
  const q = await call('POST', '/api/quote', { category_id: a.id, pickup_at: '2027-04-05T10:00', return_at: '2027-04-12T10:00', extras: [{ extra_id: 1 }] });
  assert.equal(q.status, 200);
  assert.equal(q.data.days, 7);
  assert.equal(q.data.base, 210000);
  assert.equal(q.data.extras[0].amount, 35000); // GPS 5000 x 7 = 35000 (tope 35000)
  assert.equal(q.data.total, 245000);
  // En temporada alta (+30%)
  const y = new Date().getFullYear();
  const s = await call('POST', '/api/quote', { category_id: a.id, pickup_at: `${y}-12-20T10:00`, return_at: `${y}-12-22T10:00` });
  assert.equal(s.data.season_extra, 21000);
  assert.equal(s.data.total, 91000);
});

test('flujo completo: reserva, entrega, devolución con cargos y pagos', async () => {
  const cats = (await call('GET', '/api/categories')).data;
  const b = cats.find((c) => c.code === 'B'); // 300 km/día incluidos, 300 por km extra
  const cust = await call('POST', '/api/customers', { full_name: 'Test Flujo', doc_number: '1', license_number: 'L1', license_expiry: '2035-01-01' });
  const created = await call('POST', '/api/reservations', {
    customer_id: cust.data.id,
    category_id: b.id,
    pickup_branch_id: 1,
    return_branch_id: 1,
    pickup_at: '2027-05-03T10:00',
    return_at: '2027-05-05T10:00',
    status: 'confirmada',
    source: 'cotizador', // ignorado: las reservas de mostrador son "manual"
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const r = created.data;
  assert.equal(r.source, 'manual');
  assert.equal(r.days, 2);
  assert.equal(r.total, 84000);

  const vehicles = (await call('GET', `/api/reservations/${r.id}/available-vehicles`)).data;
  const v = vehicles.find((x) => x.status === 'disponible');
  assert.ok(v);
  const out = await call('POST', `/api/reservations/${r.id}/checkout`, { vehicle_id: v.id, out_km: v.km, out_fuel: 8, out_at: '2027-05-03T10:00' });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.status, 'en_curso');
  assert.match(out.data.contract.number, /^C-\d{4}-\d{5}$/);

  // El mismo auto no puede reservarse en fechas solapadas
  const clash = await call('POST', '/api/reservations', {
    customer_id: cust.data.id,
    category_id: b.id,
    vehicle_id: v.id,
    pickup_at: '2027-05-04T10:00',
    return_at: '2027-05-06T10:00',
  });
  assert.equal(clash.status, 409);

  setSetting(db, 'fuel_charge_per_eighth', '5000');
  // 700 km (100 de excedente), 2/8 menos de combustible, un día de demora y 10000 de daños.
  const back = await call('POST', `/api/reservations/${r.id}/checkin`, {
    in_km: v.km + 700,
    in_fuel: 6,
    in_at: '2027-05-06T10:00',
    damage_charge: 10000,
  });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  const charges = back.data.contract.charges;
  assert.equal(charges.km_driven, 700);
  const byConcept = Object.fromEntries(charges.lines.map((l) => [l.concept.split(' (')[0], l.amount]));
  assert.equal(byConcept['Km excedentes'], 30000);
  assert.equal(byConcept['Combustible faltante'], 10000);
  assert.equal(byConcept['Días adicionales por demora'], 42000);
  assert.equal(byConcept['Daños'], 10000);
  assert.equal(back.data.contract.final_total, 84000 + 92000);
  assert.equal(back.data.status, 'finalizada');

  const veh = (await call('GET', `/api/vehicles/${v.id}`)).data;
  assert.equal(veh.status, 'disponible');
  assert.equal(veh.km, v.km + 700);

  const paid = await call('POST', `/api/reservations/${r.id}/payments`, { amount: 176000, method: 'tarjeta' });
  assert.equal(paid.data.balance.pending, 0);
});

test('no se entrega sin licencia del cliente', async () => {
  const cust = await call('POST', '/api/customers', { full_name: 'Sin Licencia' });
  const r = await call('POST', '/api/reservations', { customer_id: cust.data.id, category_id: 1, pickup_at: '2027-06-01T10:00', return_at: '2027-06-02T10:00' });
  const v = (await call('GET', `/api/reservations/${r.data.id}/available-vehicles`)).data[0];
  const out = await call('POST', `/api/reservations/${r.data.id}/checkout`, { vehicle_id: v.id });
  assert.equal(out.status, 400);
  assert.match(out.data.error, /licencia/i);
});

test('sin cupo en la categoría devuelve 409', async () => {
  const cats = (await call('GET', '/api/categories')).data;
  const p = cats.find((c) => c.code === 'P'); // la única pick-up está en taller
  const cust = await call('POST', '/api/customers', { full_name: 'Cupo' });
  const r = await call('POST', '/api/reservations', { customer_id: cust.data.id, category_id: p.id, pickup_at: '2027-06-01T10:00', return_at: '2027-06-03T10:00' });
  assert.equal(r.status, 409);
});

test('API del cotizador: API key, disponibilidad y reserva idempotente', async () => {
  const noKey = await call('GET', '/api/public/v1/catalog');
  assert.equal(noKey.status, 401);

  const h = { 'X-API-Key': apiKey };
  const av = await call('GET', '/api/public/v1/availability?pickup_at=2027-03-01T10:00&return_at=2027-03-04T10:00&pickup_branch=USH', undefined, h);
  assert.equal(av.status, 200);
  assert.ok(av.data.find((c) => c.category_code === 'D').available >= 1);

  const body = {
    id: 'COT-77',
    customer: { full_name: 'Cliente Cotizador', doc_number: '99887766', email: 'cc@example.com' },
    category_code: 'D',
    pickup_at: '2027-03-01T10:00',
    return_at: '2027-03-04T10:00',
    pickup_branch: 'USH',
    extras: ['GPS', 'CAD'],
    total: 250000,
  };
  const first = await call('POST', '/api/public/v1/reservations', body, h);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.reservation.total, 250000); // respeta el precio del cotizador
  assert.equal(first.data.reservation.source, 'cotizador');
  const again = await call('POST', '/api/public/v1/reservations', body, h);
  assert.equal(again.status, 200);
  assert.equal(again.data.duplicated, true);
  assert.equal(again.data.reservation.code, first.data.reservation.code);

  const byExternal = await call('GET', '/api/public/v1/reservations/COT-77', undefined, h);
  assert.equal(byExternal.data.code, first.data.reservation.code);
  const cancel = await call('POST', '/api/public/v1/reservations/COT-77/cancel', {}, h);
  assert.equal(cancel.data.status, 'cancelada');
});

test('webhook con formato propio del cotizador usando mapeo', async () => {
  await call('PUT', '/api/integration', {
    mapping: {
      external_id: 'cotizacion.numero',
      'customer.full_name': 'cliente.nombre',
      'customer.email': 'cliente.mail',
      category_code: 'auto.grupo',
      pickup_at: 'retiro.fecha',
      return_at: 'devolucion.fecha',
      pickup_branch: 'retiro.lugar',
      total: 'importe',
    },
  });
  const payload = {
    cotizacion: { numero: 5001 },
    cliente: { nombre: 'Pedro Mapeado', mail: 'pedro@example.com' },
    auto: { grupo: 'camioneta' }, // alias de la categoría D
    retiro: { fecha: '10/03/2027 09:00', lugar: 'aeropuerto' }, // alias de USH
    devolucion: { fecha: '12/03/2027 09:00' },
    importe: '$ 150.000',
  };
  const r = await call('POST', '/api/public/v1/quotes/inbound', payload, { 'X-API-Key': apiKey });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.reservation.category.code, 'D');
  assert.equal(r.data.reservation.pickup.branch, 'Aeropuerto Ushuaia');
  assert.equal(r.data.reservation.total, 150000);

  const bad = await call('POST', '/api/public/v1/quotes/inbound', { ...payload, cotizacion: { numero: 5002 }, auto: { grupo: 'NAVE' } }, { 'X-API-Key': apiKey });
  assert.equal(bad.status, 422);
  const inbox = (await call('GET', '/api/integration')).data.inbox;
  assert.equal(inbox[0].status, 'error');
});

test('formulario web: fecha y hora separadas, alias, origen y anti-spam', async () => {
  const form = new URLSearchParams({
    nombre: 'Laura Web',
    email: 'laura@example.com',
    telefono: '+54 9 2901 111111',
    vehiculo: 'Económico',
    fecha_retiro: '20/04/2027',
    hora_retiro: '11:00',
    fecha_devolucion: '23/04/2027',
    hora_devolucion: '11:00',
    lugar_retiro: 'Oficina',
    lugar_devolucion: 'Aeropuerto',
    comentarios: 'Viajo con un bebé',
  });
  const post = (body, origin = 'https://www.discoverushuaia.com.ar') =>
    fetch(`${base}/api/public/webform`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Origin: origin, 'X-Requested-With': 'fetch' },
      body,
    }).then(async (res) => ({ status: res.status, data: await res.json() }));

  const ok = await post(form);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const list = (await call('GET', '/api/reservations?source=web')).data;
  const r = (await call('GET', `/api/reservations/${list[0].id}`)).data;
  assert.equal(r.code, ok.data.code);
  assert.equal(r.status, 'pendiente');
  assert.equal(r.pickup_at, '2027-04-20T11:00');
  assert.equal(r.category_code, 'A');
  assert.equal(r.pickup_branch_name, 'Oficina Centro');
  assert.equal(r.return_branch_name, 'Aeropuerto Ushuaia');
  assert.ok(r.pricing.one_way_fee >= 0);
  assert.match(r.notes, /Formulario web/);

  const evil = await post(form, 'https://otro-sitio.com');
  assert.equal(evil.status, 403);

  const before = (await call('GET', '/api/reservations?source=web&status=all')).data.length;
  const spam = new URLSearchParams(form);
  spam.set('_gotcha', 'soy un bot');
  const s = await post(spam);
  assert.equal(s.status, 200);
  const after = (await call('GET', '/api/reservations?source=web&status=all')).data.length;
  assert.equal(after, before);
});

test('operador no puede modificar tarifas', async () => {
  assert.equal((await call('POST', '/api/users', { name: 'Op', email: 'op@x.com', password: 'Inicial2026x', role: 'operador' })).status, 201);
  const saved = token;
  token = (await loginAs('op@x.com', 'Inicial2026x')).cookie;
  assert.equal((await call('POST', '/api/auth/password', { current: 'Inicial2026x', password: 'Operador2026x' })).status, 200);
  const r = await call('PUT', '/api/categories/1', { daily_rate: 1 });
  const integ = await call('GET', '/api/integration');
  const res = await call('GET', '/api/reservations');
  token = saved;
  assert.equal(r.status, 403);
  assert.equal(integ.status, 403);
  assert.equal(res.status, 200);
});

test('mantenimiento abierto saca el vehículo de la flota y al cerrarlo vuelve', async () => {
  const v = (await call('GET', '/api/vehicles')).data.find((x) => x.status === 'disponible');
  const m = await call('POST', '/api/maintenance', { vehicle_id: v.id, kind: 'service', status: 'abierto', start_date: '2027-01-01' });
  assert.equal((await call('GET', `/api/vehicles/${v.id}`)).data.status, 'mantenimiento');
  await call('PUT', `/api/maintenance/${m.data.id}`, { status: 'cerrado' });
  assert.equal((await call('GET', `/api/vehicles/${v.id}`)).data.status, 'disponible');
});

test('devolución anticipada no genera cargos por demora', async () => {
  const cust = await call('POST', '/api/customers', { full_name: 'Anticipado', license_number: 'L9' });
  const r = await call('POST', '/api/reservations', { customer_id: cust.data.id, category_id: 3, pickup_at: '2027-08-10T10:00', return_at: '2027-08-15T10:00' });
  const v = (await call('GET', `/api/reservations/${r.data.id}/available-vehicles`)).data.find((x) => x.status === 'disponible');
  await call('POST', `/api/reservations/${r.data.id}/checkout`, { vehicle_id: v.id, out_at: '2027-08-09T18:00' });
  const back = await call('POST', `/api/reservations/${r.data.id}/checkin`, { in_km: v.km + 10, in_fuel: 8, in_at: '2027-08-09T20:00' });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.contract.charges.lines.length, 0);
});

test('formulario web: reconoce campos con otros nombres sin configurar el mapeo', async () => {
  const { autoDetect, parseAmount } = require('../src/integration');

  // Estilo 1: nombres en inglés / camelCase
  const a = autoDetect(
    { fullName: 'Ana Smith', yourEmail: 'ana@x.com', phoneNumber: '123', carType: 'SUV', pickupDate: '2027-02-01', pickupTime: '09:30', dropoffDate: '2027-02-05', dropoffTime: '18:00', pickupLocation: 'Airport', message: 'hola' },
    { customer: {} },
  );
  assert.equal(a.customer.full_name, 'Ana Smith');
  assert.equal(a.customer.email, 'ana@x.com');
  assert.equal(a.customer.phone, '123');
  assert.equal(a.category_code, 'SUV');
  assert.equal(a.pickup_at, '2027-02-01');
  assert.equal(a.pickup_time, '09:30');
  assert.equal(a.return_at, '2027-02-05');
  assert.equal(a.return_time, '18:00');
  assert.equal(a.pickup_branch, 'Airport');
  assert.equal(a.notes, 'hola');

  // Estilo 2: nombre y apellido separados, fechas "desde/hasta", fecha de nacimiento que no debe confundirse
  const b = autoDetect(
    { 'Nombre': 'Juan', 'Apellido': 'Pérez', 'E-mail': 'j@x.com', 'Celular / WhatsApp': '999', 'Fecha de nacimiento': '01/01/1990', 'Desde': '10/03/2027', 'Hasta': '15/03/2027', 'Vehículo': 'Pick-up' },
    { customer: {} },
  );
  assert.equal(b.customer.full_name, 'Juan Pérez');
  assert.equal(b.customer.phone, '999');
  assert.equal(b.pickup_at, '10/03/2027');
  assert.equal(b.return_at, '15/03/2027');
  assert.equal(b.category_code, 'Pick-up');

  // Estilo 3: campos sin nombres claros: las dos primeras fechas son retiro y devolución
  const c = autoDetect({ campo1: 'Luis', campo2: '20/05/2027', campo3: '22/05/2027' }, { customer: {} });
  assert.equal(c.pickup_at, '20/05/2027');
  assert.equal(c.return_at, '22/05/2027');

  // Importes en formato argentino e internacional
  assert.equal(parseAmount('$ 150.000'), 150000);
  assert.equal(parseAmount('150.000,50'), 150000.5);
  assert.equal(parseAmount('150,000.50'), 150000.5);
  assert.equal(parseAmount('1234.5'), 1234.5);
  assert.equal(parseAmount(98000), 98000);
});

test('formulario web con nombres de campo distintos crea la reserva igual', async () => {
  const body = new URLSearchParams({
    nombre_y_apellido: 'Sofía Distinta',
    correo: 'sofia@example.com',
    whatsapp: '+54 9 2901 222222',
    tipo_de_vehiculo: 'Compacto',
    fecha_desde: '05-06-2027',
    hora_desde: '8 hs',
    fecha_hasta: '08-06-2027',
    hora_hasta: '20:00',
    lugar_de_entrega: 'Aeropuerto',
    adicionales: 'GPS, Portaequipaje',
  });
  const res = await fetch(`${base}/api/public/webform`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'X-Requested-With': 'fetch', Origin: 'https://www.discoverushuaia.com.ar' },
    body,
  });
  const data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  const list = (await call('GET', `/api/reservations?q=${encodeURIComponent(data.code)}`)).data;
  const r = (await call('GET', `/api/reservations/${list[0].id}`)).data;
  assert.equal(r.customer_name, 'Sofía Distinta');
  assert.equal(r.category_code, 'B');
  assert.equal(r.pickup_at, '2027-06-05T08:00');
  assert.equal(r.return_at, '2027-06-08T20:00');
  assert.equal(r.pickup_branch_name, 'Aeropuerto Ushuaia');
  assert.deepEqual(r.extras.map((x) => x.name), ['GPS']);
  assert.match(r.notes, /Portaequipaje/);
});

test('fotos de entrega y devolución: subir, listar, ver y borrar', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fotos-'));
  const app2 = createApp(db, { uploadsDir: dir }).listen(0);
  await new Promise((r) => app2.once('listening', r));
  const b2 = `http://127.0.0.1:${app2.address().port}`;
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b40000000049454e44ae426082', 'hex');
    const up = (body, type, extra = '') =>
      fetch(`${b2}/api/reservations/1/files?stage=entrega&name=frente.png${extra}`, { method: 'POST', headers: { 'Content-Type': type, Cookie: token }, body });

    const ok = await up(png, 'image/png');
    assert.equal(ok.status, 201);
    const f = await ok.json();
    assert.equal(f.stage, 'entrega');
    assert.equal(f.size, png.length);

    assert.equal((await up(Buffer.from('hola'), 'text/plain')).status, 415);
    const noAuth = await fetch(`${b2}/api/reservations/1/files`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
    assert.equal(noAuth.status, 401);

    const r = (await call('GET', '/api/reservations/1')).data;
    assert.ok(r.files.some((x) => x.id === f.id && x.name === 'frente.png'));
    assert.ok(r.log.some((l) => l.action === 'archivo_subido'));

    const got = await fetch(`${b2}/api/files/${f.id}`, { headers: { Cookie: token } });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);

    const del = await fetch(`${b2}/api/files/${f.id}`, { method: 'DELETE', headers: { Cookie: token } });
    assert.equal(del.status, 204);
    assert.equal(fs.readdirSync(path.join(dir, '1')).length, 0);
  } finally {
    app2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
