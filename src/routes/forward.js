'use strict';

// GET /forward/latest
//
// Read-only window into the ETH 1D Compression Breakout forward-validation
// runner's most recent output. The file is produced by:
//
//   npx tsx scripts/forwardValidationEth1d.ts
//
// This route does NOT execute strategy logic, fetch market data, or place
// any trade. It just serves the JSON snapshot the runner already wrote to
// disk. Bearer-auth protected (mounted under the global auth middleware).

const express = require('express');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');

const router = express.Router();

const LATEST_PATH = path.join(config.dataDir, 'forward', 'latest.json');

router.get('/latest', (_req, res) => {
  if (!fs.existsSync(LATEST_PATH)) {
    return res.status(404).json({
      ok: false,
      code: 'NOT_FOUND',
      reason:
        'Forward-validation snapshot not generated yet. Run `npx tsx scripts/forwardValidationEth1d.ts` to produce it.',
    });
  }

  let raw;
  try {
    raw = fs.readFileSync(LATEST_PATH, 'utf8');
  } catch (err) {
    return res.status(500).json({
      ok: false,
      code: 'INTERNAL_ERROR',
      reason: `Could not read forward-validation snapshot: ${err.message}`,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      code: 'INTERNAL_ERROR',
      reason: `Forward-validation snapshot is malformed JSON: ${err.message}`,
    });
  }

  return res.json({ ok: true, ...parsed });
});

module.exports = router;
