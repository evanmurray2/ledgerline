-- D-86 A1 and A2 (docs/privacy.md 14.2): when a bank update finished fetching, and its place among the budget's
-- updates. Both are set once, in the step that stores the run's last page. A1 makes fetched_at the one time of
-- everything the update brings; A2 files updates one at a time in fetch_seq order (1, 2, 3 … for the whole budget,
-- across its banks). A run that was not fetched to the end has neither. A run that is adopted by a later one
-- (steps.ts beginRun) hands both over, and keeps its number as a negative. Server only: sync_run is not synced to
-- the phone. Expand-only.
ALTER TABLE sync_run ADD COLUMN fetched_at INTEGER;
ALTER TABLE sync_run ADD COLUMN fetch_seq INTEGER;
CREATE UNIQUE INDEX sync_run_fetch_seq ON sync_run(budget_id, fetch_seq) WHERE fetch_seq IS NOT NULL;
