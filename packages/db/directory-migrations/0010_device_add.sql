-- Adding a device with its own passkey to a locked budget (docs/privacy-keys.md section 10): the relay for the
-- messages between the signed-in device (`from_session`) and the new one (`to_session`, set when the new device
-- sends its commitment). The server holds only what section 10 lets it see: the commitment, the offer and the
-- reveal (public values), the budget key sealed to the new device's one-time key, and the confirmation. Never a
-- secret. One row per user, for 10 minutes; a new start replaces it, and it is deleted once confirmed or
-- expired. A table only; no rows are copied or changed. Expand-only.
CREATE TABLE device_add (
  user_id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  from_session TEXT NOT NULL,
  to_session TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  -- How many offers the signed-in device made in this start (at most 3, as the device itself keeps).
  offers INTEGER NOT NULL DEFAULT 0,
  commit_hex TEXT,
  offer_hex TEXT,
  reveal_hex TEXT,
  sealed_hex TEXT,
  confirm_hex TEXT
);
