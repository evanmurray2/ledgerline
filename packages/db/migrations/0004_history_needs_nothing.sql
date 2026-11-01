-- History rows (posted before their account's budget start, not pending at link) are outside the budget, so they
-- never wait to match or need a transfer picked. Earlier syncs gave some of them those states; clear them.
UPDATE txn_overlay SET wtm_state = NULL, transfer_state = NULL, transfer_account_id = NULL, updated_at = updated_at
WHERE (wtm_state IN ('waiting', 'send_back') OR transfer_state = 'unsorted')
  AND pending_at_link = 0
  AND txn_key IN (
    SELECT b.txn_key FROM bank_txn b
    JOIN account a ON a.budget_id = b.budget_id AND a.provider_account_id = b.provider_account_id
    WHERE b.pending = 0 AND b.date < a.budget_from
  );
