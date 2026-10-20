'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { backupNow, restore, restoreOnBoot, listBackups, databases, backupConfig } = require('../src/backup');

/** Carpeta de datos como la de Render: base principal, registro de empresas y una base por empresa. */
function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-backup-'));
  const backupDir = path.join(dataDir, 'respaldos');
  fs.mkdirSync(path.join(dataDir, 'empresas'));
  const open = (rel) => {
    const db = new DatabaseSync(path.join(dataDir, rel));
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS t (v TEXT)');
    return db;
  };
  const dbs = { principal: open('rentacar.db'), registro: open('empresas.db'), andes: open('empresas/andes.db') };
  const put = (name, v) => dbs[name].prepare('INSERT INTO t (v) VALUES (?)').run(v);
  const values = (rel) => {
    const db = new DatabaseSync(path.join(dataDir, rel), { readOnly: true });
    try {
      return db.prepare('SELECT v FROM t ORDER BY rowid').all().map((r) => r.v);
    } finally {
      db.close();
    }
  };
  const closeAll = () => Object.values(dbs).forEach((d) => d.isOpen && d.close());
  return { dataDir, backupDir, dbs, put, values, closeAll, cleanup: () => (closeAll(), fs.rmSync(dataDir, { recursive: true, force: true })) };
}

test('copia de seguridad: guarda todas las bases, aunque la app las esté usando', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.put('principal', 'reserva 1');
  s.put('andes', 'reserva de Andes');
  const stamp = backupNow({ dataDir: s.dataDir, backupDir: s.backupDir });
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}_\d{6}$/);
  assert.deepEqual(databases(path.join(s.backupDir, stamp)).sort(), ['empresas.db', 'empresas/andes.db', 'rentacar.db']);
  // La copia trae lo último que se guardó, aunque esté todavía en el archivo -wal.
  assert.deepEqual(s.values(path.join('respaldos', stamp, 'rentacar.db')), ['reserva 1']);
  assert.deepEqual(s.values(path.join('respaldos', stamp, 'empresas', 'andes.db')), ['reserva de Andes']);
  // Las copias no se copian a sí mismas.
  assert.deepEqual(databases(s.dataDir).sort(), ['empresas.db', 'empresas/andes.db', 'rentacar.db']);
});

test('rotación: quedan sólo las últimas copias', (t) => {
  const s = setup();
  t.after(s.cleanup);
  const day = (d) => new Date(2026, 9, d, 3, 0, 0);
  for (const d of [1, 2, 3, 4, 5]) backupNow({ dataDir: s.dataDir, backupDir: s.backupDir, keep: 3, now: day(d) });
  assert.deepEqual(listBackups(s.backupDir), ['2026-10-03_030000', '2026-10-04_030000', '2026-10-05_030000']);
  // Dos copias en el mismo segundo no se pisan.
  const a = backupNow({ dataDir: s.dataDir, backupDir: s.backupDir, keep: 10, now: day(6) });
  const b = backupNow({ dataDir: s.dataDir, backupDir: s.backupDir, keep: 10, now: day(6) });
  assert.notEqual(a, b);
});

test('restaurar: vuelve a la copia y guarda lo que había antes', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.put('principal', 'antes');
  s.put('andes', 'andes antes');
  const stamp = backupNow({ dataDir: s.dataDir, backupDir: s.backupDir });
  s.put('principal', 'después (se pierde al restaurar)');
  s.put('andes', 'andes después');
  s.closeAll(); // la app apagada

  const r = restore({ dataDir: s.dataDir, backupDir: s.backupDir, stamp });
  assert.deepEqual(s.values('rentacar.db'), ['antes']);
  assert.deepEqual(s.values('empresas/andes.db'), ['andes antes']);
  // Lo de antes de restaurar quedó en otra copia: la restauración se puede deshacer.
  assert.deepEqual(s.values(path.join('respaldos', r.previous, 'rentacar.db')), ['antes', 'después (se pierde al restaurar)']);

  assert.throws(() => restore({ dataDir: s.dataDir, backupDir: s.backupDir, stamp: '2020-01-01_000000' }), /No existe la copia/);
  assert.throws(() => restore({ dataDir: s.dataDir, backupDir: s.backupDir, stamp: '../rentacar.db' }), /No existe la copia/);
});

