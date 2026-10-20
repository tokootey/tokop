'use strict';

/*
 * Copias de seguridad desde la línea de comandos.
 *
 *   npm run respaldo                      hace una copia ahora
 *   npm run respaldo -- lista             muestra las copias guardadas
 *   npm run respaldo -- restaurar FECHA   vuelve a una copia (con la app apagada)
 *
 * En Render no hace falta: la app hace una copia por día sola y se restaura con la variable
 * RESTAURAR_RESPALDO (ver README → Copias de seguridad).
 */
const { backupConfig, backupNow, listBackups, restore } = require('../src/backup');

const cfg = backupConfig();
const [cmd, stamp] = process.argv.slice(2);
try {
  if (!cmd) {
    console.log(`Copia hecha: ${backupNow(cfg)} (en ${cfg.backupDir})`);
  } else if (cmd === 'lista') {
    const list = listBackups(cfg.backupDir);
    console.log(list.length ? list.join('\n') : `No hay copias en ${cfg.backupDir}`);
  } else if (cmd === 'restaurar') {
    const r = restore({ ...cfg, stamp });
    console.log(`Listo: se restauró la copia ${r.restored} (${r.files.join(', ')}).`);
    console.log(`Las bases que había antes quedaron guardadas en la copia ${r.previous}.`);
  } else {
    console.log('Uso: npm run respaldo [-- lista | -- restaurar FECHA]');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
