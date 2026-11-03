-- A bank pending row is done as soon as a posted row has claimed it (taken its txn_key), even while the provider
-- still lists it: some banks keep a posted charge's pending row for hours or days (D-47). Both bank views hide it,
-- so it is neither shown twice nor counted in pending totals. Redefines the views with the same columns: a rollback's
-- code reads them unchanged (tools/ci/expand-only.mjs allows a view dropped and recreated in the same file).

DROP VIEW v_transaction;
CREATE VIEW v_transaction AS
SELECT
  b.budget_id, b.txn_key AS key, 'bank' AS source, a.id AS account_id, a.kind AS account_kind, a.name AS account_name,
  a.budget_from,
  CASE WHEN b.pending = 1 AND o.estimated_amount IS NOT NULL THEN o.estimated_amount ELSE b.amount END AS amount,
  b.amount AS bank_amount,
  CASE WHEN a.kind = 'credit' AND b.amount < 0 AND b.authorized_date IS NOT NULL THEN b.authorized_date ELSE b.date END AS date,
  b.date AS posted_date,
  CASE WHEN b.pending = 1 THEN 'pending' ELSE 'posted' END AS status,
  coalesce(p.name, b.merchant_name, b.raw_name) AS payee, b.raw_name, b.merchant_entity_id, b.provider_category,
  b.payment_channel, b.provider_txn_id, b.pending_provider_txn_id, b.created_at AS seq, NULL AS repeats,
  o.category_id, o.to_rta, o.income_tag, o.memo, o.budget_month, o.estimated_amount, coalesce(o.wont_clear, 0) AS wont_clear,
  o.transfer_state, o.transfer_account_id, o.wtm_state, o.categorized_by, o.rule_id, o.reviewed_at,
  coalesce(o.pending_at_link, 0) AS pending_at_link, o.alert, o.payee_id
FROM bank_txn b
JOIN account a ON a.budget_id = b.budget_id AND a.provider_account_id = b.provider_account_id
LEFT JOIN txn_overlay o ON o.txn_key = b.txn_key
LEFT JOIN payee p ON p.id = o.payee_id
WHERE b.removed_at IS NULL
  -- A pending row a posted row has claimed (it holds the same txn_key) is done: hidden, not counted twice.
  AND NOT (b.pending = 1 AND EXISTS (SELECT 1 FROM bank_txn x WHERE x.txn_key = b.txn_key AND x.pending = 0 AND x.removed_at IS NULL))
UNION ALL
SELECT
  m.budget_id, m.txn_key, 'manual', a.id, a.kind, a.name, a.budget_from,
  m.amount, NULL, m.date, NULL,
  CASE WHEN m.kind = 'upcoming' THEN 'upcoming' ELSE 'pending' END,
  coalesce(p.name, m.payee_name), m.payee_name, NULL, NULL, NULL, NULL, NULL, m.created_at, m.repeats,
  o.category_id, o.to_rta, o.income_tag, o.memo, o.budget_month, NULL, coalesce(o.wont_clear, 0),
  o.transfer_state, o.transfer_account_id, o.wtm_state, o.categorized_by, o.rule_id, o.reviewed_at,
  0, o.alert, o.payee_id
FROM manual_pending m
JOIN account a ON a.id = m.account_id
LEFT JOIN txn_overlay o ON o.txn_key = m.txn_key
LEFT JOIN payee p ON p.id = o.payee_id
WHERE m.deleted_at IS NULL AND m.matched_txn_key IS NULL;

DROP VIEW v_txn_bank;
CREATE VIEW v_txn_bank AS
SELECT
  b.budget_id, b.txn_key AS key, 'bank' AS source, a.id AS account_id, a.kind AS account_kind, a.name AS account_name,
  a.budget_from,
  CASE WHEN b.pending = 1 AND o.estimated_amount IS NOT NULL THEN o.estimated_amount ELSE b.amount END AS amount,
  b.amount AS bank_amount,
  CASE WHEN a.kind = 'credit' AND b.amount < 0 AND b.authorized_date IS NOT NULL THEN b.authorized_date ELSE b.date END AS date,
  b.date AS posted_date,
  CASE WHEN b.pending = 1 THEN 'pending' ELSE 'posted' END AS status,
  coalesce(p.name, b.merchant_name, b.raw_name) AS payee, b.raw_name, b.merchant_entity_id, b.provider_category,
  b.payment_channel, b.provider_txn_id, b.pending_provider_txn_id, b.created_at AS seq, NULL AS repeats,
  o.category_id, o.to_rta, o.income_tag, o.memo, o.budget_month, o.estimated_amount, coalesce(o.wont_clear, 0) AS wont_clear,
  o.transfer_state, o.transfer_account_id, o.wtm_state, o.categorized_by, o.rule_id, o.reviewed_at,
  coalesce(o.pending_at_link, 0) AS pending_at_link, o.alert, o.payee_id, b.pending AS bank_pending
FROM bank_txn b
JOIN account a ON a.budget_id = b.budget_id AND a.provider_account_id = b.provider_account_id
LEFT JOIN txn_overlay o ON o.txn_key = b.txn_key
LEFT JOIN payee p ON p.id = o.payee_id
WHERE b.removed_at IS NULL
  -- A pending row a posted row has claimed (it holds the same txn_key) is done: hidden, not counted twice.
  AND NOT (b.pending = 1 AND EXISTS (SELECT 1 FROM bank_txn x WHERE x.txn_key = b.txn_key AND x.pending = 0 AND x.removed_at IS NULL));
