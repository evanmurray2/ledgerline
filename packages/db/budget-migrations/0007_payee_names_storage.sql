-- Payee names from Plaid, storage only (docs/payee-names.md sections 3, 8.1 and 9.2; PR 1 of section 11).
-- Expand-only: three new columns (nullable or with a default), and one new table; no row changes.

-- Plaid's short `name` for the row (raw_name keeps original_description). NULL until the sync writes it, or the
-- one-time job below fills it from the row's raw page.
ALTER TABLE bank_txn ADD COLUMN plaid_name TEXT;

-- Who chose the payee's name: 'user' (the owner, or any payee made before this release) or 'sync' (sync made it).
ALTER TABLE payee ADD COLUMN named_by TEXT NOT NULL DEFAULT 'user' CHECK (named_by IN ('user', 'sync'));

-- The bank pending row (provider_txn_id) this entry covers: hidden and not counted while the entry is unmatched
-- (9.2). Not written by this release.
ALTER TABLE manual_pending ADD COLUMN covers_provider_txn_id TEXT;

-- "Same purchase?" answered No (9.1): never asked again for this pair. The two row keys are stored in a canonical
-- order (a_key < b_key), so one pair has one row. Synced to the phone like every table its screens read.
CREATE TABLE not_same (
  budget_id TEXT NOT NULL,
  a_key TEXT NOT NULL,
  b_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (budget_id, a_key, b_key),
  CHECK (a_key < b_key)
) WITHOUT ROWID;
CREATE TRIGGER not_same_sync_ins AFTER INSERT ON not_same BEGIN INSERT INTO change_log (tbl, pk, seq, deleted) VALUES ('not_same', json_array(NEW.budget_id, NEW.a_key, NEW.b_key), (SELECT coalesce(max(seq), 0) + 1 FROM change_log), 0) ON CONFLICT (tbl, pk) DO UPDATE SET seq = excluded.seq, deleted = 0; END;
CREATE TRIGGER not_same_sync_upd AFTER UPDATE ON not_same BEGIN INSERT INTO change_log (tbl, pk, seq, deleted) VALUES ('not_same', json_array(NEW.budget_id, NEW.a_key, NEW.b_key), (SELECT coalesce(max(seq), 0) + 1 FROM change_log), 0) ON CONFLICT (tbl, pk) DO UPDATE SET seq = excluded.seq, deleted = 0; END;
CREATE TRIGGER not_same_sync_key AFTER UPDATE OF budget_id, a_key, b_key ON not_same WHEN OLD.budget_id IS NOT NEW.budget_id OR OLD.a_key IS NOT NEW.a_key OR OLD.b_key IS NOT NEW.b_key BEGIN INSERT INTO change_log (tbl, pk, seq, deleted) VALUES ('not_same', json_array(OLD.budget_id, OLD.a_key, OLD.b_key), (SELECT coalesce(max(seq), 0) + 1 FROM change_log), 1) ON CONFLICT (tbl, pk) DO UPDATE SET seq = excluded.seq, deleted = 1; END;
CREATE TRIGGER not_same_sync_del AFTER DELETE ON not_same BEGIN INSERT INTO change_log (tbl, pk, seq, deleted) VALUES ('not_same', json_array(OLD.budget_id, OLD.a_key, OLD.b_key), (SELECT coalesce(max(seq), 0) + 1 FROM change_log), 1) ON CONFLICT (tbl, pk) DO UPDATE SET seq = excluded.seq, deleted = 1; END;

