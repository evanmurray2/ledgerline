-- The daily scan's vanished-pending check looks for edits held on a removed bank row (txn_overlay.orphaned_at).
-- Without an index it read every overlay row each day, which grows with the budget's whole history; this partial
-- index holds only the few orphaned rows. Adds an index only: no data changes.
CREATE INDEX txn_overlay_orphaned ON txn_overlay(budget_id, orphaned_at) WHERE orphaned_at IS NOT NULL;
