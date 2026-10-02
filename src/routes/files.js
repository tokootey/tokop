'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { fail, nowLocal } = require('../util');

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
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(f.name)}"`);
    res.sendFile(abs);
  });

  router.delete('/files/:id', (req, res) => {
    const f = db.prepare('SELECT * FROM reservation_files WHERE id = ?').get(Number(req.params.id));
    if (!f) fail(404, 'Archivo inexistente');
    db.prepare('DELETE FROM reservation_files WHERE id = ?').run(f.id);
    fs.rmSync(path.join(uploadsDir, f.path), { force: true });
    logAction(f.reservation_id, req.user.id, 'archivo_borrado', `${f.stage}: ${f.name}`);
    res.status(204).end();
  });

  return router;
}

module.exports = { fileRoutes, TYPES, STAGES };
