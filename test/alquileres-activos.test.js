'use strict';

/* Listado de alquileres activos: los autos en la calle, por sucursal, y su planilla para Excel. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, at } = require('./etapa2-helper');
const { toCsv } = require('../src/util');

test('alquileres activos: solo los autos entregados, por sucursal, y la planilla', async () => {
  const app = await start();
  try {
    const call = await app.as('admin');
    const a = app.rent({ name: 'Ana; "la jefa"', out_at: at(0, 9) });
    const b = app.rent({ vehicle_id: 2, pickup_branch_id: 2, return_branch_id: 2 });
    app.reserve({ category_id: 2, vehicle_id: 3 }); // confirmada, sin entregar: no es un alquiler activo

    const all = (await call('GET', '/api/rentals/active')).data;
    assert.deepEqual(all.map((r) => r.code).sort(), [a.code, b.code].sort());
    const row = all.find((r) => r.id === a.id);
    assert.deepEqual([row.plate, row.customer_name, row.out_at, row.return_at], ['AA0001', 'Ana; "la jefa"', at(0, 9), at(3, 8)]);
    assert.deepEqual((await call('GET', '/api/rentals/active?branch=2')).data.map((r) => r.plate), ['AA0002']);

    const csv = (await call('GET', '/api/rentals/active?branch=1&format=csv&sep=;')).data;
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    assert.equal(lines[0], 'Referencia;Placa;Cliente;Salida;Hora;Devolución prevista');
    const d = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
    assert.equal(lines[1], `${a.code};AA0001;"Ana; ""la jefa""";${d(at(0, 9))};09:00;${d(at(3, 8))} 08:00`);
    assert.equal(lines.length, 2);
  } finally {
    app.close();
  }
});

test('planilla: marca para los acentos, comillas y textos que parecen fórmulas', () => {
  const csv = toCsv(['a', 'b'], [['=SUMA(A1)', -5], [null, 'x,y']]);
  assert.equal(csv, '﻿a,b\r\n\'=SUMA(A1),-5\r\n,"x,y"\r\n');
});
