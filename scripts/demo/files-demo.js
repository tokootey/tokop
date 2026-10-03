'use strict';

/*
 * Versión de demo de src/routes/files.js: en el navegador no hay disco,
 * así que las fotos se guardan dentro de la misma base de datos (tabla demo_blobs).
 */
const express = require('express');
const { fail, nowLocal } = require('../util');

const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
};
const STAGES = ['entrega', 'devolucion', 'contrato', 'otro'];
const MAX_BYTES = 20 * 1024 * 1024;

function fileRoutes(db) {
  db.exec('CREATE TABLE IF NOT EXISTS demo_blobs (file_id INTEGER PRIMARY KEY, data BLOB)');
  const router = express.Router();
  const logAction = (reservationId, userId, action, detail) =>
    db.prepare('INSERT INTO reservation_log (reservation_id, user_id, action, detail) VALUES (?, ?, ?, ?)').run(reservationId, userId || null, action, detail);

  router.post('/reservations/:id/files', async (req, res, next) => {
    try {
      const r = db.prepare('SELECT id FROM reservations WHERE id = ?').get(Number(req.params.id));
      if (!r) fail(404, 'Reserva inexistente');
      const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!TYPES[mime]) fail(415, 'Formato no admitido: subí fotos (JPG, PNG, HEIC) o PDF');
      const bytes = new Uint8Array(await req.body.arrayBuffer());
      if (!bytes.length) fail(400, 'El archivo está vacío');
      if (bytes.length > MAX_BYTES) fail(413, 'El archivo es demasiado grande (máximo 20 MB)');
      const stage = STAGES.includes(req.query.stage) ? req.query.stage : 'otro';
      const name = String(req.query.name || `foto.${TYPES[mime]}`).slice(0, 120);
      const id = Number(
        db
          .prepare('INSERT INTO reservation_files (reservation_id, stage, name, mime, size, path, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(r.id, stage, name, mime, bytes.length, 'demo', req.user.id, nowLocal().replace('T', ' ')).lastInsertRowid,
      );
      db.prepare('INSERT INTO demo_blobs (file_id, data) VALUES (?, ?)').run(id, bytes);
      logAction(r.id, req.user.id, 'archivo_subido', `${stage}: ${name}`);
      res.status(201).json(db.prepare('SELECT id, stage, name, mime, size, created_at FROM reservation_files WHERE id = ?').get(id));
    } catch (err) {
      next(err);
    }
  });

  router.get('/reservations/:id/files', (req, res) => {
    res.json(db.prepare('SELECT id, stage, name, mime, size, created_at FROM reservation_files WHERE reservation_id = ? ORDER BY id').all(Number(req.params.id)));
  });

  router.get('/files/:id', (req, res) => {
    const f = db.prepare('SELECT * FROM reservation_files WHERE id = ?').get(Number(req.params.id));
    if (!f) fail(404, 'Archivo inexistente');
    const b = db.prepare('SELECT data FROM demo_blobs WHERE file_id = ?').get(f.id);
    if (!b) fail(404, 'El archivo ya no está disponible');
    res.set('Content-Type', f.mime);
    res.blob(new Blob([b.data], { type: f.mime }));
  });

  router.delete('/files/:id', (req, res) => {
    const f = db.prepare('SELECT * FROM reservation_files WHERE id = ?').get(Number(req.params.id));
    if (!f) fail(404, 'Archivo inexistente');
    db.prepare('DELETE FROM reservation_files WHERE id = ?').run(f.id);
    db.prepare('DELETE FROM demo_blobs WHERE file_id = ?').run(f.id);
    logAction(f.reservation_id, req.user.id, 'archivo_borrado', `${f.stage}: ${f.name}`);
    res.status(204).end();
  });

  return router;
}

module.exports = { fileRoutes, TYPES, STAGES };
