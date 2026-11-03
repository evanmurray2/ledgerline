-- Phones that keep an encrypted copy of a budget (docs/phone-budget.md section 13, decisions.md D-44). The copy's
-- key needs both the user's passkey and this row's share, which the server hands out only after a sign-in and only
-- while the device isn't revoked. Expand-only.
CREATE TABLE device (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  name TEXT NOT NULL,
  share TEXT,                        -- base64url, 32 random bytes; NULL once revoked
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX device_user ON device (user_id);
-- Changes whenever a budget's database is restored, so every phone downloads its copy again (section 8).
ALTER TABLE budget ADD COLUMN sync_epoch TEXT NOT NULL DEFAULT 'e0';
