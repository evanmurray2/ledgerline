-- Sign-in without Cloudflare Access (decisions.md D-27: Zero Trust needs a payment card). The Worker verifies
-- passkeys itself and keeps sessions server-side; the browser holds only a random token whose SHA-256 is the id.
CREATE TABLE passkey (
  id TEXT PRIMARY KEY,               -- credential id, base64url
  public_key TEXT NOT NULL,          -- COSE public key, base64url
  counter INTEGER NOT NULL,
  transports TEXT,                   -- JSON array
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE auth_session (
  id TEXT PRIMARY KEY,               -- SHA-256 (hex) of the cookie token
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,       -- absolute: 24 hours after sign-in
  verified_at INTEGER NOT NULL,      -- last passkey check; linking banks and exports need one within 15 minutes
  passkey_id TEXT,
  user_agent TEXT
);
CREATE INDEX auth_session_expires ON auth_session (expires_at);

-- One WebAuthn ceremony: the challenge and what allowed it to start, kept for 5 minutes.
CREATE TABLE auth_challenge (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  grant_kind TEXT,                   -- register only: 'setup' | 'device' | 'session'
  grant_ref TEXT,                    -- device link hash or session id
  expires_at INTEGER NOT NULL
);

-- Single-use links that let a new device add a passkey, made from a signed-in device; 10 minutes.
CREATE TABLE device_link (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
