'use strict';

const path = require('node:path');
const express = require('express');
const { getSetting } = require('../db');
const { fail } = require('../util');
const D = require('../delivery');
const { sendStored, uploadedType, saveReservationFile, saveCustomerDocument, MAX_PDF } = require('./files');

/** Páginas del cliente sin usuario: firmar el contrato, ver las fotos de la entrega, subir las de la devolución y dejar la tarjeta. El código del link es la llave. */
function deliveryPublicRoutes(db, uploadsDir) {
  const router = express.Router();
  router.get('/contrato/:token', (req, res) => res.json(D.viewContract(db, req.params.token)));
  router.post('/contrato/:token', (req, res) => res.json(D.sign(db, req.params.token, req.body || {}, { ip: req.ip, userAgent: req.get('user-agent') })));
  router.get('/tarjeta/:token', (req, res) => res.json(D.viewCard(db, req.params.token)));
  router.post('/tarjeta/:token', (req, res) => res.json(D.saveCard(db, req.params.token, req.body || {}, { ip: req.ip })));
  router.get('/fotos/:token', (req, res) => {
    const { code, files, left_place, condition } = D.deliveryPhotos(db, req.params.token);
    res.json({ company: getSetting(db, 'company_name') || '', code, left_place, condition, photos: files.map((f) => ({ id: f.id, name: f.name })) });
  });
  // Datos y fotos de documentos que el cliente carga antes de retirar (reserva express).
  router.get('/datos/:token', (req, res) => res.json(D.viewDocs(db, req.params.token)));
  router.post('/datos/:token', (req, res) => res.json(D.saveDocs(db, req.params.token, req.body || {})));
  router.post(
    '/datos/:token/foto',
    (req, _res, next) => {
      D.docsUploadTarget(db, req.params.token, req.query.kind); // antes de leer el archivo
      next();
    },
    express.raw({ type: () => true, limit: MAX_PDF }),
    (req, res) => {
      const r = D.docsUploadTarget(db, req.params.token, req.query.kind);
      const mime = uploadedType(req);
      if (!mime.startsWith('image/')) fail(415, 'Subí una foto (JPG, PNG o HEIC)');
      // Va a la ficha del cliente (sirve para sus próximas reservas); subir otra foto del mismo lado reemplaza la anterior.
      const file = saveCustomerDocument(db, uploadsDir, r.customer_id, { kind: req.query.kind, mime, body: req.body });
      res.status(201).json({ id: file.id });
    },
  );
  router.get('/devolucion/:token', (req, res) => res.json(D.viewReturn(db, req.params.token)));
  router.post(
    '/devolucion/:token',
    (req, _res, next) => {
      D.returnUploadTarget(db, req.params.token); // antes de leer el archivo
      next();
    },
    express.raw({ type: () => true, limit: MAX_PDF }),
    (req, res) => {
      const r = D.returnUploadTarget(db, req.params.token);
      const mime = uploadedType(req);
      if (!mime.startsWith('image/')) fail(415, 'Subí fotos del auto (JPG, PNG o HEIC)');
      const name = `Cliente: ${String(req.query.name || 'foto').replace(/[\\/\r\n]/g, '_').slice(0, 100)}`;
      const file = saveReservationFile(db, uploadsDir, r.id, { stage: 'devolucion', name, mime, body: req.body });
      res.status(201).json({ id: file.id });
    },
  );
  router.get('/fotos/:token/:id', (req, res) => {
    const f = D.deliveryPhotos(db, req.params.token).files.find((x) => x.id === Number(req.params.id));
    if (!f) fail(404, 'Foto inexistente');
    sendStored(res, path.join(uploadsDir, f.path), f);
  });
  return router;
}

module.exports = { deliveryPublicRoutes };
