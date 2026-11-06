-- D-68: when the difference between the bank balance and the app's count began, so Accounts shows it only once it has
-- lasted a day (most are timing: the balance moves before the row arrives). Each sync sets or clears it
-- (sync/process.ts). Expand-only.
ALTER TABLE provider_account ADD COLUMN drift_since INTEGER;