test('RESTAURAR_RESPALDO al arrancar: se aplica una sola vez', (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.put('principal', 'copia');
  const stamp = backupNow({ dataDir: s.dataDir, backupDir: s.backupDir });
  s.put('principal', 'nuevo');
  s.closeAll();
  assert.equal(restoreOnBoot({ dataDir: s.dataDir, backupDir: s.backupDir, stamp: undefined }), null);
  assert.equal(restoreOnBoot({ dataDir: s.dataDir, backupDir: s.backupDir, stamp }).restored, stamp);
  assert.deepEqual(s.values('rentacar.db'), ['copia']);

  // Se cargan datos nuevos y la app se reinicia con la variable todavía puesta: no se vuelve a restaurar.
  const db = new DatabaseSync(path.join(s.dataDir, 'rentacar.db'));
  db.prepare('INSERT INTO t (v) VALUES (?)').run('cargado después');
  db.close();
  assert.equal(restoreOnBoot({ dataDir: s.dataDir, backupDir: s.backupDir, stamp }), null);
  assert.deepEqual(s.values('rentacar.db'), ['copia', 'cargado después']);
});

test('configuración: las copias van al lado de la base, salvo que se indique otra carpeta', () => {
  const c = backupConfig({ DB_FILE: '/var/data/rentacar.db' });
  assert.equal(c.backupDir, path.resolve('/var/data/respaldos'));
  assert.equal(c.keep, 14);
  assert.equal(backupConfig({ DB_FILE: '/var/data/rentacar.db', BACKUP_DIR: '/var/data/otra', BACKUP_KEEP: '30' }).keep, 30);
});

test('con varias empresas: se respaldan y se restauran las bases de todas', (t) => {
  const { openDb } = require('../src/db');
  const { openPlatform } = require('../src/platform');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-backup-multi-'));
  const backupDir = path.join(dataDir, 'respaldos');
  const dbFile = path.join(dataDir, 'rentacar.db');
  let platform;
  t.after(() => {
    platform.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // Instalación con la empresa principal y dos agencias más, cada una con un cliente propio.
  platform = openPlatform(openDb(dbFile), dbFile);
  const andes = platform.create({ name: 'Andes Autos', country: 'CL', admin_email: 'a@andes.test' }).company;
  const sur = platform.create({ name: 'Sur Rent', country: 'AR', admin_email: 'b@sur.test' }).company;
  const addCustomer = (id, name) => platform.get(id).db.prepare('INSERT INTO customers (full_name) VALUES (?)').run(name);
  const customers = (p, id) => p.get(id).db.prepare('SELECT full_name FROM customers ORDER BY id').all().map((c) => c.full_name);
  addCustomer(1, 'Cliente principal');
  addCustomer(andes.id, 'Cliente Andes');
  addCustomer(sur.id, 'Cliente Sur');

  const stamp = backupNow({ dataDir, backupDir });
  assert.deepEqual(databases(path.join(backupDir, stamp)).sort(), ['empresas.db', 'empresas/andes-autos.db', 'empresas/sur-rent.db', 'rentacar.db']);

  // Después de la copia se cargan más datos en las dos agencias y se cierra la app.
  addCustomer(andes.id, 'Cargado después en Andes');
  addCustomer(sur.id, 'Cargado después en Sur');
  platform.close();

  restore({ dataDir, backupDir, stamp });
  platform = openPlatform(openDb(dbFile), dbFile);
  assert.deepEqual(
    platform.list().map((c) => c.slug),
    ['principal', 'andes-autos', 'sur-rent'],
  );
  assert.deepEqual(customers(platform, 1), ['Cliente principal']);
  assert.deepEqual(customers(platform, andes.id), ['Cliente Andes']);
  assert.deepEqual(customers(platform, sur.id), ['Cliente Sur']);
  // Cada empresa sigue viendo sólo lo suyo después de restaurar.
  assert.equal(platform.byEmail('a@andes.test').id, andes.id);
});
