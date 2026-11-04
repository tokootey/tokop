'use strict';

/* Carnet y DNI del cliente: uno por lugar, se reemplaza al subir otro y se borra al anonimizar o borrar al cliente. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp, ensureAdmin } = require('../src/app');

test('documentos del cliente: subir, reemplazar, ver, borrar y anonimizar', async () => {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-docs-'));
  const db = openDb(':memory:');
  ensureAdmin(db);
  const server = createApp(db, { uploadsDir }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@rentacar.local', password: 'admin123' }) });
    const Cookie = login.headers.get('set-cookie').split(';')[0];
    const call = (method, p, body, type = 'application/json') =>
      fetch(base + p, { method, headers: { Cookie, 'Content-Type': type }, body: type === 'application/json' && body ? JSON.stringify(body) : body });
    assert.equal((await call('POST', '/auth/password', { current: 'admin123', password: 'Ushuaia2026Segura' })).status, 200);

    const c = await (await call('POST', '/customers', { full_name: 'Juan Pérez', doc_number: '33456789' })).json();
    const jpg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, n)]);
    const up = (kind, body, type = 'image/jpeg') => call('POST', `/customers/${c.id}/documents?kind=${kind}&name=carnet.jpg`, body, type);
    const dir = path.join(uploadsDir, 'clientes', String(c.id));
    const list = async () => (await call('GET', `/customers/${c.id}/documents`)).json();

    assert.equal((await up('carnet_frente', jpg(1))).status, 201);
    assert.equal((await up('dni_frente', jpg(2))).status, 201);
    // Subir otro carnet reemplaza al anterior: queda uno y el archivo viejo se borra.
    const nuevo = await (await up('carnet_frente', jpg(3))).json();
    assert.deepEqual((await list()).map((d) => d.kind).sort(), ['carnet_frente', 'dni_frente']);
    assert.equal(fs.readdirSync(dir).length, 2);
    const file = await call('GET', `/documents/${nuevo.id}`);
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), jpg(3));
    assert.match(file.headers.get('content-security-policy'), /sandbox/);

    // Lo que no es un documento válido no entra.
    assert.equal((await up('dni_garante', jpg(4))).status, 400);
    assert.equal((await up('dni_dorso', Buffer.from('<script>alert(1)</script>'))).status, 415);
    assert.equal((await up('dni_dorso', Buffer.from('hola'), 'text/html')).status, 415);

    assert.equal((await call('DELETE', `/documents/${nuevo.id}`)).status, 204);
    assert.deepEqual((await list()).map((d) => d.kind), ['dni_frente']);

    // Anonimizar borra las filas y la carpeta del cliente; después no se le pueden subir documentos.
    assert.equal((await call('POST', `/customers/${c.id}/anonymize`)).status, 200);
    assert.deepEqual(await list(), []);
    assert.equal(fs.existsSync(dir), false);
    assert.equal((await up('carnet_frente', jpg(5))).status, 409);

    // Borrar un cliente también borra sus documentos del disco.
    const otro = await (await call('POST', '/customers', { full_name: 'Carla Gómez' })).json();
    assert.equal((await call('POST', `/customers/${otro.id}/documents?kind=carnet_dorso`, jpg(6), 'image/jpeg')).status, 201);
    assert.equal((await call('DELETE', `/customers/${otro.id}`)).status, 204);
    assert.equal(fs.existsSync(path.join(uploadsDir, 'clientes', String(otro.id))), false);
  } finally {
    server.close();
  }
});
