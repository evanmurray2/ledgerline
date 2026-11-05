-- D-?: a bank row dated before its account's budget start is part of the starting balance (pending at link, or sent
-- late by the bank) or history; it is never in a category (packages/domain/src/budget/start.ts). Until now a row
-- pending at link was budgeted in its category, so those categories are cleared here, once.
-- Expand-only: no schema change. Row changes only, on the server's store and on the phone's copy alike.

-- 1. A card purchase pending at link with an authorized date before the budget start, but a pending date on or after
-- it, was not marked pending at link (filing compared the pending date). Mark it, as filing now does.
UPDATE txn_overlay SET pending_at_link = 1, updated_at = strftime('%s', 'now') * 1000
WHERE pending_at_link = 0 AND txn_key IN (
  SELECT b.txn_key FROM bank_txn b
  JOIN account a ON a.budget_id = b.budget_id AND a.provider_account_id = b.provider_account_id
  WHERE b.pending = 1 AND b.removed_at IS NULL AND a.kind = 'credit' AND b.amount < 0
    AND b.authorized_date IS NOT NULL AND b.authorized_date < a.budget_from
);

-- The rows to clear: pending at link and dated (the budget's date: the authorized date for a card purchase) before
-- the budget start. A row pending at link can carry a later authorized date; it is in the budget and keeps its
-- category.
-- The same condition is repeated in each statement below.

-- 2. What is cleared stays in the audit log: one row per transaction, with its category, Ready to Assign mark and
-- splits before the change.
INSERT INTO audit_log (budget_id, user_id, action, entity, entity_id, before, after, created_at)
SELECT o.budget_id, NULL, 'transaction.starting_balance', 'transaction', o.txn_key,
  json_object(
    'category_id', o.category_id,
    'categorized_by', o.categorized_by,
    'to_rta', o.to_rta,
    'splits', (SELECT json_group_array(json_object('category_id', sp.category_id, 'amount', sp.amount))
               FROM txn_split sp WHERE sp.txn_key = o.txn_key)
  ),
  NULL, strftime('%s', 'now') * 1000
FROM txn_overlay o
WHERE o.txn_key IN (
  SELECT o.txn_key FROM txn_overlay o
  -- The row the app shows for the key (v_txn_bank): the posted one once it posted; a removed row only when the key
  -- has no other.
  JOIN bank_txn b ON b.txn_key = o.txn_key
    AND (b.removed_at IS NULL OR NOT EXISTS (SELECT 1 FROM bank_txn y WHERE y.txn_key = b.txn_key AND y.removed_at IS NULL))
    AND NOT (b.pending = 1 AND EXISTS (SELECT 1 FROM bank_txn x WHERE x.txn_key = b.txn_key AND x.pending = 0 AND x.removed_at IS NULL))
  JOIN account a ON a.budget_id = b.budget_id AND a.provider_account_id = b.provider_account_id
  WHERE o.pending_at_link = 1
    AND (CASE WHEN a.kind = 'credit' AND b.amount < 0 AND b.authorized_date IS NOT NULL THEN b.authorized_date ELSE b.date END) < a.budget_from
)
  AND (o.category_id IS NOT NULL OR o.to_rta = 1 OR o.categorized_by IS NOT NULL
       OR EXISTS (SELECT 1 FROM txn_split sp WHERE sp.txn_key = o.txn_key));

-- 3. Clear them.
DELETE FROM txn_split WHERE txn_key IN (
  SELECT o.txn_key FROM txn_overlay o
  -- The row the app shows for the key (v_txn_bank): the posted one once it posted; a removed row only when the key
  -- has no other.
  JOIN bank_txn b ON b.txn_key = o.txn_key
    AND (b.removed_at IS NULL OR NOT EXISTS (SELECT 1 FROM bank_txn y WHERE y.txn_key = b.txn_key AND y.removed_at IS NULL))
    AND NOT (b.pending = 1 AND EXISTS (SELECT 1 FROM bank_txn x WHERE x.txn_key = b.txn_key AND x.pending = 0 AND x.removed_at IS NULL))
  JOIN account a ON a.budget_id = b.budget_id AND a.provider_account_id = b.provider_account_id
  WHERE o.pending_at_link = 1
    AND (CASE WHEN a.kind = 'credit' AND b.amount < 0 AND b.authorized_date IS NOT NULL THEN b.authorized_date ELSE b.date END) < a.budget_from
);
UPDATE txn_overlay SET category_id = NULL, categorized_by = NULL, rule_id = NULL, to_rta = 0,
  updated_at = strftime('%s', 'now') * 1000
WHERE txn_key IN (
  SELECT o.txn_key FROM txn_overlay o
  -- The row the app shows for the key (v_txn_bank): the posted one once it posted; a removed row only when the key
  -- has no other.
  JOIN bank_txn b ON b.txn_key = o.txn_key
    AND (b.removed_at IS NULL OR NOT EXISTS (SELECT 1 FROM bank_txn y WHERE y.txn_key = b.txn_key AND y.removed_at IS NULL))
    AND NOT (b.pending = 1 AND EXISTS (SELECT 1 FROM bank_txn x WHERE x.txn_key = b.txn_key AND x.pending = 0 AND x.removed_at IS NULL))
  JOIN account a ON a.budget_id = b.budget_id AND a.provider_account_id = b.provider_account_id
  WHERE o.pending_at_link = 1
    AND (CASE WHEN a.kind = 'credit' AND b.amount < 0 AND b.authorized_date IS NOT NULL THEN b.authorized_date ELSE b.date END) < a.budget_from
)
  AND (category_id IS NOT NULL OR to_rta = 1 OR categorized_by IS NOT NULL);
