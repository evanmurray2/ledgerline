-- The sign-in a phone's saved copy last opened with (D-52). Settings → Sign-in lists a phone with a saved copy as
-- one of your sign-ins, and signing it out there also turns its copy off, so the phone deletes it. Expand-only.
ALTER TABLE device ADD COLUMN session_id TEXT;
CREATE INDEX device_session ON device (session_id);
