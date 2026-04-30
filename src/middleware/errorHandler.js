'use strict';

const logger = require('../services/logger');

function notFound(req, res) {
  res.status(404).json({ ok: false, code: 'NOT_FOUND', reason: `No route for ${req.method} ${req.path}` });
}

function errorHandler(err, req, res, _next) {
  logger.error({ err, path: req.path, method: req.method }, 'unhandled error');

  if (err && err.code === 'NOT_IMPLEMENTED') {
    return res.status(501).json({
      ok: false,
      code: 'NOT_IMPLEMENTED',
      reason: err.message || 'Not implemented yet',
    });
  }

  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, code: 'PAYLOAD_TOO_LARGE', reason: 'Request body too large' });
  }

  res.status(500).json({ ok: false, code: 'INTERNAL_ERROR', reason: 'Unexpected server error' });
}

module.exports = { notFound, errorHandler };
