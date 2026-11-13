'use strict';

/* Devolución: km recorridos, avisos de km de más y combustible faltante, y contratos que quedan pendientes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, at } = require('./etapa2-helper');
const { setSetting } = require('../src/db');

test('devolución: avisa los km de más y el combustible faltante antes de cerrar', async () => {
  const app = await start();
  try {
    const call = await app.as('operador');
    const r = app.rent(); // 3 días, 100 km por día incluidos, sale con 1000 km y 8/8
    const preview = (body) => call('POST', `/api/reservations/${r.id}/checkin-preview`, body);

    const ok = (await preview({ in_km: 1250, in_fuel: 8, in_at: at(3, 8) })).data;
    assert.deepEqual([ok.km_driven, ok.km_allowed, ok.km_excess, ok.fuel_missing, ok.total], [250, 300, 0, 0, 0]);

    // Sin cargo de combustible configurado igual se avisa que falta.
    const over = (await preview({ in_km: 1350, in_fuel: 5, in_at: at(3, 8) })).data;
    assert.deepEqual([over.km_driven, over.km_excess, over.fuel_missing], [350, 50, 3]);
    assert.deepEqual(over.lines, [{ concept: 'Km excedentes (50 km)', amount: 100 }]);

    assert.equal((await preview({ in_km: 900, in_fuel: 8 })).status, 400);
    // La vista previa no guarda nada: el alquiler sigue en curso.
    assert.equal(app.db.prepare('SELECT status FROM reservations WHERE id = ?').get(r.id).status, 'en_curso');
  } finally {
    app.close();
  }
});

test('contrato pendiente: con saldo o daños no se cierra hasta resolverlo (solo agencias que lo usan)', async () => {
  const app = await start();
  try {
    const call = await app.as('operador');
    // Con las funciones a pedido la entrega y la devolución piden al menos una foto.
    const back = (r, body) =>
      app.db.prepare("INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path, created_at) VALUES (?, 'devolucion', 'f.jpg', 'image/jpeg', 1, 'x', '2026-01-01T00:00')").run(r.id) && call('POST', `/api/reservations/${r.id}/checkin`, { in_km: 1100, in_fuel: 8, in_at: at(3, 8), ...body });
    const close = (r) => call('POST', `/api/reservations/${r.id}/close-contract`);

    // Sin la función activada, la devolución cierra el contrato como siempre, aunque quede saldo.
    const a = app.rent();
    const plain = (await back(a)).data;
    assert.equal(plain.status, 'finalizada');
    assert.equal(plain.contract.closed_at, at(3, 8));
    assert.equal((await close(a)).status, 409);

    setSetting(app.db, 'pro_features', '1');
    // Con saldo sin cobrar queda pendiente: el auto ya está libre, pero el contrato no se puede cerrar.
    const b = app.rent({ vehicle_id: 2 });
    const owing = (await back(b, { in_km: 2100 })).data;
    assert.deepEqual([owing.status, owing.contract.closed_at, owing.contract.pending_note], ['finalizada', null, 'Saldo sin cobrar']);
    assert.equal(app.db.prepare('SELECT status FROM vehicles WHERE id = 2').get().status, 'disponible');
    assert.deepEqual((await call('GET', '/api/dashboard')).data.open_contracts.map((x) => [x.id, x.pending_note]), [[b.id, 'Saldo sin cobrar']]);
    const refused = await close(b);
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /sin cobrar/);
    await call('POST', `/api/reservations/${b.id}/payments`, { kind: 'pago', amount: owing.balance.pending });
    const closed = await close(b);
    assert.equal(closed.status, 200);
    assert.ok(closed.data.contract.closed_at);
    assert.equal(closed.data.contract.pending_note, null);
    assert.deepEqual((await call('GET', '/api/dashboard')).data.open_contracts, []);

    // Pagado pero con daños por definir: queda pendiente; un cargo nuevo lo vuelve a trabar hasta cobrarlo.
    const c = app.reserve({ vehicle_id: 1, pickup_at: at(4, 8), return_at: at(7, 8) });
    await call('POST', `/api/reservations/${c.id}/payments`, { kind: 'pago', amount: c.total });
    app.db.prepare("INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path, created_at) VALUES (?, 'entrega', 'f.jpg', 'image/jpeg', 1, 'x', '2026-01-01T00:00')").run(c.id);
    await call('POST', `/api/reservations/${c.id}/checkout`, { out_at: at(4, 9), out_km: app.db.prepare('SELECT km FROM vehicles WHERE id = 1').get().km, out_fuel: 8 });
    const damaged = (await back(c, { in_km: 1200, in_at: at(7, 8), pending_note: 'Daños por definir' })).data;
    assert.deepEqual([damaged.contract.closed_at, damaged.contract.pending_note, damaged.balance.pending], [null, 'Daños por definir', 0]);
    await call('POST', `/api/reservations/${c.id}/charges`, { kind: 'otro', amount: 80, description: 'Paragolpes' });
    assert.equal((await close(c)).status, 409);
    await call('POST', `/api/reservations/${c.id}/payments`, { kind: 'pago', amount: 80 });
    assert.equal((await close(c)).status, 200);

    // Km de más sin tarifa de km excedente: no hay cargo, pero el contrato queda en suspenso igual.
    app.db.prepare('UPDATE categories SET extra_km_rate = 0').run();
    const d = app.reserve({ vehicle_id: 1, pickup_at: at(8, 8), return_at: at(10, 8) });
    await call('POST', `/api/reservations/${d.id}/payments`, { kind: 'pago', amount: d.total });
    app.db.prepare("INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path, created_at) VALUES (?, 'entrega', 'f.jpg', 'image/jpeg', 1, 'x', '2026-01-01T00:00')").run(d.id);
    await call('POST', `/api/reservations/${d.id}/checkout`, { out_at: at(8, 9), out_km: app.db.prepare('SELECT km FROM vehicles WHERE id = 1').get().km, out_fuel: 8 });
    const far = (await back(d, { in_km: 9000, in_at: at(10, 8) })).data;
    assert.deepEqual([far.contract.closed_at, far.contract.pending_note, far.balance.pending], [null, 'Km de más', 0]);
    assert.equal((await close(d)).status, 200);
  } finally {
    app.close();
  }
});
