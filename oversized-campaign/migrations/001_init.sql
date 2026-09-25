-- Players are anonymous until they choose to verify an email address or link
-- their Shopify customer account. `merged_into` points at the surviving
-- profile after a verified merge; sessions of the old profile follow it.
CREATE TABLE players (
  id                   TEXT PRIMARY KEY,
  created_at           TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  alias                TEXT,
  alias_lower          TEXT UNIQUE,
  leaderboard_opt_in   INTEGER NOT NULL DEFAULT 0,
  alias_hidden         INTEGER NOT NULL DEFAULT 0,
  email                TEXT,
  email_lower          TEXT UNIQUE,
  email_verified_at    TEXT,
  shopify_customer_id  TEXT UNIQUE,
  customer_verified_at TEXT,
  marketing_opt_in     INTEGER NOT NULL DEFAULT 0,
  marketing_opt_in_at  TEXT,
  merged_into          TEXT REFERENCES players(id),
  best_score           INTEGER NOT NULL DEFAULT 0,
  best_round_id        TEXT,
  rounds_played        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_players_best ON players(best_score DESC) WHERE merged_into IS NULL;

-- Only a SHA-256 of each session token is stored, so a database leak does not
-- hand out working sessions.
CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id),
  transport     TEXT NOT NULL CHECK (transport IN ('cookie', 'header')),
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
);
CREATE INDEX idx_sessions_player ON sessions(player_id);

CREATE TABLE campaigns (
  id                   INTEGER PRIMARY KEY,
  name                 TEXT NOT NULL,
  active               INTEGER NOT NULL DEFAULT 0,
  starts_at            TEXT,
  ends_at              TEXT,
  tiers_json           TEXT NOT NULL,
  code_prefix          TEXT NOT NULL DEFAULT 'OVS',
  code_valid_days      INTEGER NOT NULL DEFAULT 14,
  minimum_subtotal     TEXT,
  product_ids_json     TEXT NOT NULL DEFAULT '[]',
  collection_ids_json  TEXT NOT NULL DEFAULT '[]',
  combine_order        INTEGER NOT NULL DEFAULT 0,
  combine_product      INTEGER NOT NULL DEFAULT 0,
  combine_shipping     INTEGER NOT NULL DEFAULT 1,
  require_verified     INTEGER NOT NULL DEFAULT 1,
  restrict_to_customer INTEGER NOT NULL DEFAULT 1,
  leaderboard_enabled  INTEGER NOT NULL DEFAULT 1,
  updated_at           TEXT NOT NULL
);

CREATE TABLE rounds (
  id             TEXT PRIMARY KEY,
  player_id      TEXT NOT NULL REFERENCES players(id),
  campaign_id    INTEGER REFERENCES campaigns(id),
  seed           INTEGER NOT NULL,
  rules_version  INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('open', 'verified', 'rejected', 'expired')),
  started_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  submitted_at   TEXT,
  score          INTEGER,
  approved_reps  INTEGER,
  clean_reps     INTEGER,
  top_kg         REAL,
  avg_quality    REAL,
  events_json    TEXT,
  result_json    TEXT,
  reject_reason  TEXT,
  flags          TEXT,
  ip_hash        TEXT
);
CREATE INDEX idx_rounds_player ON rounds(player_id, started_at DESC);
CREATE INDEX idx_rounds_open ON rounds(player_id) WHERE status = 'open';

-- One reward per player per campaign. The UNIQUE constraint is what makes
-- issuing idempotent under concurrent requests.
CREATE TABLE rewards (
  id                   TEXT PRIMARY KEY,
  campaign_id          INTEGER NOT NULL REFERENCES campaigns(id),
  player_id            TEXT NOT NULL REFERENCES players(id),
  round_id             TEXT NOT NULL REFERENCES rounds(id),
  score                INTEGER NOT NULL,
  percent              INTEGER NOT NULL,
  code                 TEXT NOT NULL UNIQUE,
  demo                 INTEGER NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('pending', 'issued', 'failed')),
  shopify_discount_id  TEXT,
  shopify_customer_id  TEXT,
  identity             TEXT,
  starts_at            TEXT NOT NULL,
  ends_at              TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  last_error           TEXT,
  created_at           TEXT NOT NULL,
  issued_at            TEXT,
  UNIQUE (campaign_id, player_id)
);
CREATE UNIQUE INDEX idx_rewards_identity ON rewards(campaign_id, identity) WHERE identity IS NOT NULL;

CREATE TABLE orders (
  shopify_order_id    TEXT PRIMARY KEY,
  admin_graphql_id    TEXT,
  name                TEXT,
  financial_status    TEXT,
  currency            TEXT,
  total_price         TEXT,
  customer_id         TEXT,
  shopify_updated_at  TEXT,
  received_at         TEXT NOT NULL
);

CREATE TABLE redemptions (
  id                INTEGER PRIMARY KEY,
  reward_id         TEXT NOT NULL REFERENCES rewards(id),
  shopify_order_id  TEXT NOT NULL,
  code              TEXT NOT NULL,
  amount            TEXT,
  currency          TEXT,
  redeemed_at       TEXT NOT NULL,
  UNIQUE (reward_id, shopify_order_id)
);

-- Refunds are recorded on their own. They never make a used code valid again.
CREATE TABLE refunds (
  shopify_refund_id  TEXT PRIMARY KEY,
  shopify_order_id   TEXT NOT NULL,
  amount             TEXT,
  currency           TEXT,
  refunded_at        TEXT,
  received_at        TEXT NOT NULL
);
CREATE INDEX idx_refunds_order ON refunds(shopify_order_id);

CREATE TABLE webhook_events (
  event_id      TEXT PRIMARY KEY,
  webhook_id    TEXT,
  topic         TEXT NOT NULL,
  shop          TEXT,
  triggered_at  TEXT,
  received_at   TEXT NOT NULL
);

CREATE TABLE integration_errors (
  id           INTEGER PRIMARY KEY,
  source       TEXT NOT NULL,
  message      TEXT NOT NULL,
  details_json TEXT,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);

CREATE TABLE email_tokens (
  token_hash   TEXT PRIMARY KEY,
  player_id    TEXT NOT NULL REFERENCES players(id),
  email        TEXT NOT NULL,
  email_lower  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT
);
CREATE INDEX idx_email_tokens_player ON email_tokens(player_id, created_at);
CREATE INDEX idx_email_tokens_email ON email_tokens(email_lower, created_at);

-- Single-use nonces for the signed "this is Shopify customer X" assertions.
CREATE TABLE used_nonces (
  nonce       TEXT PRIMARY KEY,
  used_at     TEXT NOT NULL
);

CREATE TABLE shops (
  shop                TEXT PRIMARY KEY,
  access_token_enc    TEXT,
  scope               TEXT,
  expires_at          TEXT,
  refresh_token_enc   TEXT,
  refresh_expires_at  TEXT,
  installed_at        TEXT NOT NULL,
  uninstalled_at      TEXT
);
