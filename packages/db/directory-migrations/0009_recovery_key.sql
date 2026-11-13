-- The recovery key of a locked budget, for sign-in (docs/privacy-keys.md 4.2 "Proving it to the server"): the
-- public half of the Ed25519 pair that comes from the recovery key. Never a secret. One per user: a new recovery
-- key replaces it. A table only; no rows are copied or changed. Expand-only.
CREATE TABLE recovery_key (
  user_id TEXT PRIMARY KEY REFERENCES user(id),
  auth_pub TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
