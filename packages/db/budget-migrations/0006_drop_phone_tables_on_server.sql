-- expand-only: removal of budget_line, month_snapshot, account_month_total and month_total_done, unused on the
-- server since D-45 (PR #19 stopped every server read and write of them and is deployed).
-- They hold what the phone works out (budget lines, month snapshots, stored month totals). The phone's copy keeps
-- them: its engine skips this migration and creates them itself (apps/worker/src/local/engine.ts, PHONE_TABLES).
DROP INDEX IF EXISTS budget_line_month;
DROP TABLE IF EXISTS budget_line;
DROP TABLE IF EXISTS month_snapshot;
DROP TABLE IF EXISTS account_month_total;
DROP TABLE IF EXISTS month_total_done;
