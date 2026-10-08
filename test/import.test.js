'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');
const { seed } = require('../src/seed');
const { parseTable, parseDateValue, parseTime, parseFuel } = require('../src/importer');

let db;
let server;
let base;
let admin;
let operator;
let uploadsDir;

async function req(method, p, { body, cookie } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function login(email, password) {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return r.headers.get('set-cookie').split(';')[0];
}

const analyze = (kind, text, cookie = admin) => req('POST', '/api/import/analyze', { cookie, body: { kind, text } });
const run = (kind, text, mapping, options = {}, cookie = admin) => req('POST', '/api/import/run', { cookie, body: { kind, text, mapping, options } });
/** Analiza y ejecuta con el mapeo sugerido. */
async function importAuto(kind, text, options) {
  const a = await analyze(kind, text);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const r = await run(kind, text, a.data.mapping, options);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

test.before(async () => {
  db = openDb(':memory:');
  ensureAdmin(db);
  seed(db);
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
  server = createApp(db, { uploadsDir }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@rentacar.local', 'admin123');
  assert.equal((await req('POST', '/api/auth/password', { cookie: admin, body: { current: 'admin123', password: 'Ushuaia2026Segura' } })).status, 200);
  assert.equal((await req('POST', '/api/users', { cookie: admin, body: { name: 'Op', email: 'op@x.com', password: 'Inicial2026x', role: 'operador' } })).status, 201);
  operator = await login('op@x.com', 'Inicial2026x');
  assert.equal((await req('POST', '/api/auth/password', { cookie: operator, body: { current: 'Inicial2026x', password: 'Propia2026xyz' } })).status, 200);
});

test.after(() => {
  server.close();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

test('lectura de CSV: separadores, comillas, título arriba y celdas pegadas', () => {
  const t = parseTable('﻿Planilla 2025\nNombre;Domicilio;Tel\n"Pérez; Juan";"Calle 1\nPiso 2";"2901 ""44"""\n\n');
  assert.deepEqual(t.headers, ['Nombre', 'Domicilio', 'Tel']);
  assert.deepEqual(t.rows[0].cells, ['Pérez; Juan', 'Calle 1\nPiso 2', '2901 "44"']);
  assert.equal(t.rows.length, 1);
  const pasted = parseTable('Patente\tMarca\nAB123CD\tFiat\r\nAC456EF\tVW');
  assert.equal(pasted.rows.length, 2);
  assert.equal(pasted.rows[1].cells[1], 'VW');
});

test('interpreta fechas, horas y combustible en los formatos habituales', () => {
  assert.deepEqual(parseDateValue('15/01/2027'), { date: '2027-01-15', time: null });
  assert.deepEqual(parseDateValue('5-1-27 9:30'), { date: '2027-01-05', time: '09:30' });
  assert.deepEqual(parseDateValue('1/15/2027', true), { date: '2027-01-15', time: null });
  assert.deepEqual(parseDateValue('2027-01-15 10:30:00'), { date: '2027-01-15', time: '10:30' });
  assert.equal(parseDateValue('46402').date, '2027-01-15'); // número de serie de Excel
  assert.equal(parseDateValue('31/02/2027'), null);
  assert.equal(parseDateValue('mañana'), null);
  assert.equal(parseTime('10hs'), '10:00');
  assert.equal(parseTime('6:30 p. m.'), '18:30');
  assert.equal(parseTime('25:00'), null);
  assert.equal(parseFuel('3/4'), 6);
  assert.equal(parseFuel('lleno'), 8);
  assert.equal(parseFuel('50%'), 4);
});

test('sólo un administrador puede importar', async () => {
  const csv = 'Nombre,DNI\nAna,1';
  assert.equal((await analyze('clientes', csv, operator)).status, 403);
  assert.equal((await run('clientes', csv, { full_name: 0 }, {}, operator)).status, 403);
  const anon = await fetch(`${base}/api/import/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(anon.status, 401);
});

test('flota: reconoce columnas, crea, actualiza y avisa lo que no entiende', async () => {
  const csv = [
    'Dominio,Marca,Modelo,Año,Grupo,Base,Estado,Kilometraje,Nafta,Vto. seguro,VTV',
    'AA 111 BB,Fiat,Cronos,2022,compacto,Aeropuerto,disponible,"45.300",3/4,30/06/2027,15/03/2027',
    'af123bc,Fiat,Mobi,2021,A,,en taller,61000,lleno,,',
    'AC 222 DD,Toyota,Hilux,1800,camion gigante,Marte,???,abc,,99/99/2027,',
    ',Ford,Ka,2015,A,,,,,,',
  ].join('\n');
  const a = await analyze('flota', csv);
  assert.equal(a.status, 200);
  assert.equal(a.data.total_rows, 4);
  const m = a.data.mapping;
  assert.equal(m.plate, 0);
  assert.equal(m.year, 3);
  assert.equal(m.category, 4);
  assert.equal(m.insurance_expiry, 9);
  assert.equal(m.vtv_expiry, 10);

  const test1 = await run('flota', csv, m, { dry_run: true });
  assert.equal(test1.data.dry_run, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM vehicles WHERE plate LIKE 'AA%'").get().n, 0, 'la prueba no guarda nada');

  const r = (await run('flota', csv, m, { mode: 'completar' })).data;
  assert.deepEqual([r.counts.creado, r.counts.actualizado + r.counts.sin_cambios, r.counts.error], [1, 1, 2]);
  const v = db.prepare("SELECT * FROM vehicles WHERE plate = 'AA 111 BB'").get();
  assert.equal(v.km, 45300);
  assert.equal(v.fuel, 6);
  assert.equal(v.category_id, 2);
  assert.equal(v.insurance_expiry, '2027-06-30');
  assert.equal(db.prepare('SELECT name FROM branches WHERE id = ?').get(v.branch_id).name, 'Aeropuerto Ushuaia');
  // AF123BC ya existía: en modo "completar" no se pisa el estado ni el km.
  const old = db.prepare("SELECT * FROM vehicles WHERE plate = 'AF123BC'").get();
  assert.equal(old.status, 'disponible');
  const rowCat = r.rows.find((x) => x.line === 4);
  assert.equal(rowCat.action, 'error');
  assert.match(rowCat.messages[0], /Categoría desconocida/);
  assert.match(r.rows.find((x) => x.line === 5).messages[0], /patente/);

  // Con categoría por defecto, la fila rara entra con avisos.
  const r2 = (await run('flota', csv, m, { default_category_id: 5 })).data;
  const odd = r2.rows.find((x) => x.line === 4);
  assert.equal(odd.action, 'creado');
  const text = odd.messages.join(' | ');
  for (const w of ['Sucursal "Marte"', 'Estado "???"', 'Año no válido', 'Kilometraje no válido', 'Fecha no reconocida']) assert.ok(text.includes(w), `${w} en ${text}`);
  // Re-importar no duplica.
  assert.equal(r2.counts.creado, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM vehicles WHERE plate = 'AA 111 BB'").get().n, 1);

  // "Reemplazar" sí pisa los datos.
  const r3 = (await run('flota', csv, m, { mode: 'reemplazar', default_category_id: 5 })).data;
  assert.ok(r3.counts.actualizado >= 1);
  assert.equal(db.prepare("SELECT status FROM vehicles WHERE plate = 'AF123BC'").get().status, 'mantenimiento');

  const audit = db.prepare("SELECT detail FROM audit_log WHERE action = 'importacion' ORDER BY id DESC").get();
  assert.match(audit.detail, /^flota: 4 filas/);
  assert.ok(!/Cronos|AA 111/.test(audit.detail), 'el registro de actividad no guarda los datos importados');
});

test('clientes: nombre y apellido separados, duplicados por documento/email y nadie se mezcla', async () => {
  const csv = [
    'Nombre,Apellido,DNI,Mail,Celular,Venc. licencia,Nacionalidad',
    'Julián,Ferraro,33.444.555,julian@x.com,+54 9 2901 445566,15/1/27,Argentina',
    'Julián,Ferraro,40.999.888,otro@x.com,,,Chile',
    'María,Gómez,,MARIA@X.COM,,,',
    'Luis,Díaz,25111222,no-es-mail,,32/13/2027,',
    ',,,,,,',
  ].join('\n');
  const r = await importAuto('clientes', csv);
  assert.equal(r.total, 4);
  assert.equal(r.counts.creado, 4, JSON.stringify(r.rows));
  const jf = db.prepare("SELECT * FROM customers WHERE doc_number = '33.444.555'").get();
  assert.equal(jf.full_name, 'Julián Ferraro');
  assert.equal(jf.license_expiry, '2027-01-15');
  assert.equal(jf.notes, 'Nacionalidad: Argentina');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM customers WHERE full_name = 'Julián Ferraro'").get().n, 2, 'mismo nombre con distinto DNI son dos personas');
  assert.equal(db.prepare("SELECT email FROM customers WHERE full_name = 'María Gómez'").get().email, 'maria@x.com');
  const luis = r.rows.find((x) => x.label === 'Luis Díaz');
  assert.ok(luis.messages.some((m) => /Email no válido/.test(m)));
  assert.ok(luis.messages.some((m) => /Fecha no reconocida/.test(m)));

  // Segunda pasada con datos nuevos: se completan, no se duplican.
  const again = await importAuto('clientes', 'Documento,Nombre,Domicilio\n33444555,Julián Ferraro,San Martín 100\n');
  assert.equal(again.counts.actualizado, 1);
  assert.equal(db.prepare("SELECT address FROM customers WHERE id = ?").get(jf.id).address, 'San Martín 100');
  const same = await importAuto('clientes', 'Documento,Nombre,Domicilio\n33444555,Julián Ferraro,San Martín 100\n');
  assert.equal(same.counts.sin_cambios, 1);
});

test('reservas: fechas, horas, clientes, autos, estados, pagos y sin duplicar', async () => {
  const csv = [
    'Nro reserva\tCliente\tDNI\tFecha entrega\tHora entrega\tFecha devolución\tHora devolución\tLugar de entrega\tPatente\tEstado\tTotal\tSeña',
    `V-1\tJulián Ferraro\t33444555\t10/01/2030\t10hs\t15/01/2030\t18:00\tAeropuerto\tAA 111 BB\tconfirmada\t$ 350.000\t100.000`,
    `V-2\tCliente Nuevo\t\t20/01/2030\t\t25/01/2030\t\tCentro\t\tpendiente\t\t`,
    `V-3\tMaría Gómez\t\t01/03/2020\t09:00\t05/03/2020\t09:00\t\tAF456DE\tdevuelto\t200000\t200000`,
    `V-4\tJulián Ferraro\t33444555\t12/01/2030\t10:00\t14/01/2030\t10:00\t\tAA 111 BB\tconfirmada\t1000\t`,
    `V-5\tSin Fechas\t\t\t\t\t\t\t\t\t\t`,
    `V-6\tAlguien\t\t10/02/2030\t\t05/02/2030\t\t\tAG789FG\t\t\t`,
  ].join('\n');
  const a = await analyze('reservas', csv);
  const m = a.data.mapping;
  assert.equal(m.external_id, 0);
  assert.equal(m.pickup_date, 3);
  assert.equal(m.pickup_time, 4);
  assert.equal(m.return_date, 5);
  assert.equal(m.return_time, 6);
  assert.equal(m.pickup_branch, 7);
  assert.equal(m.plate, 8);
  assert.equal(m.paid, 11);
  assert.equal(m.total, 10);

  // Sin categoría: la fila V-2 (sin patente ni categoría) da error salvo que haya una por defecto.
  const r = (await run('reservas', csv, m, { default_category_id: 1 })).data;
  const by = (n) => r.rows.find((x) => x.line === n);
  assert.equal(by(2).action, 'creado');
  const v1 = db.prepare("SELECT * FROM reservations WHERE external_id = 'V-1'").get();
  assert.equal(v1.pickup_at, '2030-01-10T10:00');
  assert.equal(v1.return_at, '2030-01-15T18:00');
  assert.equal(v1.status, 'confirmada');
  assert.equal(v1.source, 'importado');
  assert.equal(v1.total, 350000);
  assert.equal(v1.category_id, 2); // la del auto
  assert.equal(db.prepare('SELECT doc_number FROM customers WHERE id = ?').get(v1.customer_id).doc_number, '33.444.555', 'usa el cliente ya cargado');
  assert.equal(db.prepare('SELECT SUM(amount) s FROM payments WHERE reservation_id = ?').get(v1.id).s, 100000);

  const v2 = db.prepare("SELECT * FROM reservations WHERE external_id = 'V-2'").get();
  assert.equal(v2.status, 'pendiente');
  assert.equal(v2.pickup_at, '2030-01-20T10:00');
  assert.ok(v2.total > 0, 'sin total se calcula con la tarifa');
  assert.ok(by(3).messages.some((x) => /Cliente nuevo/.test(x)));

  const v3 = db.prepare("SELECT * FROM reservations WHERE external_id = 'V-3'").get();
  assert.equal(v3.status, 'finalizada');

  // V-4 pisa las fechas de V-1 con el mismo auto: entra sin auto y con aviso.
  const v4 = db.prepare("SELECT * FROM reservations WHERE external_id = 'V-4'").get();
  assert.equal(v4.vehicle_id, null);
  assert.ok(by(5).messages.some((x) => /ya está ocupado/.test(x)));

  assert.equal(by(6).action, 'error');
  assert.match(by(6).messages[0], /Falta la fecha de entrega/);
  assert.equal(by(7).action, 'error');
  assert.match(by(7).messages[0], /anterior/);

  const log = db.prepare("SELECT action FROM reservation_log WHERE reservation_id = ?").all(v1.id).map((x) => x.action);
  assert.deepEqual(log, ['importada']);

  // Volver a importar el mismo archivo no duplica nada.
  const again = (await run('reservas', csv, m, { default_category_id: 1 })).data;
  assert.equal(again.counts.creado, 0);
  assert.equal(again.counts.omitido, 4);

  // Las reservas importadas aparecen en la API como cualquier otra.
  const list = await req('GET', '/api/reservations?q=V-1', { cookie: admin });
  assert.equal(list.status, 200);
});

test('reservas: un alquiler en curso abre el contrato y se puede devolver desde la app', async () => {
  const csv = 'Reserva,Cliente,DNI,Licencia,Desde,Hasta,Patente,Estado,Total\nC-1,Ana Ruiz,20111333,X1,01/01/2020 10:00,01/01/2040 10:00,AG222PQ,entregado,500000\n';
  const r = await importAuto('reservas', csv);
  assert.equal(r.counts.creado, 1, JSON.stringify(r.rows));
  const res = db.prepare("SELECT * FROM reservations WHERE external_id = 'C-1'").get();
  assert.equal(res.status, 'en_curso');
  assert.equal(db.prepare('SELECT status FROM vehicles WHERE id = ?').get(res.vehicle_id).status, 'alquilado');
  const c = db.prepare('SELECT * FROM contracts WHERE reservation_id = ?').get(res.id);
  assert.ok(c && c.number.startsWith('C-'));
  const km = c.out_km + 100;
  const back = await req('POST', `/api/reservations/${res.id}/checkin`, { cookie: admin, body: { in_km: km, in_fuel: 8, in_at: '2020-01-02T10:00' } });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.status, 'finalizada');
});

test('rechaza archivos vacíos, enormes, tipos desconocidos y mapeos raros', async () => {
  assert.equal((await analyze('clientes', '')).status, 400);
  assert.equal((await analyze('clientes', 'Nombre,DNI\n')).status, 400);
  assert.equal((await analyze('usuarios', 'a,b\n1,2')).status, 400);
  const many = `Nombre,DNI\n${'Ana,1\n'.repeat(5001)}`;
  assert.equal((await analyze('clientes', many)).status, 413);
  assert.equal((await run('clientes', 'Nombre,DNI\nAna,1', ['x'])).status, 400);
  assert.equal((await run('clientes', 'Nombre,DNI\nAna,1', {})).status, 400, 'falta el nombre');
  // Un índice de columna inexistente o un "__proto__" no rompen nada.
  const weird = await run('clientes', 'Nombre,DNI\nAna Weird,99\n', { full_name: 0, doc_number: 99, __proto__: 1 });
  assert.equal(weird.status, 200);
  assert.equal(weird.data.counts.creado, 1);
  // Contenido HTML se guarda como texto (la pantalla siempre lo escapa).
  const html = await run('clientes', 'Nombre\n<img src=x onerror=alert(1)>\n', { full_name: 0 });
  assert.equal(html.data.counts.creado, 1);
  assert.equal((await req('GET', '/api/health')).status, 200);
});

test('acepta planillas grandes (más de 1 MB) sólo con sesión de administrador', async () => {
  const row = `Cliente Grande,${'x'.repeat(400)}\n`;
  const big = `Nombre,Observaciones\n${row.repeat(4000)}`;
  assert.ok(big.length > 1_500_000);
  const a = await analyze('clientes', big);
  assert.equal(a.status, 200, JSON.stringify(a.data).slice(0, 200));
  assert.equal(a.data.total_rows, 4000);
  const anon = await fetch(`${base}/api/import/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'clientes', text: big }) });
  assert.equal(anon.status, 401);
  // Las demás rutas siguen con el límite chico.
  const other = await req('POST', '/api/customers', { cookie: admin, body: { full_name: 'x', notes: 'y'.repeat(1_200_000) } });
  assert.equal(other.status, 413);
});
