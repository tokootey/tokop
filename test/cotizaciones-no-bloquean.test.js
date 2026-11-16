'use strict';

/* "Las reservas sin confirmar no bloquean el auto": varias cotizaciones piden el mismo auto y, al confirmarse una, las demás se caen. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, at } = require('./etapa2-helper');

test('cotizaciones sobre el mismo auto: se confirma una y las que se quedan sin auto se cancelan', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const status = async (r) => (await call('GET', `/api/reservations/${r.id}`)).data.status;
    const quote = (over) => app.reserve({ status: 'pendiente', ...over });

    // Apagado (como siempre): la primera cotización se queda con el auto y la segunda no entra.
    const first = quote({ pickup_at: at(5), return_at: at(6) });
    assert.throws(() => quote({ pickup_at: at(5), return_at: at(15) }), /no está disponible/);

    assert.equal((await call('PUT', '/api/settings', { pending_free: 1 })).status, 200);
    // Prendido: la de 10 días entra aunque la de 1 día pidió el mismo auto, y una tercera en otras fechas no molesta.
    const long = quote({ pickup_at: at(5), return_at: at(15) });
    const later = quote({ pickup_at: at(20), return_at: at(22) });
    // Se confirma la de 10 días: la de 1 día se cae, con el motivo en su historial; la de otras fechas sigue.
    const ok = await call('POST', `/api/reservations/${long.id}/status`, { status: 'confirmada' });
    assert.deepEqual([ok.status, ok.data.status, ok.data.dropped], [200, 'confirmada', [first.code]]);
    assert.deepEqual([await status(first), await status(later)], ['cancelada', 'pendiente']);
    const log = (await call('GET', `/api/reservations/${first.id}`)).data.log.map((l) => `${l.action} ${l.detail || ''}`).join('|');
    assert.match(log, new RegExp(`cancelada Se confirmó la reserva ${long.code}`));
    // La que perdió no se puede confirmar ni reabrir sobre el auto que ya tiene dueño; una cotización nueva tampoco entra ahí.
    assert.equal((await call('POST', `/api/reservations/${first.id}/status`, { status: 'pendiente' })).status, 409);
    assert.throws(() => quote({ pickup_at: at(7), return_at: at(8) }), /no está disponible/);

    // Sin auto elegido, por cupo de la categoría (dos autos): tres cotizaciones entran; al confirmarse dos, la tercera se cae.
    const [a, b, c] = [1, 2, 3].map(() => quote({ vehicle_id: null, pickup_at: at(30), return_at: at(33) }));
    assert.deepEqual((await call('POST', `/api/reservations/${a.id}/status`, { status: 'confirmada' })).data.dropped, []);
    assert.deepEqual((await call('POST', `/api/reservations/${b.id}/status`, { status: 'confirmada' })).data.dropped, [c.code]);
    assert.equal(await status(c), 'cancelada');

    // Entregar una cotización sin confirmar también la deja firme: la otra que pedía ese auto se cae.
    const walkIn = quote({ vehicle_id: 2, pickup_at: at(0, 8), return_at: at(2, 8) });
    const rival = quote({ vehicle_id: 2, pickup_at: at(1, 8), return_at: at(3, 8) });
    // Una foto de la entrega, por si la agencia las exige para entregar.
    app.db.prepare("INSERT INTO reservation_files (reservation_id, stage, name, mime, path, size) VALUES (?, 'entrega', 'f.jpg', 'image/jpeg', 'x', 1)").run(walkIn.id);
    const out = await call('POST', `/api/reservations/${walkIn.id}/checkout`, { out_at: at(0, 9) });
    assert.deepEqual([out.status, out.data.dropped], [200, [rival.code]]);
  } finally {
    app.close();
  }
});
