'use strict';

/* Contratos: extender un alquiler, titular y conductores adicionales, y cambiar a un auto de otro valor sin tocar el precio. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, at } = require('./etapa2-helper');
const { setSetting } = require('../src/db');

test('extender un alquiler en curso: suma los días nuevos y no pisa otra reserva del mismo auto', async () => {
  const app = await start();
  try {
    const call = await app.as('operador');
    const extend = (r, body) => call('POST', `/api/reservations/${r.id}/extend`, body);

    // Precio del sistema: 3 días a 50. Dos días más → 5 días, 250.
    const r = app.rent();
    assert.deepEqual([r.days, r.total], [3, 150]);
    assert.equal((await extend(r, { return_at: at(2, 8) })).status, 400); // antes de la devolución actual
    const longer = (await extend(r, { return_at: at(5, 8) })).data;
    assert.deepEqual([longer.return_at, longer.days, longer.total, longer.status], [at(5, 8), 5, 250, 'en_curso']);
    assert.deepEqual(longer.pricing.extensions, [{ from: at(3, 8), to: at(5, 8), days: 2, amount: 100 }]);

    // Otra reserva del mismo auto a partir del día 7: hasta el 6 se puede, más allá no.
    app.reserve({ pickup_at: at(7, 8), return_at: at(9, 8) });
    const clash = await extend(r, { return_at: at(8, 8) });
    assert.equal(clash.status, 409);
    assert.match(clash.data.error, /ya está reservado/);
    // Importe acordado para la extensión: un día más por 30.
    const agreed = (await extend(r, { return_at: at(6, 8), extra_amount: 30 })).data;
    assert.deepEqual([agreed.days, agreed.total, agreed.pricing.source], [6, 280, 'acordado']);

    // Precio acordado desde el principio (120 por 3 días): cada día nuevo vale lo mismo, 40.
    const b = app.reserve({ vehicle_id: 2, price_override: 120 });
    await call('POST', `/api/reservations/${b.id}/checkout`, {});
    assert.equal((await extend(b, { return_at: at(4, 8) })).data.total, 160);

    // Una reserva que todavía no salió no se extiende: se modifica.
    assert.equal((await extend(app.reserve({ category_id: 2, vehicle_id: 3 }), { return_at: at(9, 8) })).status, 409);
  } finally {
    app.close();
  }
});

test('titular distinto del conductor y hasta 5 conductores adicionales', async () => {
  const app = await start();
  try {
    const call = await app.as('operador');
    const r = app.reserve();
    const set = (body) => call('POST', `/api/reservations/${r.id}/parties`, body);
    const driver = (n, extra = {}) => ({ full_name: `Conductor ${n}`, doc_type: 'Pasaporte', doc_number: `P${n}`, license_number: `L${n}`, license_expiry: '2035-01-01', ...extra });

    const saved = (await set({ holder: { full_name: 'Empresa S.A.', doc_type: 'R.U.C.', doc_number: '155-1-2' }, drivers: [driver(1), { full_name: '  ' }, driver(2)] })).data;
    assert.deepEqual([saved.holder.full_name, saved.holder.doc_type, saved.holder.doc_number], ['Empresa S.A.', 'R.U.C.', '155-1-2']);
    assert.deepEqual(saved.drivers.map((d) => [d.full_name, d.doc_type, d.license_expiry]), [['Conductor 1', 'Pasaporte', '2035-01-01'], ['Conductor 2', 'Pasaporte', '2035-01-01']]);

    assert.equal((await set({ drivers: [1, 2, 3, 4, 5, 6].map((n) => driver(n)) })).status, 400);
    const expired = await set({ drivers: [driver(1, { license_expiry: '2020-01-01' })] });
    assert.equal(expired.status, 400);
    assert.match(expired.data.error, /vence antes/);
    // Sin nombre de titular, el titular es el cliente.
    const cleared = (await set({ holder: { full_name: '' }, drivers: [1, 2, 3, 4, 5].map((n) => driver(n)) })).data;
    assert.equal(cleared.holder, null);
    assert.equal(cleared.drivers.length, 5);

    // Lugar de trabajo y contacto alternativo del cliente llegan al contrato.
    await call('PUT', `/api/customers/${r.customer_id}`, { workplace: 'Canal de Panamá', alt_contact: 'Marta, +507 6111 2222' });
    const full = (await call('GET', `/api/reservations/${r.id}`)).data;
    assert.deepEqual([full.customer_workplace, full.customer_alt_contact], ['Canal de Panamá', 'Marta, +507 6111 2222']);
  } finally {
    app.close();
  }
});

test('cambiar a mano a un auto de otro valor mantiene el precio (solo agencias que lo usan)', async () => {
  const app = await start();
  try {
    const call = await app.as('operador');
    const r = app.reserve(); // categoría económica, 150
    const assign = (vehicle_id) => call('POST', `/api/reservations/${r.id}/assign`, { vehicle_id });

    // Sin la función: como siempre, solo autos de la misma categoría.
    assert.equal((await assign(3)).status, 400);
    assert.deepEqual((await call('GET', `/api/reservations/${r.id}/move-options`)).data.others, []);

    setSetting(app.db, 'pro_features', '1');
    assert.deepEqual((await call('GET', `/api/reservations/${r.id}/move-options`)).data.others.map((v) => v.plate), ['AA0003']);
    const moved = (await assign(3)).data;
    assert.deepEqual([moved.vehicle_plate, moved.category_code, moved.total], ['AA0003', 'SUV', 150]);
    // Una modificación posterior tampoco lo lleva al precio de la categoría nueva (270).
    const edited = (await call('PUT', `/api/reservations/${r.id}`, { notes: 'Cambio de auto sin cargo' })).data;
    assert.deepEqual([edited.total, edited.pricing.calculated_total], [150, 270]);
    // Un auto ocupado en esas fechas sigue sin poder asignarse.
    app.reserve({ vehicle_id: 2 });
    assert.equal((await assign(2)).status, 409);
  } finally {
    app.close();
  }
});
