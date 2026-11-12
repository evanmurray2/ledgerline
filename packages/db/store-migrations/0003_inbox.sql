-- The inbox (docs/privacy.md 5.5, phase 4): each bank update as it was fetched, kept for the device, which files
-- it too. One row per update, by its place among the budget's updates (`sync_run.fetch_seq`, D-86 A2). The pages
-- themselves stay in `raw_page`; this row names them. Plain for now; sealed to the budget's inbox key later.
--
-- `base_version` and `end_version` are `budget.data_version` when the server began and ended filing the update.
-- That number moves with every edit and daily job and never with bank filing, so a device can tell whether its
-- copy is what the server had when it began (the same number), and whether anything but the update happened
-- meanwhile (the two differ).
CREATE TABLE inbox_run (
  fetch_seq INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  pages TEXT NOT NULL,          -- JSON: [{ key, nextCursor, hasMore, sha256 }] in page order
  bank TEXT,                    -- JSON: what the bank said at the end (balances, card statements); NULL: not asked
  base_version INTEGER NOT NULL,
  end_version INTEGER,          -- NULL while the server is filing it
  created_at INTEGER NOT NULL
);
