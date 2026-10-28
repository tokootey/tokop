'use strict';

const path = require('node:path');
const { openDb } = require('./db');
const { createApp, ensureAdmin } = require('./app');
const { openPlatform } = require('./platform');
const { seedDemo } = require('./seed');

const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'rentacar.db');
const db = openDb(dbFile);
const created = ensureAdmin(db);
// DEMO_DATA=1: una base vacía arranca con datos de muestra y un usuario de prueba, para mostrarla a clientes.
if (process.env.DEMO_DATA === '1') seedDemo(db, { email: process.env.DEMO_EMAIL, password: process.env.DEMO_PASSWORD });
// La base de siempre es la empresa principal; las demás empresas se agregan desde Ajustes → Empresas.
const platform = openPlatform(db, dbFile);
const port = Number(process.env.PORT) || 3000;

const server = createApp(db, { platform }).listen(port, () => {
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
