-- D-79: undoing Close out on an owed item (Money rule 11) leaves the month it was closed in as it was. A close that is
-- undone in a later month stays as a close line in its own month, and the undo is a close line of the opposite amount
-- in the month of the undo. This table keeps those past closes and undos; the item's closed_at, closed_month and
-- closed_amount keep holding only its current close. txn_key is the item's transaction, so the phone knows which
-- transaction's lines to work out again. Synced to the phone (src/sync-tables.ts). Expand-only.
CREATE TABLE owed_close (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  item_id TEXT NOT NULL,            -- expected_reimbursement.id
  txn_key TEXT NOT NULL,            -- expected_reimbursement.txn_key
  month TEXT NOT NULL,              -- YYYY-MM the line counts in
  amount INTEGER NOT NULL,          -- cents: positive for a close, negative for its undo
  created_at INTEGER NOT NULL
);
CREATE INDEX owed_close_txn ON owed_close(txn_key);

CREATE TRIGGER owed_close_sync_ins AFTER INSERT ON owed_close BEGIN INSERT INTO change_log (tbl, pk, seq, deleted) VALUES ('owed_close', json_array(NEW.id), (SELECT coalesce(max(seq), 0) + 1 FROM change_log), 0) ON CONFLICT (tbl, pk) DO UPDATE SET seq = excluded.seq, deleted = 0; END;
CREATE TRIGGER owed_close_sync_upd AFTER UPDATE ON owed_close BEGIN INSERT INTO change_log (tbl, pk, seq, deleted) VALUES ('owed_close', json_array(NEW.id), (SELECT coalesce(max(seq), 0) + 1 FROM change_log), 0) ON CONFLICT (tbl, pk) DO UPDATE SET seq = excluded.seq, deleted = 0; END;
CREATE TRIGGER owed_close_sync_key AFTER UPDATE OF id ON owed_close WHEN OLD.id IS NOT NEW.id BEGIN INSERT INTO change_log (tbl, pk, seq, deleted) VALUES ('owed_close', json_array(OLD.id), (SELECT coalesce(max(seq), 0) + 1 FROM change_log), 1) ON CONFLICT (tbl, pk) DO UPDATE SET seq = excluded.seq, deleted = 1; END;
CREATE TRIGGER owed_close_sync_del AFTER DELETE ON owed_close BEGIN INSERT INTO change_log (tbl, pk, seq, deleted) VALUES ('owed_close', json_array(OLD.id), (SELECT coalesce(max(seq), 0) + 1 FROM change_log), 1) ON CONFLICT (tbl, pk) DO UPDATE SET seq = excluded.seq, deleted = 1; END;
