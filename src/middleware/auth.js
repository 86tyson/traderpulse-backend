'use strict';

const crypto = require('crypto');
const { config } = require('../config');

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function bearerAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) {
    return res
      .status(401)
      .json({ ok: false, code: 'UNAUTHENTICATED', reason: 'Missing Bearer token' });
  }
  const token = match[1].trim();
  if (!timingSafeEqualStr(token, config.backendApiKey)) {
    return res
      .status(401)
      .json({ ok: false, code: 'UNAUTHENTICATED', reason: 'Invalid Bearer token' });
  }
  return next();
}

module.exports = { bearerAuth };
