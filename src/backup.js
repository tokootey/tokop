'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Copias de seguridad de las bases SQLite.
 *
 * Cada copia es una carpeta con la fecha y hora (respaldos/2026-10-20_030000/) que tiene todas las bases
 * de la carpeta de datos: la principal, el registro de empresas y la de cada empresa (empresas/*.db).
 * Se hacen con "VACUUM INTO", que copia la base entera y consistente aunque la app la esté usando.
 * Las fotos no se copian: ocupan mucho y quedan en el disco (Render además guarda una foto diaria del disco).
 *
 * Restaurar reemplaza las bases por las de una copia. Hay que hacerlo con la app apagada; por eso
 * existe el arranque con RESTAURAR_RESPALDO=<copia> (ver restoreOnBoot).
 */
const STAMP = /^\d{4}-\d{2}-\d{2}_\d{6}$/;
const pad = (n) => String(n).padStart(2, '0');
const stampOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** Bases de la carpeta de datos, como rutas relativas ("rentacar.db", "empresas/andes.db"). */
function databases(dataDir) {
  const list = (sub) => {
    const dir = path.join(dataDir, sub);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.db')).map((f) => path.posix.join(sub, f)) : [];
  };
  return [...list(''), ...list('empresas')];
}

function listBackups(backupDir) {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((d) => STAMP.test(d))
    .sort();
}

/** Hace una copia ahora y borra las más viejas, dejando las últimas `keep`. Devuelve el nombre de la copia. */
function backupNow({ dataDir, backupDir, keep = 14, now = new Date() }) {
  let t = now.getTime();
  while (fs.existsSync(path.join(backupDir, stampOf(new Date(t))))) t += 1000; // dos copias en el mismo segundo
  const stamp = stampOf(new Date(t));
  const target = path.join(backupDir, stamp);
  const tmp = `${target}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const rel of databases(dataDir)) {
    const out = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, rel), { readOnly: true });
    try {
      db.prepare('VACUUM INTO ?').run(out);
    } finally {
      db.close();
    }
  }
  // La copia aparece recién completa: una copia a medias (corte de luz, disco lleno) nunca queda como válida.
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(tmp, target);
  const all = listBackups(backupDir);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(backupDir, old), { recursive: true, force: true });
  return stamp;
}

/**
 * Reemplaza las bases por las de la copia `stamp`. Sólo con la app apagada.
 * Antes guarda las bases actuales en una copia nueva, así la restauración también se puede deshacer.
 */
function restore({ dataDir, backupDir, stamp, keep = 14 }) {
  if (!STAMP.test(String(stamp)) || !fs.existsSync(path.join(backupDir, stamp))) {
    throw new Error(`No existe la copia "${stamp}". Copias disponibles: ${listBackups(backupDir).join(', ') || 'ninguna'}`);
  }
  const files = databases(path.join(backupDir, stamp));
  if (!files.length) throw new Error(`La copia "${stamp}" está vacía`);
  const before = backupNow({ dataDir, backupDir, keep: keep + 1 });
  for (const rel of files) {
    const dest = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    for (const extra of ['-wal', '-shm']) fs.rmSync(dest + extra, { force: true });
    fs.copyFileSync(path.join(backupDir, stamp, rel), dest);
  }
  return { restored: stamp, files, previous: before };
}

/**
 * Restauración desde el panel de Render: se carga la variable RESTAURAR_RESPALDO con el nombre de la copia
 * y se reinicia el servicio. Se aplica una sola vez (queda anotada), aunque la variable siga puesta.
 */
function restoreOnBoot({ dataDir, backupDir, stamp }) {
  if (!stamp) return null;
  const mark = path.join(backupDir, `.restaurado-${stamp}`);
  if (fs.existsSync(mark)) return null;
  const r = restore({ dataDir, backupDir, stamp });
  fs.writeFileSync(mark, new Date().toISOString());
  return r;
}

/** Copia diaria: revisa cada hora si ya se hizo la de hoy. */
function scheduleDaily({ dataDir, backupDir, keep, log = console }) {
  const tick = () => {
    const today = stampOf(new Date()).slice(0, 10);
    if (listBackups(backupDir).some((b) => b.startsWith(today))) return;
    try {
      log.log(`Copia de seguridad hecha: ${backupNow({ dataDir, backupDir, keep })}`);
    } catch (err) {
      log.error('No se pudo hacer la copia de seguridad:', err.message);
    }
  };
  setTimeout(tick, 60 * 1000).unref(); // la primera, un minuto después de arrancar
  setInterval(tick, 60 * 60 * 1000).unref();
}

/** Estado de las copias para el Panel de Floty: si están prendidas, cuántas hay y la última (hora local del servidor). */
function backupStatus(env = process.env) {
  const { backupDir } = backupConfig(env);
  const list = listBackups(backupDir);
  const last = list[list.length - 1];
  return {
    enabled: env.BACKUP_DISABLED !== '1',
    count: list.length,
    last: last ? `${last.slice(0, 10)}T${last.slice(11, 13)}:${last.slice(13, 15)}:${last.slice(15, 17)}` : null,
  };
}

/** Carpetas según las variables de entorno: DB_FILE, BACKUP_DIR (copias) y BACKUP_KEEP (cuántas guardar). */
function backupConfig(env = process.env) {
  const dataDir = path.dirname(path.resolve(env.DB_FILE || path.join(__dirname, '..', 'data', 'rentacar.db')));
  return { dataDir, backupDir: path.resolve(env.BACKUP_DIR || path.join(dataDir, 'respaldos')), keep: Math.max(1, Number(env.BACKUP_KEEP) || 14) };
}

module.exports = { backupConfig, backupStatus, backupNow, restore, restoreOnBoot, listBackups, scheduleDaily, databases };
