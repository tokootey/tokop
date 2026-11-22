'use strict';

/* Dos pedidos de Ancon: seguro con kilometraje libre, y cliente titular que no maneja. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, at } = require('./etapa2-helper');
const { setSetting } = require('../src/db');

test('seguro con kilometraje libre: no hay km incluidos ni se cobran excedentes', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const seguro = async (body) => (await call('POST', '/api/extras', { kind: 'seguro', charge_type: 'dia', price: 10, ...body })).data.id;
    const comun = await seguro({ name: 'Intermedia' });
    const full = await seguro({ name: 'Full', km_free: 1 });
    const km = async (r) => (await call('GET', `/api/reservations/${r.id}`)).data.pricing.km_included;

    // Categoría con 100 km por día: 3 días, 300 km. Con el seguro común sigue igual; con el de km libre, no hay tope.
    const a = app.reserve({ extras: [{ extra_id: comun, quantity: 1 }] });
    const b = app.reserve({ vehicle_id: 2, extras: [{ extra_id: full, quantity: 1 }] });
    assert.deepEqual([await km(a), await km(b)], [300, null]);

    // En la devolución: 900 km recorridos. Con el común se cobran 600 de más; con el de km libre, nada.
    const back = async (r, outKm) => {
      app.db.prepare("INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path) VALUES (?, 'entrega', 'f.jpg', 'image/jpeg', 1, 'x')").run(r.id);
      await call('POST', `/api/reservations/${r.id}/checkout`, { out_at: at(0, 9) });
      return (await call('POST', `/api/reservations/${r.id}/checkin-preview`, { in_km: outKm + 900, in_fuel: 8, in_at: at(3, 8) })).data;
    };
    const pa = await back(a, 1000);
    const pb = await back(b, 2000);
    assert.deepEqual([pa.km_allowed, pa.km_excess, pa.total], [300, 600, 1200]);
    assert.deepEqual([pb.km_allowed, pb.km_excess, pb.total], [null, 0, 0]);

    // Marcar el seguro después también corrige las reservas que ya lo tenían.
    assert.equal((await call('PUT', `/api/extras/${comun}`, { km_free: 1 })).status, 200);
    assert.equal(await km(a), null);
  } finally {
    app.close();
  }
});

test('cliente titular que no maneja: se pide la licencia de un conductor, no la del cliente', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const r = app.reserve();
    const parties = (body) => call('POST', `/api/reservations/${r.id}/parties`, body);
    const out = () => call('POST', `/api/reservations/${r.id}/checkout`, { out_at: at(0, 9) });
    // La titular no tiene licencia cargada.
    app.db.prepare("UPDATE customers SET license_number = NULL, license_expiry = NULL WHERE id = ?").run(r.customer_id);

    // Como siempre: sin la licencia del cliente no se entrega.
    assert.match((await out()).data.error, /vencimiento de la licencia/);

    // "No maneja" exige al menos un conductor, y ese conductor tiene que tener la licencia vigente.
    assert.equal((await parties({ customer_no_drive: 1, drivers: [] })).status, 400);
    const sinLicencia = await parties({ customer_no_drive: 1, drivers: [{ full_name: 'Carla Conductora', doc_number: '8-1-1' }] });
    assert.deepEqual([sinLicencia.status, sinLicencia.data.customer_no_drive], [200, 1]);
    assert.match((await out()).data.error, /El cliente no maneja: cargá un conductor con su licencia vigente/);

    await parties({ customer_no_drive: 1, drivers: [{ full_name: 'Carla Conductora', doc_number: '8-1-1', license_number: 'L-9', license_expiry: '2035-01-01' }] });
    assert.equal((await out()).data.status, 'en_curso');
  } finally {
    app.close();
  }
});

test('firma con funciones en prueba: el nombre y el documento salen de la reserva, no de lo que escribe el cliente', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    const signAs = async (body) => {
      const r = app.reserve({ name: 'Marcela Ríos', vehicle_id: null });
      const { token } = (await call('POST', `/api/reservations/${r.id}/signature`, { terms: [{ title: '1. OBJETO.', body: 'Texto.' }] })).data;
      const url = `${app.base}/api/public/entrega/contrato/${token}`;
      const lock = (await (await fetch(url)).json()).lock_signer;
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, accepted: true, image }) });
      assert.equal(res.status, 200, await res.text());
      const s = (await call('GET', `/api/reservations/${r.id}`)).data.signature;
      return [lock, s.name, s.doc];
    };
    // Apagado: vale lo que escribe quien firma, como siempre.
    assert.deepEqual(await signAs({ name: 'Otro Nombre', doc: '9-999-999' }), [false, 'Otro Nombre', '9-999-999']);
    setSetting(app.db, 'pro_features', '1');
    assert.deepEqual(await signAs({ name: 'Otro Nombre', doc: '9-999-999' }), [true, 'Marcela Ríos', '8-2']);
  } finally {
    app.close();
  }
});
