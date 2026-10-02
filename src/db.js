'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operador',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  aliases TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT,
  daily_rate REAL NOT NULL DEFAULT 0,
  weekly_rate REAL NOT NULL DEFAULT 0,
  deposit REAL NOT NULL DEFAULT 0,
  km_per_day INTEGER NOT NULL DEFAULT 0,
  extra_km_rate REAL NOT NULL DEFAULT 0,
  seats INTEGER,
  transmission TEXT,
  aliases TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS extras (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  charge_type TEXT NOT NULL DEFAULT 'dia',
  max_price REAL NOT NULL DEFAULT 0,
  aliases TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY,
  plate TEXT NOT NULL UNIQUE COLLATE NOCASE,
  brand TEXT,
  model TEXT,
  year INTEGER,
  color TEXT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  branch_id INTEGER REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'disponible',
  km INTEGER NOT NULL DEFAULT 0,
  fuel INTEGER NOT NULL DEFAULT 8,
  insurance_expiry TEXT,
  vtv_expiry TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  doc_type TEXT DEFAULT 'DNI',
  doc_number TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  birth_date TEXT,
  license_number TEXT,
  license_expiry TEXT,
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  pickup_branch_id INTEGER REFERENCES branches(id),
  return_branch_id INTEGER REFERENCES branches(id),
  pickup_at TEXT NOT NULL,
  return_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendiente',
  source TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT,
  days INTEGER,
  pricing TEXT,
  total REAL NOT NULL DEFAULT 0,
  deposit REAL NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  flight TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_reservations_external ON reservations(source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_reservations_dates ON reservations(pickup_at, return_at);

CREATE TABLE IF NOT EXISTS reservation_extras (
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  extra_id INTEGER NOT NULL REFERENCES extras(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (reservation_id, extra_id)
);

CREATE TABLE IF NOT EXISTS reservation_log (
  id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  at TEXT DEFAULT CURRENT_TIMESTAMP,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL UNIQUE REFERENCES reservations(id) ON DELETE CASCADE,
  number TEXT UNIQUE,
  out_at TEXT, out_km INTEGER, out_fuel INTEGER, out_notes TEXT, out_user INTEGER,
  in_at TEXT, in_km INTEGER, in_fuel INTEGER, in_notes TEXT, in_user INTEGER,
  damages TEXT,
  charges TEXT,
  final_total REAL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'pago',
  method TEXT,
  amount REAL NOT NULL,
  reference TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS maintenance (
  id INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  kind TEXT,
  description TEXT,
  start_date TEXT,
  end_date TEXT,
  km INTEGER,
  cost REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'abierto'
);

CREATE TABLE IF NOT EXISTS quote_inbox (
  id INTEGER PRIMARY KEY,
  received_at TEXT DEFAULT CURRENT_TIMESTAMP,
  external_id TEXT,
  payload TEXT,
  status TEXT,
  message TEXT,
  reservation_id INTEGER,
  channel TEXT NOT NULL DEFAULT 'cotizador'
);

CREATE TABLE IF NOT EXISTS reservation_files (
  id INTEGER PRIMARY KEY,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'otro',
  name TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_reservation_files ON reservation_files(reservation_id);

CREATE TABLE IF NOT EXISTS webhook_log (
  id INTEGER PRIMARY KEY,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  event TEXT,
  url TEXT,
  status INTEGER,
  response TEXT
);
`;

const DEFAULT_MAPPING = {
  external_id: 'id',
  'customer.full_name': 'customer.full_name',
  'customer.doc_type': 'customer.doc_type',
  'customer.doc_number': 'customer.doc_number',
  'customer.email': 'customer.email',
  'customer.phone': 'customer.phone',
  'customer.license_number': 'customer.license_number',
  category_code: 'category_code',
  pickup_at: 'pickup_at',
  pickup_time: 'pickup_time',
  return_at: 'return_at',
  return_time: 'return_time',
  pickup_branch: 'pickup_branch',
  return_branch: 'return_branch',
  extras: 'extras',
  total: 'total',
  flight: 'flight',
  notes: 'notes',
};

/**
 * Mapeo inicial para el formulario de cotización del sitio web (campos típicos en español).
 * Se ajusta desde la pantalla Cotizador → Formulario web según los "name" reales del formulario.
 */
const WEBFORM_MAPPING = {
  'customer.full_name': 'nombre',
  'customer.email': 'email',
  'customer.phone': 'telefono',
  'customer.doc_number': 'dni',
  category_code: 'vehiculo',
  pickup_at: 'fecha_retiro',
  pickup_time: 'hora_retiro',
  return_at: 'fecha_devolucion',
  return_time: 'hora_devolucion',
  pickup_branch: 'lugar_retiro',
  return_branch: 'lugar_devolucion',
  extras: 'adicionales',
  flight: 'vuelo',
  notes: 'comentarios',
};

const DEFAULT_SETTINGS = {
  company_name: 'Mi Rent a Car',
  company_tax_id: '',
  company_address: '',
  company_phone: '',
  currency: 'ARS',
  tax_rate: '21',
  prices_include_tax: '1',
  grace_hours: '2',
  one_way_fee: '0',
  fuel_charge_per_eighth: '0',
  min_driver_age: '21',
  contract_terms:
    'El cliente declara recibir el vehículo en las condiciones detalladas y se compromete a devolverlo en el mismo estado, en la fecha, hora y lugar pactados.',
  // Integración con cotizador
  api_key: '',
  quote_mapping: JSON.stringify(DEFAULT_MAPPING, null, 2),
  quote_price_source: 'cotizador', // 'cotizador' respeta el total recibido, 'sistema' recalcula con las tarifas
  quote_auto_confirm: '0',
  webhook_url: '',
  webhook_secret: '',
  // Formulario web (ej. el cotizador de discoverushuaia.com.ar)
  webform_enabled: '1',
  webform_mapping: JSON.stringify(WEBFORM_MAPPING, null, 2),
  webform_allowed_origins: 'https://www.discoverushuaia.com.ar,https://discoverushuaia.com.ar',
  webform_redirect_url: '',
};

function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'rentacar.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  if (!getSetting(db, 'api_key')) setSetting(db, 'api_key', newApiKey());
  if (!getSetting(db, 'webhook_secret')) setSetting(db, 'webhook_secret', crypto.randomBytes(24).toString('hex'));
  return db;
}

const newApiKey = () => 'rk_' + crypto.randomBytes(24).toString('hex');

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value === null || value === undefined ? '' : String(value),
  );
}

module.exports = { openDb, getSetting, getSettings, setSetting, newApiKey, DEFAULT_MAPPING, WEBFORM_MAPPING, DEFAULT_SETTINGS };
