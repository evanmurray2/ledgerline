-- The fetch state of a bank link, for a sealed budget (docs/privacy.md 5.5). Until the cutover it stays in
-- `connection`; a sealed budget's `connection` is not read, so the job that fetches sealed runs
-- (apps/worker/src/seal/fetch-job.ts) notes it here. None of it is under the link's stamp: it decides only
-- whether and when the Worker asks the bank, never what it asks with or where the answer goes.
ALTER TABLE bank_link ADD COLUMN status TEXT NOT NULL DEFAULT 'ok';   -- 'ok' or 'needs_repair'
ALTER TABLE bank_link ADD COLUMN error_code TEXT;                      -- the last fetch's error; NULL after a good one
ALTER TABLE bank_link ADD COLUMN last_fetched_at INTEGER;              -- the last complete run
ALTER TABLE bank_link ADD COLUMN last_attempt_at INTEGER;
ALTER TABLE bank_link ADD COLUMN fetch_requested INTEGER NOT NULL DEFAULT 0;  -- 1: news came while a run was open
