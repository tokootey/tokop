'use strict';

/* Pedidos de Ancon del 20/11: todos van solo con las funciones en prueba; apagadas, nada cambia. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, at } = require('./etapa2-helper');
const { setSetting } = require('../src/db');

const pro = (app) => setSetting(app.db, 'pro_features', '1');

test('auxiliar y taller: manda un auto al taller y lo saca, sin cargar costos', async () => {
  const app = await start();
  try {
    const aux = await app.as('auxiliar');
    const send = () => aux('POST', '/api/maintenance', { vehicle_id: 3, kind: 'service', description: 'Ruido en el tren delantero', start_date: at(0).slice(0, 10), status: 'abierto', cost: 500 });
    assert.equal((await send()).status, 403);
    pro(app);
    const job = await send();
    assert.equal(job.status, 201);
    assert.deepEqual({ ...app.db.prepare('SELECT m.cost, v.status FROM maintenance m JOIN vehicles v ON v.id = m.vehicle_id WHERE m.id = ?').get(job.data.id) }, { cost: 0, status: 'mantenimiento' });
    assert.equal((await aux('PUT', `/api/maintenance/${job.data.id}`, { status: 'cerrado', end_date: at(0).slice(0, 10), cost: 900 })).status, 200);
    assert.deepEqual({ ...app.db.prepare('SELECT m.cost, m.status AS job, v.status FROM maintenance m JOIN vehicles v ON v.id = m.vehicle_id WHERE m.id = ?').get(job.data.id) }, { cost: 0, job: 'cerrado', status: 'disponible' });
    // Lo demás sigue cerrado para el auxiliar.
    assert.equal((await aux('DELETE', `/api/maintenance/${job.data.id}`)).status, 403);
  } finally {
    app.close();
  }
});

test('historial del auto: cada traslado entre sucursales queda anotado con quién lo hizo', async () => {
  const app = await start();
  try {
    const aux = await app.as('auxiliar');
    const admin = await app.as('admin');
    await aux('PUT', '/api/vehicles/3', { km: 3100 }); // cargar km no es un traslado
    await aux('PUT', '/api/vehicles/3', { branch_id: 2 });
    const moves = (await admin('GET', '/api/vehicles/3/moves')).data;
    assert.deepEqual(moves.map((m) => [m.from_name, m.to_name, m.user_name]), [['Tocumen', 'Centro', 'auxiliar']]);
  } finally {
    app.close();
  }
});

test('devolución sin fotos: sólo si el contrato queda pendiente, y para cerrarlo se piden', async () => {
  const app = await start();
  try {
    const call = await app.as('operador');
    pro(app);
    const r = app.rent();
    app.db.prepare("DELETE FROM reservation_files WHERE reservation_id = ? AND stage = 'devolucion'").run(r.id);
    const back = (body) => call('POST', `/api/reservations/${r.id}/checkin`, { in_km: 1100, in_fuel: 8, in_at: at(3, 8), ...body });
    assert.match((await back()).data.error, /fotos/);
    const entered = await back({ pending_note: 'Daños por definir' });
    assert.deepEqual([entered.status, entered.data.contract.closed_at, app.db.prepare('SELECT status FROM vehicles WHERE id = 1').get().status], [200, null, 'disponible']);
    const close = () => call('POST', `/api/reservations/${r.id}/close-contract`);
    assert.match((await close()).data.error, /fotos/);
    await call('POST', `/api/reservations/${r.id}/payments`, { kind: 'pago', amount: entered.data.balance.pending });
    app.db.prepare("INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path) VALUES (?, 'devolucion', 'f.jpg', 'image/jpeg', 1, 'x')").run(r.id);
    assert.equal((await close()).status, 200);
  } finally {
    app.close();
  }
});

test('combustible: por cuartos enteros, o el importe acordado', async () => {
  const app = await start();
  try {
    const call = await app.as('operador');
    setSetting(app.db, 'fuel_charge_per_eighth', '7.5');
    const r = app.rent();
    const fuel = async (body) => (await call('POST', `/api/reservations/${r.id}/checkin-preview`, { in_km: 1100, in_at: at(3, 8), ...body })).data.lines.filter((l) => /Combustible/.test(l.concept)).map((l) => [l.concept, l.amount]);
    // Apagado: por octavos, como siempre.
    assert.deepEqual(await fuel({ in_fuel: 5 }), [['Combustible faltante (3/8)', 22.5]]);
    pro(app);
    assert.deepEqual(await fuel({ in_fuel: 5 }), [['Combustible faltante (2/4)', 30]]);
    assert.deepEqual(await fuel({ in_fuel: 7 }), [['Combustible faltante (1/4)', 15]]);
    assert.deepEqual(await fuel({ in_fuel: 5, fuel_amount: 20 }), [['Combustible (importe acordado)', 20]]);
    assert.deepEqual(await fuel({ in_fuel: 5, fuel_amount: 0 }), []);
  } finally {
    app.close();
  }
});

test('clientes: no se repite el documento, y los repetidos de antes se siguen pudiendo editar', async () => {
  const app = await start();
  try {
    const call = await app.as('operador');
    const add = (body) => call('POST', '/api/customers', { full_name: 'Ana Ruiz', ...body });
    const first = (await add({ doc_number: '8-888-888' })).data;
    assert.equal((await add({ doc_number: '8-888-888' })).status, 201); // apagado: como siempre
    pro(app);
    const dup = await add({ doc_number: '8-888-888' });
    assert.equal(dup.status, 409);
    assert.match(dup.data.error, /Ana Ruiz/);
    assert.equal((await add({ phone: '+507 6000 1111' })).status, 201); // sin documento se puede cargar
    assert.equal((await call('PUT', `/api/customers/${first.id}`, { full_name: 'Ana Ruiz Díaz', doc_number: '8-888-888' })).status, 200);
    const other = (await add({ doc_number: '8-111-111' })).data;
    assert.equal((await call('PUT', `/api/customers/${other.id}`, { doc_number: '8-888-888' })).status, 409);
  } finally {
    app.close();
  }
});

test('caja: lo que cobra un usuario con sucursal asignada entra en la caja de su sucursal', async () => {
  const app = await start();
  try {
    const admin = await app.as('admin');
    const op = await app.as('operador');
    const user = app.db.prepare("SELECT id FROM users WHERE role = 'operador'").get().id;
    const r = app.reserve(); // se retira en Tocumen (1)
    const pay = async () => {
      await op('POST', `/api/reservations/${r.id}/payments`, { kind: 'pago', amount: 10, branch_id: 1 });
      return app.db.prepare('SELECT branch_id FROM payments ORDER BY id DESC LIMIT 1').get().branch_id;
    };
    assert.equal((await admin('PUT', `/api/users/${user}`, { branch_id: 2 })).status, 200);
    assert.equal(await pay(), 1); // apagado: la sucursal elegida en pantalla
    pro(app);
    assert.equal(await pay(), 2);
    assert.equal((await admin('PUT', `/api/users/${user}`, { branch_id: '' })).status, 200);
    assert.equal(await pay(), 1);
  } finally {
    app.close();
  }
});
