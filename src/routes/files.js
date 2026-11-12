'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { fail, nowLocal } = require('../util');
const { audit } = require('../auth');

/** Tipos aceptados: fotos de celular (incluidas las HEIC de iPhone) y PDF. */
const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
};
const STAGES = ['entrega', 'devolucion', 'contrato', 'otro'];

/** Comprueba por los primeros bytes que el archivo sea realmente del tipo que dice ser. */
function looksLike(mime, b) {
  const ascii = (from, to) => Buffer.from(b.subarray(from, to)).toString('latin1');
  switch (mime) {
    case 'image/jpeg':
      return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png':
      return ascii(0, 8) === '\x89PNG\r\n\x1a\n';
    case 'image/webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'image/heic':
    case 'image/heif':
      return ascii(4, 8) === 'ftyp';
    case 'application/pdf':
      return ascii(0, 5) === '%PDF-';
    default:
      return false;
  }
}
// El panel achica las fotos antes de mandarlas (~250 KB); 1 MB deja margen. Los PDF de contratos van aparte.
const MAX_PHOTO = 1024 * 1024;
const MAX_PDF = 10 * 1024 * 1024;

/** Valida el archivo recibido (tipo declarado, que lo sea de verdad y tamaño) y devuelve su tipo. */
function uploadedType(req) {
  const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!TYPES[mime]) fail(415, 'Formato no admitido: subí fotos (JPG, PNG, HEIC) o PDF');
  if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, 'El archivo está vacío');
  if (!looksLike(mime, req.body)) fail(415, 'El archivo no es una foto o un PDF válido');
  if (mime !== 'application/pdf' && req.body.length > MAX_PHOTO) {
    fail(413, 'La foto pesa más de 1 MB. Subila desde el panel, que la achica sola.');
  }
  return mime;
}

// Documentos de la persona (no del alquiler): se cargan una vez y sirven para todas sus reservas.
// "conductor": la licencia de otra persona que también maneja; puede haber varios, cada uno con su nombre.
const DOC_KINDS = ['carnet_frente', 'carnet_dorso', 'dni_frente', 'dni_dorso', 'pasaporte', 'conductor'];
const MAX_DRIVERS = 10;

/** Borra los documentos de un cliente (al anonimizarlo o borrarlo): las filas y los archivos. */
function removeCustomerDocuments(db, uploadsDir, customerId) {
  db.prepare('DELETE FROM customer_files WHERE customer_id = ?').run(Number(customerId));
  fs.rmSync(path.join(uploadsDir, 'clientes', String(Number(customerId))), { recursive: true, force: true });
}

/** Manda un archivo guardado, aislado: un archivo manipulado no puede ejecutar código en la app. */
function sendStored(res, abs, f) {
  if (!fs.existsSync(abs)) fail(404, 'El archivo ya no está en el servidor');
  res.set('Content-Type', f.mime);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
  res.sendFile(path.resolve(abs)); // la carpeta puede venir relativa (DB_FILE relativo)
}

