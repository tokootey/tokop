'use strict';

/* Auxiliar de flota: fotos, km y combustible y mover autos; sin reservas ni precios. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('./etapa2-helper');

test('auxiliar de flota: ve lo de los autos sin precios y no entra a las reservas', async () => {
  process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-'));
  const app = await start();
  try {
    const admin = await app.as('admin');
    const aux = await app.as('auxiliar');
    const r = app.reserve();
    await admin('POST', `/api/reservations/${r.id}/payments`, { kind: 'pago', amount: 100 });

    // El administrador lo puede crear con ese rol.
    const made = await admin('POST', '/api/users', { name: 'Flota', email: 'flota@prueba.local', password: 'Clave2026Segura', role: 'auxiliar' });
    assert.equal(made.status, 201);
    assert.equal(app.db.prepare('SELECT role FROM users WHERE id = ?').get(made.data.id).role, 'auxiliar');

    // Ve qué sale hoy, el calendario y los autos, pero ningún importe.
    const dash = await aux('GET', '/api/dashboard');
    assert.equal(dash.status, 200);
    // Los pedidos sin confirmar le llegan con el teléfono del cliente (para contactarlo a la mañana) y sin importes.
    const asked = app.reserve({ status: 'pendiente', vehicle_id: 2, name: 'Pedido de noche' });
    const fresh = (await aux('GET', '/api/dashboard')).data.pending.find((x) => x.id === asked.id);
    assert.deepEqual([fresh.customer_name, fresh.customer_phone, 'total' in fresh], ['Pedido de noche', '+507 6000 0000', false]);
    const trip = dash.data.pickups_today.find((x) => x.id === r.id);
    assert.deepEqual([trip.code, trip.vehicle_plate, trip.vehicle_id], [r.code, 'AA0001', 1]);
    const text = JSON.stringify([dash.data, (await aux('GET', '/api/planning')).data, (await aux('GET', '/api/categories')).data, (await aux('GET', '/api/vehicles')).data]);
    for (const key of ['"total"', '"paid"', '"month_revenue"', '"daily_rate"', '"insurance_cost"']) assert.ok(!text.includes(key), `no tiene que ver ${key}`);
    assert.ok(JSON.stringify((await admin('GET', '/api/dashboard')).data).includes('"total"'), 'el resto de los usuarios sigue viendo los importes');

    // No entra a las reservas, los clientes, la caja ni los pagos.
    for (const [method, url] of [
      ['GET', `/api/reservations/${r.id}`],
      ['GET', '/api/reservations'],
      ['GET', '/api/customers'],
      ['GET', '/api/cash'],
      ['GET', '/api/rentals/active'],
      ['POST', `/api/reservations/${r.id}/payments`],
      ['POST', `/api/reservations/${r.id}/checkout`],
      ['POST', '/api/vehicles'],
      ['DELETE', '/api/vehicles/1'],
    ]) {
      assert.equal((await aux(method, url, method === 'GET' ? undefined : {})).status, 403, `${method} ${url}`);
    }

    // Mueve un auto de sucursal y carga km y combustible; el resto de la ficha no lo cambia.
    const moved = await aux('PUT', '/api/vehicles/1', { branch_id: 2, km: 1500, fuel: 6, plate: 'ZZ9999', status: 'fuera_servicio' });
    assert.equal(moved.status, 200);
    const v = app.db.prepare('SELECT plate, status, branch_id, km, fuel FROM vehicles WHERE id = 1').get();
    assert.deepEqual({ ...v }, { plate: 'AA0001', status: 'disponible', branch_id: 2, km: 1500, fuel: 6 });

    // Fotos: sube y ve las de entrega y devolución; los demás documentos de la reserva, no.
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const upload = (call, stage) => call.raw(`/api/reservations/${r.id}/files?stage=${stage}&name=foto.jpg`, jpg);
    assert.equal((await upload(aux, 'devolucion')).status, 201);
    assert.equal((await upload(aux, 'contrato')).status, 403);
    const contract = await upload(admin, 'contrato');
    assert.equal(contract.status, 201);
    const list = (await aux('GET', `/api/reservations/${r.id}/files`)).data;
    assert.deepEqual(list.map((f) => f.stage), ['devolucion']);
    assert.equal((await aux('GET', `/api/files/${list[0].id}`)).status, 200);
    assert.equal((await aux('GET', `/api/files/${contract.data.id}`)).status, 403);

    // Notas: quedan en el historial de la reserva con su nombre; vacía no se guarda.
    assert.equal((await aux('POST', `/api/reservations/${r.id}/note`, { note: 'Entrega: rayón en el paragolpes' })).status, 200);
    assert.equal((await aux('POST', `/api/reservations/${r.id}/note`, { note: '  ' })).status, 400);
    const log = (await admin('GET', `/api/reservations/${r.id}`)).data.log.find((l) => l.action === 'nota');
    assert.deepEqual([log.detail, log.user_name], ['Entrega: rayón en el paragolpes', 'auxiliar']);

    // Cliente bloqueado: no se le toman reservas; el motivo lo ve la agencia, no quien reserva por la web.
    const R = require('../src/reservations');
    const booking = { customer_id: r.customer_id, category_id: 1, pickup_branch_id: 1, return_branch_id: 1, pickup_at: '2030-01-10T10:00', return_at: '2030-01-12T10:00' };
    assert.equal((await admin('PUT', `/api/customers/${r.customer_id}`, { blocked_reason: 'No devolvió un auto' })).status, 200);
    const refused = await admin('POST', '/api/reservations', booking);
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /bloqueado: No devolvió un auto/);
    assert.throws(() => R.createReservation(app.db, booking), (e) => e.status === 409 && !/No devolvió/.test(e.message));
    await admin('PUT', `/api/customers/${r.customer_id}`, { blocked_reason: '' });
    assert.equal((await admin('POST', '/api/reservations', booking)).status, 201);
  } finally {
    app.close();
    fs.rmSync(process.env.UPLOADS_DIR, { recursive: true, force: true });
    delete process.env.UPLOADS_DIR;
  }
});
