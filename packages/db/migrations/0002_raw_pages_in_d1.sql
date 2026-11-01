-- Raw provider pages move from R2 into D1 (decisions.md D-26: no R2, which needs a payment card). The fetch step
-- stores Plaid's response text here as-is, never parsed; the apply step reads it back in its first query. Rows are
-- never changed or deleted: this is the permanent raw archive that bank_event.raw_ref points into
-- ('<raw_page.key>#<list>/<index>').
CREATE TABLE raw_page (
  key TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  body TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER raw_page_no_update BEFORE UPDATE ON raw_page
BEGIN SELECT RAISE(ABORT, 'raw_page is append-only'); END;
CREATE TRIGGER raw_page_no_delete BEFORE DELETE ON raw_page
BEGIN SELECT RAISE(ABORT, 'raw_page is append-only'); END;

ALTER TABLE sync_page RENAME COLUMN r2_key TO raw_key;
ALTER TABLE bank_page RENAME COLUMN r2_key TO raw_key;
