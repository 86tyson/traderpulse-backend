'use strict';

// systemSettings — generic key/value store for admin-controlled runtime
// flags. Backed by the `system_settings` table. Single-process synchronous
// writes via better-sqlite3 (no race conditions in this codebase since
// Express handlers run on a single Node thread).
//
// DO NOT store secrets in here. The DB file is not encrypted at rest beyond
// whatever Railway volume protection applies. Secrets stay in env vars.

const db = require('../db');

const getStmt = db.prepare(
  'SELECT value, updated_at FROM system_settings WHERE key = ?',
);
const upsertStmt = db.prepare(`
  INSERT INTO system_settings (key, value, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);

function get(key) {
  const row = getStmt.get(key);
  if (!row) return null;
  return { value: row.value, updatedAt: row.updated_at };
}

function set(key, value) {
  if (typeof value !== 'string') {
    throw new TypeError(`systemSettings.set: value must be string, got ${typeof value}`);
  }
  upsertStmt.run(key, value);
  return get(key);
}

module.exports = { get, set };
