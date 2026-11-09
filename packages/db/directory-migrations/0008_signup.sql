-- Open sign-up, built and switched off (D-75, docs/open-signup.md 16). Tables and indexes only; no rows are copied
-- or changed. Expand-only.
-- Every finished passkey ceremony records its challenge id here, in the same transaction, so a challenge works once
-- (3.3). auth_prune deletes rows older than a day.
CREATE TABLE used_challenge (
  id TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);
CREATE INDEX used_challenge_at ON used_challenge (used_at);
-- A statement that writes ok = 0 here throws, so it rolls its whole batch back: the lease_guard pattern for the
-- Directory (INSERT OR REPLACE on id 1, so one row at most).
CREATE TABLE fence (
  id INTEGER PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);
-- A recovery code was used (4): its user sees a notice for 14 days, until they dismiss it.
CREATE TABLE recovery_notice (
  user_id TEXT PRIMARY KEY REFERENCES user(id),
  used_at INTEGER NOT NULL,
  dismissed_at INTEGER
);
-- Sign-ups per UTC day (3.2).
CREATE INDEX user_created ON user (created_at);
-- Durable Object requests per budget per day, for each user's share (8).
ALTER TABLE budget_usage_day ADD COLUMN requests INTEGER NOT NULL DEFAULT 0;
