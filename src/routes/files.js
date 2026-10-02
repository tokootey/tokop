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
const STAGES = ['entrega', 'devolucion', 'otro'];

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
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Fotos y documentación de cada alquiler (estado del auto en la entrega y en la devolución).
 * El archivo se envía tal cual en el cuerpo del POST, con su Content-Type; los datos van en la URL.
 */
function fileRoutes(db, uploadsDir) {
  const router = express.Router();

  const logAction = (reservationId, userId, action, detail) =>
    db.prepare('INSERT INTO reservation_log (reservation_id, user_id, action, detail) VALUES (?, ?, ?, ?)').run(reservationId, userId || null, action, detail);

  router.post('/reservations/:id/files', express.raw({ type: () => true, limit: MAX_BYTES }), (req, res) => {
    const r = db.prepare('SELECT id FROM reservations WHERE id = ?').get(Number(req.params.id));
    if (!r) fail(404, 'Reserva inexistente');
    const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!TYPES[mime]) fail(415, 'Formato no admitido: subí fotos (JPG, PNG, HEIC) o PDF');
    if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, 'El archivo está vacío');
    if (!looksLike(mime, req.body)) fail(415, 'El archivo no es una foto o un PDF válido');
    const stage = STAGES.includes(req.query.stage) ? req.query.stage : 'otro';
    const name = String(req.query.name || `foto.${TYPES[mime]}`).replace(/[\\/\r\n]/g, '_').slice(0, 120);

    const rel = path.join(String(r.id), `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${TYPES[mime]}`);
    const abs = path.join(uploadsDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, req.body);
    const id = Number(
      db
        .prepare('INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(r.id, stage, name, mime, req.body.length, rel, req.user.id, nowLocal().replace('T', ' ')).lastInsertRowid,
    );
    logAction(r.id, req.user.id, 'archivo_subido', `${stage}: ${name}`);
    res.status(201).json(db.prepare('SELECT id, stage, name, mime, size, created_at FROM reservation_files WHERE id = ?').get(id));
  });

  router.get('/reservations/:id/files', (req, res) => {
    res.json(
      db.prepare('SELECT id, stage, name, mime, size, created_at FROM reservation_files WHERE reservation_id = ? ORDER BY id').all(Number(req.params.id)),
    );
  });

  router.get('/files/:id', (req, res) => {
    const f = db.prepare('SELECT * FROM reservation_files WHERE id = ?').get(Number(req.params.id));
    if (!f) fail(404, 'Archivo inexistente');
    const abs = path.join(uploadsDir, f.path);
    if (!fs.existsSync(abs)) fail(404, 'El archivo ya no está en el servidor');
    res.set('Content-Type', f.mime);
    res.set('Cache-Control', 'private, no-store');
    // Se muestra aislado: un archivo manipulado no puede ejecutar código en la app.
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
    res.sendFile(abs);
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

  return router;
}

module.exports = { fileRoutes, looksLike, TYPES, STAGES };
