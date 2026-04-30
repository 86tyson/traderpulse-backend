'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { config } = require('./config');

const dataDir = path.resolve(process.cwd(), config.dataDir);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath =
  process.env.NODE_ENV === 'test'
    ? ':memory:'
    : path.join(dataDir, 'trading.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recommendation_id TEXT UNIQUE NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    suggested_amount_usd REAL NOT NULL,
    confidence_score REAL NOT NULL,
    entry_reason TEXT,
    stop_loss REAL,
    profit_target REAL,
    invalidation_level REAL,
    risk_reward REAL,
    status TEXT NOT NULL,
    mode TEXT NOT NULL,
    simulated_pnl_usd REAL,
    robinhood_order_id TEXT,
    raw_request_json TEXT NOT NULL,
    raw_response_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    executed_at TEXT,
    exit_price REAL,
    exit_timestamp TEXT,
    outcome TEXT
  );

  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recommendation_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    code TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
  CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
  CREATE INDEX IF NOT EXISTS idx_trades_outcome ON trades(outcome);
  CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);
`);

// Idempotent migration for existing DBs that pre-date the close-event fields.
function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
ensureColumn('trades', 'exit_price', 'REAL');
ensureColumn('trades', 'exit_timestamp', 'TEXT');
ensureColumn('trades', 'outcome', 'TEXT');

// Phase 3 reconciliation: actual fill data sourced from Robinhood. Populated
// by services/reconciler.js — entry_price/filled_quantity/fill_timestamp can
// be NULL until the first reconciliation pass runs against the row.
ensureColumn('trades', 'entry_price', 'REAL');
ensureColumn('trades', 'filled_quantity', 'REAL');
ensureColumn('trades', 'fill_timestamp', 'TEXT');

module.exports = db;
