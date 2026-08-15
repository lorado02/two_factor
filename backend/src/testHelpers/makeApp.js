/**
 * makeApp — creates an isolated Express app backed by a fresh in-memory
 * SQLite database.  Safe to call in every test (or beforeEach).
 * Does NOT start an HTTP server, does NOT touch the on-disk bank.db.
 */
'use strict';

const Database = require('better-sqlite3');
const express = require('express');

function makeApp() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      twofa_enabled INTEGER NOT NULL DEFAULT 0,
      twofa_secret TEXT,
      account_locked INTEGER NOT NULL DEFAULT 0,
      failed_2fa_attempts INTEGER NOT NULL DEFAULT 0,
      failed_2fa_window_start TEXT,
      phone_number TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      account_number TEXT NOT NULL UNIQUE,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_account_id INTEGER REFERENCES accounts(id),
      to_account_id INTEGER REFERENCES accounts(id),
      amount_cents INTEGER NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS backup_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      code_hash TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      actor_id INTEGER REFERENCES users(id),
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sms_otp (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      otp_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth.factory')(db));
  app.use('/api/accounts', require('../routes/accounts.factory')(db));
  app.use('/api/transfer', require('../routes/transfer.factory')(db));
  app.use('/api/admin', require('../routes/admin.factory')(db));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  return { app, db };
}

module.exports = makeApp;
