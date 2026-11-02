-- Directory: multi-user identity (docs/multi-user.md 7.1, 5.2), the same columns as D1 migration 0010, plus the
-- Directory's own tables for invites, recovery, Plaid slots, routing and usage. Expand-only.
ALTER TABLE user ADD COLUMN display_name TEXT;
ALTER TABLE user ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleting'));
ALTER TABLE user ADD COLUMN last_seen_at INTEGER;
ALTER TABLE user ADD COLUMN link_allowance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user ADD COLUMN webauthn_handle TEXT;
ALTER TABLE passkey ADD COLUMN user_id TEXT REFERENCES user(id);
ALTER TABLE auth_session ADD COLUMN user_id TEXT REFERENCES user(id);
ALTER TABLE auth_session ADD COLUMN challenge_id TEXT;
ALTER TABLE device_link ADD COLUMN user_id TEXT REFERENCES user(id);
CREATE INDEX passkey_user ON passkey (user_id);
CREATE INDEX auth_session_user ON auth_session (user_id);
CREATE UNIQUE INDEX auth_session_challenge ON auth_session (challenge_id) WHERE challenge_id IS NOT NULL;
CREATE UNIQUE INDEX user_webauthn_handle ON user (webauthn_handle) WHERE webauthn_handle IS NOT NULL;
-- Single-use invite links (7.3): only the hash of the token is stored.
CREATE TABLE invite (
  token_hash TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES user(id),
  link_allowance INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT REFERENCES user(id)
);
-- Recovery codes for non-owner users (7.3): one per user, unique hash.
CREATE TABLE recovery_code (
  user_id TEXT PRIMARY KEY REFERENCES user(id),
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
-- Plaid Items (9.1): reserved before Link opens, never deleted, so the lifetime Trial count stays right.
CREATE TABLE plaid_link_slot (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'used', 'released')),
  link_token_hash TEXT,
  connection_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX plaid_link_slot_user ON plaid_link_slot (user_id, status);
-- Which budget owns each Plaid Item, for webhooks (6.4). The primary key keeps an Item in one budget.
CREATE TABLE connection_route (
  provider_item_id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Each budget's share of the account's daily limits (9.2).
CREATE TABLE budget_usage_day (
  budget_id TEXT NOT NULL,
  day TEXT NOT NULL,
  written INTEGER NOT NULL DEFAULT 0,
  read INTEGER NOT NULL DEFAULT 0,
  steps INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (budget_id, day)
);
-- Small Directory state: cron cursors, the monitor stamp.
CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
