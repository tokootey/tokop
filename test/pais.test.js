'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

// Empresa nueva, sin datos de ejemplo: así arranca un cliente que recién instala el sistema.
let db;
let server;
let base;
let admin;
let uploadsDir;

async function req(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(admin ? { Cookie: admin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
}

test.before(async () => {
  db = openDb(':memory:');
  ensureAdmin(db);
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pais-'));
  server = createApp(db, { uploadsDir }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const l = await req('POST', '/api/auth/login', { email: 'admin@rentacar.local', password: 'admin123' });
  admin = l.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('POST', '/api/auth/password', { current: 'admin123', password: 'Ushuaia2026Segura' })).status, 200);
});

test.after(() => {
  server.close();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

test('una empresa nueva ve los primeros pasos y se van completando', async () => {
  let d = (await req('GET', '/api/dashboard')).data;
  assert.equal(d.setup.total, 6);
  assert.equal(d.setup.done, 0);
  assert.ok(d.setup.steps.every((s) => s.href.startsWith('#/')));

  await req('PUT', '/api/settings', { company_name: 'Rent a Car Pucón', jurisdiction: 'Pucón', deductible_amount: '500000' });
  const b = await req('POST', '/api/branches', { code: 'PUC', name: 'Oficina Pucón' });
  assert.equal(b.status, 201, JSON.stringify(b.data));
  await req('POST', '/api/categories', { code: 'A', name: 'Económico', daily_rate: 35000 });
  d = (await req('GET', '/api/dashboard')).data;
  assert.equal(d.setup.done, 4);
  assert.deepEqual(d.setup.steps.filter((s) => !s.done).map((s) => s.key), ['flota', 'usuarios']);
});

test('cada país trae su moneda, impuesto e identificación fiscal', async () => {
  const s = (await req('GET', '/api/settings')).data;
  assert.equal(s.country, 'AR');
  assert.equal(s.tax_id_label, 'CUIT');
  const p = s.country_presets;
  assert.deepEqual([p.CL.currency, p.CL.tax_rate, p.CL.tax_id_label], ['CLP', '19', 'RUT']);
  assert.deepEqual([p.PE.tax_name, p.PE.tax_rate], ['IGV', '18']);
  assert.deepEqual([p.DO.tax_name, p['ES-CN'].tax_name, p.MX.tax_id_label], ['ITBIS', 'IGIC', 'RFC']);
  for (const [code, preset] of Object.entries(p)) {
    assert.doesNotThrow(() => new Intl.NumberFormat(preset.locale, { style: 'currency', currency: preset.currency }).format(1), code);
  }
});

test('guardar el país cambia moneda e impuesto, y el precio usa la nueva alícuota', async () => {
  const cl = { country: 'CL', currency: 'CLP', locale: 'es-CL', tax_name: 'IVA', tax_rate: '19', tax_id_label: 'RUT', prices_include_tax: '0' };
  assert.equal((await req('PUT', '/api/settings', cl)).status, 200);
  const s = (await req('GET', '/api/settings')).data;
  assert.deepEqual([s.country, s.currency, s.tax_rate, s.tax_id_label], ['CL', 'CLP', '19', 'RUT']);
  const q = await req('POST', '/api/quote', { category_id: 1, pickup_at: '2030-01-10T10:00', return_at: '2030-01-12T10:00' });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  assert.equal(q.data.tax_rate, 19);
  assert.equal(q.data.total, 70000 * 1.19);
});

test('rechaza país, moneda o formato inválidos (romperían las pantallas)', async () => {
  assert.equal((await req('PUT', '/api/settings', { locale: 'xx-<script>' })).status, 400);
  assert.equal((await req('PUT', '/api/settings', { currency: 'PESOS' })).status, 400);
  assert.equal((await req('PUT', '/api/settings', { country: 'ZZ' })).status, 400);
  assert.equal((await req('GET', '/api/settings')).data.currency, 'CLP', 'no cambió nada');
});
