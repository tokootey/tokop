'use strict';

/*
 * Copias de seguridad automáticas. `npm start` carga este archivo antes que la app (node --require),
 * así queda separado del arranque de src/server.js:
 *  - si está la variable RESTAURAR_RESPALDO, vuelve a esa copia antes de abrir las bases (una sola vez);
 *  - programa la copia diaria (salvo BACKUP_DISABLED=1).
 */
const backup = require('./backup');

const cfg = backup.backupConfig();
const restored = backup.restoreOnBoot({ ...cfg, stamp: process.env.RESTAURAR_RESPALDO });
if (restored) console.log(`Se restauró la copia ${restored.restored}. Las bases que había quedaron en la copia ${restored.previous}.`);
if (process.env.BACKUP_DISABLED !== '1') backup.scheduleDaily(cfg);
