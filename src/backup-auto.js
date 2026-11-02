'use strict';

/*
 * Copias de seguridad automáticas. `npm start` carga este archivo antes que la app (node --require),
 * así queda separado del arranque de src/server.js:
 *  - si está la variable RESTAURAR_RESPALDO, vuelve a esa copia antes de abrir las bases (una sola vez);
 *  - programa la copia diaria (salvo BACKUP_DISABLED=1) y, si Supabase está configurado, la sube ahí con las fotos.
 */
const path = require('node:path');
const backup = require('./backup');
const { offsiteConfig, syncOffsite } = require('./offsite');

const cfg = backup.backupConfig();
const restored = backup.restoreOnBoot({ ...cfg, stamp: process.env.RESTAURAR_RESPALDO });
if (restored) console.log(`Se restauró la copia ${restored.restored}. Las bases que había quedaron en la copia ${restored.previous}.`);

const remote = offsiteConfig();
const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.join(cfg.dataDir, 'uploads')); // la misma carpeta que usa src/app.js
const afterBackup =
  remote &&
  ((stamp) =>
    syncOffsite({ ...cfg, remote, uploadsDir, stamp }).then(
      (r) => console.log(`Copia ${r.stamp} subida a Supabase (${r.uploaded} archivos nuevos).`),
      (err) => console.error('No se pudo subir la copia a Supabase (la copia local está bien):', err.message),
    ));
if (process.env.BACKUP_DISABLED !== '1') backup.scheduleDaily({ ...cfg, afterBackup });
