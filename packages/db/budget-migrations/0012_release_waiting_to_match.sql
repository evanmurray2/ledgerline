-- D-98: Waiting to match is gone (Money rule 9 removed). Money from a person is no longer held out of Ready to Assign;
-- it counts like any other money in (D-85), and Match only links it to what it pays back. This releases what is
-- held now, once: a row that already pays back something (a match with a rest kept waiting, or "I'll send it back")
-- becomes 'matched', so all of it is in Ready to Assign as after any match; a row with nothing matched goes back to
-- no state, so the usual rules place it (Ready to Assign for money into checking or savings).
-- Expand-only: no schema change. Row changes only, on the server's store and on the phone's copy alike.

-- 1. What is released stays in the audit log: one row per transaction, with its state before the change.
INSERT INTO audit_log (budget_id, user_id, action, entity, entity_id, before, after, created_at)
SELECT o.budget_id, NULL, 'transaction.release_waiting', 'transaction', o.txn_key,
  json_object('wtm_state', o.wtm_state, 'to_rta', o.to_rta), NULL, strftime('%s', 'now') * 1000
FROM txn_overlay o
WHERE o.wtm_state IN ('waiting', 'send_back');

-- 2. Release it.
UPDATE txn_overlay SET
  wtm_state = CASE WHEN EXISTS (
      SELECT 1 FROM txn_link l
      WHERE l.from_key = txn_overlay.txn_key AND l.kind = 'reimbursement_of' AND l.undone_at IS NULL
    ) THEN 'matched' ELSE NULL END,
  updated_at = strftime('%s', 'now') * 1000
WHERE wtm_state IN ('waiting', 'send_back');