/** Guarda un documento ya validado en la ficha del cliente; uno por lugar: subir otro reemplaza al anterior (salvo los de otros conductores). userId vacío: lo subió el cliente con su link. */
function saveCustomerDocument(db, uploadsDir, customerId, { kind, name, mime, body, userId }) {
  const rel = path.join('clientes', String(customerId), `${kind}-${crypto.randomBytes(6).toString('hex')}.${TYPES[mime]}`);
  const abs = path.join(uploadsDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  const old = kind !== 'conductor' && db.prepare('SELECT * FROM customer_files WHERE customer_id = ? AND kind = ?').get(customerId, kind);
  if (old) {
    db.prepare('DELETE FROM customer_files WHERE id = ?').run(old.id);
    fs.rmSync(path.join(uploadsDir, old.path), { force: true });
  }
  const id = Number(
    db
      .prepare('INSERT INTO customer_files (customer_id, kind, name, mime, size, path, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(customerId, kind, name || `${kind}.${TYPES[mime]}`, mime, body.length, rel, userId || null, nowLocal().replace('T', ' ')).lastInsertRowid,
  );
  return db.prepare('SELECT id, kind, name, mime, size, created_at FROM customer_files WHERE id = ?').get(id);
}

/** Guarda un archivo ya validado en la reserva y lo deja en su historial. userId vacío: lo subió el cliente con su link. */
function saveReservationFile(db, uploadsDir, reservationId, { stage, name, mime, body, userId }) {
  const rel = path.join(String(reservationId), `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${TYPES[mime]}`);
  const abs = path.join(uploadsDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  const id = Number(
    db
      .prepare('INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(reservationId, stage, name, mime, body.length, rel, userId || null, nowLocal().replace('T', ' ')).lastInsertRowid,
  );
  db.prepare('INSERT INTO reservation_log (reservation_id, user_id, action, detail) VALUES (?, ?, ?, ?)').run(reservationId, userId || null, 'archivo_subido', `${stage}: ${name}`);
  return db.prepare('SELECT id, stage, name, mime, size, created_at FROM reservation_files WHERE id = ?').get(id);
}

/**
 * Fotos y documentación de cada alquiler (estado del auto en la entrega y en la devolución).
 * El archivo se envía tal cual en el cuerpo del POST, con su Content-Type; los datos van en la URL.
 */
function fileRoutes(db, uploadsDir) {
  const router = express.Router();

  const logAction = (reservationId, userId, action, detail) =>
    db.prepare('INSERT INTO reservation_log (reservation_id, user_id, action, detail) VALUES (?, ?, ?, ?)').run(reservationId, userId || null, action, detail);

  router.post('/reservations/:id/files', express.raw({ type: () => true, limit: MAX_PDF }), (req, res) => {
    const r = db.prepare('SELECT id FROM reservations WHERE id = ?').get(Number(req.params.id));
    if (!r) fail(404, 'Reserva inexistente');
    const mime = uploadedType(req);
    const stage = STAGES.includes(req.query.stage) ? req.query.stage : 'otro';
    const name = String(req.query.name || `foto.${TYPES[mime]}`).replace(/[\\/\r\n]/g, '_').slice(0, 120);
    res.status(201).json(saveReservationFile(db, uploadsDir, r.id, { stage, name, mime, body: req.body, userId: req.user.id }));
  });

  router.get('/reservations/:id/files', (req, res) => {
    res.json(
      db.prepare('SELECT id, stage, name, mime, size, created_at FROM reservation_files WHERE reservation_id = ? ORDER BY id').all(Number(req.params.id)),
    );
  });

  router.get('/files/:id', (req, res) => {
    const f = db.prepare('SELECT * FROM reservation_files WHERE id = ?').get(Number(req.params.id));
    if (!f) fail(404, 'Archivo inexistente');
    sendStored(res, path.join(uploadsDir, f.path), f);
  });

  router.delete('/files/:id', (req, res) => {
    const f = db.prepare('SELECT * FROM reservation_files WHERE id = ?').get(Number(req.params.id));
    if (!f) fail(404, 'Archivo inexistente');
    db.prepare('DELETE FROM reservation_files WHERE id = ?').run(f.id);
    fs.rmSync(path.join(uploadsDir, f.path), { force: true });
    logAction(f.reservation_id, req.user.id, 'archivo_borrado', `${f.stage}: ${f.name}`);
    audit(db, req, 'archivo_borrado', `reserva #${f.reservation_id}: ${f.name}`);
    res.status(204).end();
  });

  // Carnet, DNI o cédula y pasaporte del cliente: uno por lugar (frente y dorso); subir otro reemplaza al anterior. Los otros conductores se suman.
  const docOf = (id) => db.prepare('SELECT * FROM customer_files WHERE id = ?').get(Number(id));
  router.post('/customers/:id/documents', express.raw({ type: () => true, limit: MAX_PDF }), (req, res) => {
    const c = db.prepare('SELECT id, anonymized_at FROM customers WHERE id = ?').get(Number(req.params.id));
    if (!c) fail(404, 'Cliente inexistente');
    if (c.anonymized_at) fail(409, 'El cliente está anonimizado');
    const kind = req.query.kind;
    if (!DOC_KINDS.includes(kind)) fail(400, 'Documento inválido');
    const driver = kind === 'conductor';
    if (driver && String(req.query.name || '').trim().length < 3) fail(400, 'Escribí el nombre del conductor');
    if (driver && db.prepare("SELECT COUNT(*) AS n FROM customer_files WHERE customer_id = ? AND kind = 'conductor'").get(c.id).n >= MAX_DRIVERS) {
      fail(409, `Ya hay ${MAX_DRIVERS} conductores cargados`);
    }
    const mime = uploadedType(req);
    const name = String(req.query.name || `${kind}.${TYPES[mime]}`).replace(/[\\/\r\n]/g, '_').slice(0, 120);
    const file = saveCustomerDocument(db, uploadsDir, c.id, { kind, name, mime, body: req.body, userId: req.user.id });
    audit(db, req, 'documento_subido', `cliente #${c.id}: ${kind}`);
    res.status(201).json(file);
  });

  router.get('/customers/:id/documents', (req, res) => {
    res.json(db.prepare('SELECT id, kind, name, mime, size, created_at FROM customer_files WHERE customer_id = ? ORDER BY id').all(Number(req.params.id)));
  });

  router.get('/documents/:id', (req, res) => {
    const f = docOf(req.params.id);
    if (!f) fail(404, 'Archivo inexistente');
    sendStored(res, path.join(uploadsDir, f.path), f);
  });

  router.delete('/documents/:id', (req, res) => {
    const f = docOf(req.params.id);
    if (!f) fail(404, 'Archivo inexistente');
    db.prepare('DELETE FROM customer_files WHERE id = ?').run(f.id);
    fs.rmSync(path.join(uploadsDir, f.path), { force: true });
    audit(db, req, 'documento_borrado', `cliente #${f.customer_id}: ${f.kind}`);
    res.status(204).end();
  });

  return router;
}

module.exports = { fileRoutes, sendStored, uploadedType, saveReservationFile, saveCustomerDocument, MAX_PDF, looksLike, TYPES, STAGES, DOC_KINDS, removeCustomerDocuments };
