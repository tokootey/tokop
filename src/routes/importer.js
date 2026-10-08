'use strict';

const express = require('express');
const { requireAdmin, audit } = require('../auth');
const { analyze, runImport } = require('../importer');
const { fail } = require('../util');

/** Importación de datos de sistemas anteriores. Sólo administradores: maneja datos personales en bloque. */
function importRoutes(db) {
  const router = express.Router();
  router.use('/import', express.json({ limit: '12mb' }));

  router.post('/import/analyze', requireAdmin, (req, res) => {
    const { kind, text } = req.body || {};
    res.json(analyze(kind, text));
  });

  router.post('/import/run', requireAdmin, (req, res) => {
    const { kind, text, mapping, options } = req.body || {};
    if (mapping !== undefined && (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping))) fail(400, 'Mapeo inválido');
    const report = runImport(db, { kind, text, mapping: mapping || {}, options: options || {} }, req.user.id);
    if (!report.dry_run) {
      const c = report.counts;
      audit(db, req, 'importacion', `${kind}: ${report.total} filas · ${c.creado} nuevas · ${c.actualizado} actualizadas · ${c.omitido + c.sin_cambios} sin cambios · ${c.error} con error`);
    }
    res.json(report);
  });

  return router;
}

module.exports = { importRoutes };
