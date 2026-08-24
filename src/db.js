import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });

export const db = new Database(config.databaseFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,
  email             TEXT    NOT NULL,
  email_lower       TEXT    NOT NULL UNIQUE,
  username          TEXT    NOT NULL,
  username_lower    TEXT    NOT NULL UNIQUE,
  display_name      TEXT    NOT NULL,
  avatar_url        TEXT,
  password_hash     TEXT,
  google_id         TEXT UNIQUE,
  email_verified    INTEGER NOT NULL DEFAULT 0,
  currency          TEXT    NOT NULL DEFAULT 'USD',
  discoverable      INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connections (
  id            INTEGER PRIMARY KEY,
  requester_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT    NOT NULL CHECK (status IN ('pending','accepted','declined','blocked')),
  origin        TEXT    NOT NULL DEFAULT 'username' CHECK (origin IN ('username','qr','link')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  responded_at  TEXT,
  UNIQUE (requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_connections_addressee ON connections(addressee_id, status);
CREATE INDEX IF NOT EXISTS idx_connections_requester ON connections(requester_id, status);

-- Short-lived codes rendered as a QR image so another user can connect by scanning.
CREATE TABLE IF NOT EXISTS connect_tokens (
  id           INTEGER PRIMARY KEY,
  token        TEXT    NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TEXT    NOT NULL,
  used_at      TEXT,
  used_by_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_connect_tokens_user ON connect_tokens(user_id);

CREATE TABLE IF NOT EXISTS accounts (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  type         TEXT    NOT NULL CHECK (type IN ('checking','savings','cash','credit','investment')),
  currency     TEXT    NOT NULL DEFAULT 'USD',
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id, archived);

-- An account can be shared with a connected user, read-only or read-write.
CREATE TABLE IF NOT EXISTS account_shares (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT    NOT NULL CHECK (role IN ('viewer','editor')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_account_shares_user ON account_shares(user_id);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('income','expense')),
  color       TEXT    NOT NULL DEFAULT '#6366f1',
  icon        TEXT    NOT NULL DEFAULT 'tag',
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, name, kind)
);

CREATE TABLE IF NOT EXISTS transactions (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  created_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Positive for income, negative for expense. Transfers are two rows sharing a group.
  amount_cents  INTEGER NOT NULL,
  type          TEXT    NOT NULL CHECK (type IN ('income','expense','transfer')),
  description   TEXT    NOT NULL,
  notes         TEXT,
  occurred_on   TEXT    NOT NULL,
  transfer_group TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_transactions_group ON transactions(transfer_group);

CREATE TABLE IF NOT EXISTS budgets (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  period       TEXT    NOT NULL,          -- 'YYYY-MM'
  amount_cents INTEGER NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, category_id, period)
);
CREATE INDEX IF NOT EXISTS idx_budgets_user_period ON budgets(user_id, period);

CREATE TABLE IF NOT EXISTS goals (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  target_cents  INTEGER NOT NULL,
  saved_cents   INTEGER NOT NULL DEFAULT 0,
  target_date   TEXT,
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id, archived);

CREATE TABLE IF NOT EXISTS recurring_rules (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  description   TEXT    NOT NULL,
  amount_cents  INTEGER NOT NULL,
  type          TEXT    NOT NULL CHECK (type IN ('income','expense')),
  cadence       TEXT    NOT NULL CHECK (cadence IN ('weekly','biweekly','monthly','yearly')),
  next_run_on   TEXT    NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recurring_user ON recurring_rules(user_id, active);
`;

db.exec(SCHEMA);

export function tx(fn) {
  return db.transaction(fn);
}
