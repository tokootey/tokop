'use strict';

const { openDb } = require('./db');
const { createApp, ensureAdmin } = require('./app');

const db = openDb();
const created = ensureAdmin(db);
const port = Number(process.env.PORT) || 3000;

const server = createApp(db).listen(port, () => {
  console.log(`Rent a car listo en http://localhost:${port}`);
  if (created) console.log(`Usuario inicial: ${created.email} / ${created.password}  (cambiá la contraseña desde Usuarios)`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error('*** Ya hay otra copia de la app abierta (el puerto ' + port + ' está ocupado). ***');
    console.error('Cerrá todas las ventanas negras de la app y volvé a abrir iniciar-windows.');
    console.error('');
    process.exit(1);
  }
  throw err;
});
