'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { backupNow } = require('../src/backup');
const { offsiteConfig, syncOffsite } = require('../src/offsite');

const remote = { url: 'https://proyecto.supabase.co', key: 'clave-de-prueba', bucket: 'floty' };

/** Bucket de Supabase en memoria: atiende subir, listar (de a una carpeta) y borrar como la API de Storage. */
function fakeStorage() {
  const files = new Map();
  const calls = [];
  let failUploads = false;
  const fetchFn = async (url, opts) => {
    const route = decodeURIComponent(url.replace(`${remote.url}/storage/v1/`, ''));
    calls.push(`${opts.method} ${route}`);
    assert.equal(opts.headers.Authorization, `Bearer ${remote.key}`);
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (opts.method === 'POST' && route.startsWith('object/list/floty')) {
      const { prefix } = JSON.parse(opts.body);
      const items = new Map();
      for (const name of files.keys()) {
        if (!name.startsWith(`${prefix}/`)) continue;
        const [first, ...rest] = name.slice(prefix.length + 1).split('/');
        items.set(first, rest.length ? { name: first, id: null } : { name: first, id: name });
      }
      return reply(200, [...items.values()]);
    }
    if (opts.method === 'POST' && route.startsWith('object/floty/')) {
      if (failUploads) return reply(500, { message: 'caído' });
      files.set(route.slice('object/floty/'.length), Buffer.from(opts.body));
      return reply(200, { Key: route });
    }
    if (opts.method === 'DELETE' && route === 'object/floty') {
      for (const n of JSON.parse(opts.body).prefixes) files.delete(n);
      return reply(200, []);
    }
    return reply(404, { message: 'ruta desconocida' });
  };
  return { files, calls, fetchFn, fail: (v) => (failUploads = v) };
}

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-offsite-'));
  const backupDir = path.join(dataDir, 'respaldos');
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(path.join(dataDir, 'empresas', 'andes-archivos', '3'), { recursive: true });
  fs.mkdirSync(path.join(uploadsDir, '1'), { recursive: true });
  for (const rel of ['rentacar.db', 'empresas/andes.db']) {
    const db = new DatabaseSync(path.join(dataDir, rel));
    db.exec('CREATE TABLE t (v TEXT)');
    db.close();
  }
  fs.writeFileSync(path.join(uploadsDir, '1', 'frente.jpg'), 'foto');
  fs.writeFileSync(path.join(dataDir, 'empresas', 'andes-archivos', '3', 'contrato.pdf'), 'pdf');
  return { dataDir, backupDir, uploadsDir, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('Supabase: sólo se activa con las tres variables', () => {
  assert.equal(offsiteConfig({}), null);
  assert.equal(offsiteConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' }), null);
  assert.deepEqual(offsiteConfig({ SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SERVICE_KEY: 'k', SUPABASE_BUCKET: 'b' }), {
    url: 'https://x.supabase.co',
    key: 'k',
    bucket: 'b',
  });
});

test('Supabase: sube la copia y las fotos nuevas, y deja sólo las últimas copias', async (t) => {
  const s = setup();
  t.after(s.cleanup);
  const st = fakeStorage();
  const day = (d) => new Date(2026, 9, d, 3, 0, 0);
  const sync = (stamp) => syncOffsite({ ...s, remote, stamp, keep: 2, fetchFn: st.fetchFn });

  const first = backupNow({ ...s, keep: 2, now: day(1) });
  assert.deepEqual(await sync(first), { stamp: first, uploaded: 2 });
  assert.deepEqual([...st.files.keys()].sort(), [
    'archivos/empresas/andes-archivos/3/contrato.pdf',
    'archivos/uploads/1/frente.jpg',
    `respaldos/${first}/empresas/andes.db`,
    `respaldos/${first}/rentacar.db`,
  ]);
  assert.equal(st.files.get('archivos/uploads/1/frente.jpg').toString(), 'foto');

  // Al otro día hay una foto nueva: se sube sólo esa.
  fs.writeFileSync(path.join(s.uploadsDir, '1', 'trasera.jpg'), 'otra foto');
  assert.equal((await sync(backupNow({ ...s, keep: 2, now: day(2) }))).uploaded, 1);
  assert.equal(st.calls.filter((c) => c.endsWith('frente.jpg')).length, 1);

  // Con la tercera copia se borra la primera de Supabase, igual que en el disco.
  const third = backupNow({ ...s, keep: 2, now: day(3) });
  await sync(third);
  const stamps = new Set([...st.files.keys()].filter((n) => n.startsWith('respaldos/')).map((n) => n.split('/')[1]));
  assert.deepEqual([...stamps].sort(), ['2026-10-02_030000', third]);
});

test('Supabase: si falla la subida, avisa con el error y la copia local queda igual', async (t) => {
  const s = setup();
  t.after(s.cleanup);
  const st = fakeStorage();
  st.fail(true);
  const stamp = backupNow(s);
  await assert.rejects(syncOffsite({ ...s, remote, stamp, fetchFn: st.fetchFn }), /Supabase respondió 500/);
  assert.ok(fs.existsSync(path.join(s.backupDir, stamp, 'rentacar.db')));
  // Lo que no se pudo subir se reintenta en la próxima copia.
  st.fail(false);
  assert.equal((await syncOffsite({ ...s, remote, stamp, fetchFn: st.fetchFn })).uploaded, 2);
});
