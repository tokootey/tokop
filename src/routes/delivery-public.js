'use strict';

const path = require('node:path');
const express = require('express');
const { getSetting } = require('../db');
const { fail } = require('../util');
const D = require('../delivery');
const { sendStored } = require('./files');

/** Páginas del cliente sin usuario: firmar el contrato y ver las fotos de la entrega. El código del link es la llave. */
function deliveryPublicRoutes(db, uploadsDir) {
  const router = express.Router();
  router.get('/contrato/:token', (req, res) => res.json(D.viewContract(db, req.params.token)));
  router.post('/contrato/:token', (req, res) => res.json(D.sign(db, req.params.token, req.body || {}, { ip: req.ip, userAgent: req.get('user-agent') })));
  router.get('/fotos/:token', (req, res) => {
    const { code, files } = D.deliveryPhotos(db, req.params.token);
    res.json({ company: getSetting(db, 'company_name') || '', code, photos: files.map((f) => ({ id: f.id, name: f.name })) });
  });
  router.get('/fotos/:token/:id', (req, res) => {
    const f = D.deliveryPhotos(db, req.params.token).files.find((x) => x.id === Number(req.params.id));
    if (!f) fail(404, 'Foto inexistente');
    sendStored(res, path.join(uploadsDir, f.path), f);
  });
  return router;
}

module.exports = { deliveryPublicRoutes };
