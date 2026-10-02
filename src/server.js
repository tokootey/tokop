'use strict';

const { openDb } = require('./db');
const { createApp, ensureAdmin } = require('./app');

const db = openDb();
const created = ensureAdmin(db);
const port = Number(process.env.PORT) || 3000;

createApp(db).listen(port, () => {
  console.log(`Rent a car listo en http://localhost:${port}`);
  if (created) console.log(`Usuario inicial: ${created.email} / ${created.password}  (cambiá la contraseña desde Usuarios)`);
});
