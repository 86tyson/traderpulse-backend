'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

const ALLOWED_STATUS = new Set(['simulated', 'executed', 'rejected']);
const ALLOWED_MODE = new Set(['paper', 'live']);

router.get('/', (req, res) => {
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 100;

  const filters = [];
  const params = [];
  if (req.query.status && ALLOWED_STATUS.has(String(req.query.status))) {
    filters.push('status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.mode && ALLOWED_MODE.has(String(req.query.mode))) {
    filters.push('mode = ?');
    params.push(String(req.query.mode));
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT id, recommendation_id, symbol, side, suggested_amount_usd, confidence_score,
              entry_reason, stop_loss, profit_target, invalidation_level, risk_reward,
              status, mode, simulated_pnl_usd, robinhood_order_id,
              strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at,
              executed_at,
              exit_price, exit_timestamp, outcome
       FROM trades
       ${where}
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(...params, limit);

  res.json({ ok: true, count: rows.length, trades: rows });
});

module.exports = router;
