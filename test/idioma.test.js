'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { openDb, CONTRACT_TERMS, CONTRACT_TERMS_EN } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

// Carga public/i18n.js como en el navegador, con el idioma guardado en "localStorage".
function loadI18n(lang) {
  const sandbox = { module: { exports: {} }, localStorage: { getItem: () => lang } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8'), sandbox);
  return sandbox.module.exports;
}

test('en español los textos quedan igual', () => {
  const { tr, L } = loadI18n(null);
  assert.equal(tr('Nueva reserva'), 'Nueva reserva');
  assert.equal(L('Hola', 'Hello'), 'Hola');
});

test('en inglés traduce frases, mayúsculas, modelos con datos y pedazos', () => {
  const { tr, trDoc, L } = loadI18n('en');
  assert.equal(L('Hola', 'Hello'), 'Hello');
  assert.equal(tr('Nueva reserva'), 'New booking');
  assert.equal(tr('  Guardar '), '  Save ');
  assert.equal(tr('CLIENTE / CONDUCTOR PRINCIPAL'), 'CUSTOMER / MAIN DRIVER');
  assert.equal(tr('Sin disponibilidad en la categoría SUV para esas fechas'), 'No availability in category SUV for those dates');
  // Pedazos con datos en el medio: los datos (nombre, empresa, código) quedan como están.
  assert.equal(trDoc('Hola Ana, te confirmamos tu reserva en Austral.'), 'Hello Ana, your booking is confirmed at Austral.');
  // En pantalla una palabra suelta no se cambia dentro de un dato de la empresa; en el contrato sí.
  assert.equal(tr('Seguro sin franquicia'), 'Seguro sin franquicia');
  assert.equal(trDoc('Mi Rent a Car'), 'Mi Rent a Car');
  assert.equal(trDoc('Alquiler 3 día(s) × $ 10.000'), 'Rental 3 day(s) × $ 10.000');
  // "Total final" gana sobre "Total"; una palabra no se reemplaza dentro de otra.
  assert.equal(tr('Total final con cargos'), 'Final total with charges');
  assert.equal(tr('Díaz Pérez'), 'Díaz Pérez');
  assert.equal(tr(42), 42);
});

test('el diccionario no tiene traducciones vacías y respeta los datos {}', () => {
  const { EN } = loadI18n('en');
  for (const [es, en] of Object.entries(EN)) {
    assert.ok(String(en).trim(), `sin traducción: ${es}`);
    assert.equal((es.match(/\{\}/g) || []).length, (en.match(/\{\}/g) || []).length, `datos distintos en: ${es}`);
  }
});

test('el contrato en inglés tiene las mismas cláusulas y {palabras} que el español', () => {
  const clauses = (t) => t.split(/\n\s*\n/).filter((p) => p.trim());
  const words = (t) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  assert.equal(clauses(CONTRACT_TERMS_EN).length, clauses(CONTRACT_TERMS).length);
  assert.deepEqual(words(CONTRACT_TERMS_EN), words(CONTRACT_TERMS));
  clauses(CONTRACT_TERMS_EN).forEach((c, i) => assert.match(c, new RegExp(`^${i + 1}\\. [A-Z ,]+\\.`)));
});

test('Ajustes guarda los textos en inglés de cada empresa', async () => {
  const db = openDb(':memory:');
  ensureAdmin(db);
  const server = createApp(db, { uploadsDir: path.join(require('node:os').tmpdir(), 'idioma-test') }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const req = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) });
    if (!cookie && res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    await req('POST', '/api/auth/login', { email: 'admin@rentacar.local', password: 'admin123' });
    assert.equal((await req('POST', '/api/auth/password', { current: 'admin123', password: 'Ushuaia2026Segura' })).status, 200);
    const s = (await req('GET', '/api/settings')).data;
    assert.equal(s.contract_terms_en, CONTRACT_TERMS_EN);
    assert.equal(s.contract_terms_en_default, CONTRACT_TERMS_EN);
    assert.match(s.jurisdiction_en, /Ushuaia/);
    assert.equal((await req('PUT', '/api/settings', { contract_terms_en: '1. TEST. Hello.', refund_terms_en: 'No refunds by phone.', jurisdiction_en: 'Ushuaia' })).status, 200);
    const after = (await req('GET', '/api/settings')).data;
    assert.equal(after.contract_terms_en, '1. TEST. Hello.');
    assert.equal(after.refund_terms_en, 'No refunds by phone.');
    assert.equal(after.jurisdiction_en, 'Ushuaia');
  } finally {
    server.close();
    db.close();
  }
});
