-- Multi-user identity (docs/multi-user.md 7.1), expand-only. The same columns exist in the Directory
-- (directory-migrations/0003), so one sign-in implementation works on D1 now and in the Directory after the move.
-- With one user nothing changes: the owner becomes the admin and keeps the WebAuthn handle their passkeys already use.
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
-- The owner: the first user, if there is one. New users get a random handle and link allowance 0.
UPDATE user SET is_admin = 1, link_allowance = 10, webauthn_handle = 'ledgerline-owner'
WHERE id = (SELECT id FROM user ORDER BY created_at, id LIMIT 1);
UPDATE passkey SET user_id = (SELECT id FROM user ORDER BY created_at, id LIMIT 1) WHERE user_id IS NULL;
UPDATE auth_session SET user_id = (SELECT id FROM user ORDER BY created_at, id LIMIT 1) WHERE user_id IS NULL;
UPDATE device_link SET user_id = (SELECT id FROM user ORDER BY created_at, id LIMIT 1) WHERE user_id IS NULL;
