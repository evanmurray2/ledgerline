-- expand-only: removal of the tables, views, indexes and triggers only the old server path used, unused since ae1e37a (D-102 removed the last reader; D-106)
--
-- Every budget is locked (D-102): the store keeps its budget only as the sealed log, sealed bank runs and
-- snapshots. The readable tables from before the lock go now, at once (D-106), with no job and no wait. Every
-- statement is IF EXISTS: a fresh store, a store the old purge job had partly emptied, and the owner's store all
-- end the same. Dropping a table drops its indexes and its triggers with it.
--
-- Kept, because the server still uses them:
--   budget        the store knows its budget by its one row (id, name, times; the rest of its columns go below)
--   job           the job queue (fetch, backstop, Item routes)
--   lease_guard   the fence the log, snapshot and run writes use (sync/lease.ts conditionFence)
--   store_mark, store_note, bank_link, log_entry, log_state, key_stamp, run_state, run_stage, link_cursor,
--   sealed_page, sealed_run, snapshot, snapshot_chunk   the locked budget itself (store migrations 0001 to 0009)
--
-- The device's copy is not touched: a phone never runs a store migration.

-- The triggers that tie `connection` to `bank_link` go first, by name: a delete on `connection` must never reach
-- the bank links the fetch job uses. (A DROP TABLE fires no trigger, but nothing is left to chance.)
DROP TRIGGER IF EXISTS bank_link_made;
DROP TRIGGER IF EXISTS bank_link_changed;
DROP TRIGGER IF EXISTS bank_link_removed;
DROP TRIGGER IF EXISTS bank_link_restored;
DROP TRIGGER IF EXISTS bank_link_deleted;
-- The kept `budget` table's change-log triggers (budget migration 0003): they write to `change_log`, dropped below.
DROP TRIGGER IF EXISTS budget_sync_ins;
DROP TRIGGER IF EXISTS budget_sync_upd;
DROP TRIGGER IF EXISTS budget_sync_key;
DROP TRIGGER IF EXISTS budget_sync_del;

-- Views read the old tables.
DROP VIEW IF EXISTS v_transaction;
DROP VIEW IF EXISTS v_txn_bank;
DROP VIEW IF EXISTS v_txn_manual;

-- Tables that other old tables point at go after the ones that point at them (foreign keys are on).
DROP TABLE IF EXISTS assignment;
DROP TABLE IF EXISTS target;
DROP TABLE IF EXISTS category;
DROP TABLE IF EXISTS category_group;
DROP TABLE IF EXISTS manual_pending;
DROP TABLE IF EXISTS account;
DROP TABLE IF EXISTS payee_alias;
DROP TABLE IF EXISTS payee;
DROP TABLE IF EXISTS sync_page;
DROP TABLE IF EXISTS sync_run;
DROP TABLE IF EXISTS provider_account;
DROP TABLE IF EXISTS connection;

-- The rest of the old budget tables, the change log and the undo records.
DROP TABLE IF EXISTS alert;
DROP TABLE IF EXISTS apply_counter;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS bank_event;
DROP TABLE IF EXISTS bank_page;
DROP TABLE IF EXISTS bank_txn;
DROP TABLE IF EXISTS change_log;
DROP TABLE IF EXISTS edit_seen;
DROP TABLE IF EXISTS expected_reimbursement;
DROP TABLE IF EXISTS health_status;
DROP TABLE IF EXISTS holding_snapshot;
DROP TABLE IF EXISTS liability_snapshot;
DROP TABLE IF EXISTS not_same;
DROP TABLE IF EXISTS owed_close;
DROP TABLE IF EXISTS raw_page;
DROP TABLE IF EXISTS rule;
DROP TABLE IF EXISTS setting;
DROP TABLE IF EXISTS txn_key_move;
DROP TABLE IF EXISTS txn_link;
DROP TABLE IF EXISTS txn_overlay;
DROP TABLE IF EXISTS txn_split;
DROP TABLE IF EXISTS usage_daily;
DROP TABLE IF EXISTS usage_event;
DROP TABLE IF EXISTS usage_note;
-- Dropped on the server by budget migration 0006 already.
DROP TABLE IF EXISTS budget_line;
DROP TABLE IF EXISTS month_snapshot;
DROP TABLE IF EXISTS account_month_total;
DROP TABLE IF EXISTS month_total_done;
-- The shadow run's plain inbox (store migrations 0003, 0004).
DROP TABLE IF EXISTS inbox_run;
DROP TABLE IF EXISTS inbox_scan;

-- The budget row keeps only what says which budget this is. Its other columns held the budget's own facts (its
-- time zone, its first month, the cached Ready to Assign) and the old filing's watermarks.
ALTER TABLE budget DROP COLUMN time_zone;
ALTER TABLE budget DROP COLUMN budget_start_month;
ALTER TABLE budget DROP COLUMN processed_through;
ALTER TABLE budget DROP COLUMN summary_dirty_from;
ALTER TABLE budget DROP COLUMN summary_version;
ALTER TABLE budget DROP COLUMN summary_month;
ALTER TABLE budget DROP COLUMN rta;
ALTER TABLE budget DROP COLUMN data_version;
-- A locked budget's name is in its devices' copies only (the purge had emptied it in the owner's store).
UPDATE budget SET name = '' WHERE EXISTS (SELECT 1 FROM store_mark WHERE key = 'sealed');

-- The old purge job and its notes (D-99): the job is gone, and so is what it counted.
DELETE FROM job WHERE kind IN ('purge_old', 'stamp_links');
DELETE FROM store_note WHERE key IN ('purge_tables', 'purge_done_tables', 'purge_rows', 'purge_started_at',
  'purge_done_at', 'purge_checked_at', 'purge_left');
