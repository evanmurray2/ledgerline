-- Background work on alarms (docs/multi-user.md 6.1): one row per job. A job runs one small step per alarm; its
-- attempt is committed before the step runs, so a step killed mid-run still counts and is retried.
CREATE TABLE job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  connection_id TEXT,
  state TEXT NOT NULL DEFAULT '{}',
  run_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  recurring INTEGER NOT NULL DEFAULT 0,
  failed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX job_due ON job (run_at) WHERE failed_at IS NULL;
