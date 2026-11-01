-- Fewer rows read per screen (D1's free plan allows 5 million a day; see docs/measurements.md).

-- 1. Bank rows by date, so screens can read only the rows that matter to the budget instead of all history.
CREATE INDEX bank_txn_budget_date ON bank_txn(budget_id, date);

-- 2. The two halves of v_transaction as their own views. v_transaction is a UNION ALL, which SQLite can't join
--    through an index or limit by date; these two can. Same columns as v_transaction, plus bank_pending.
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
WHERE b.removed_at IS NULL;

CREATE VIEW v_txn_manual AS
SELECT
  m.budget_id, m.txn_key AS key, 'manual' AS source, a.id AS account_id, a.kind AS account_kind, a.name AS account_name,
  a.budget_from, m.amount AS amount, NULL AS bank_amount, m.date AS date, NULL AS posted_date,
  CASE WHEN m.kind = 'upcoming' THEN 'upcoming' ELSE 'pending' END AS status,
  coalesce(p.name, m.payee_name) AS payee, m.payee_name AS raw_name, NULL AS merchant_entity_id, NULL AS provider_category,
  NULL AS payment_channel, NULL AS provider_txn_id, NULL AS pending_provider_txn_id, m.created_at AS seq, m.repeats AS repeats,
  o.category_id, o.to_rta, o.income_tag, o.memo, o.budget_month, NULL AS estimated_amount, coalesce(o.wont_clear, 0) AS wont_clear,
  o.transfer_state, o.transfer_account_id, o.wtm_state, o.categorized_by, o.rule_id, o.reviewed_at,
  0 AS pending_at_link, o.alert, o.payee_id, NULL AS bank_pending
FROM manual_pending m
JOIN account a ON a.id = m.account_id
LEFT JOIN txn_overlay o ON o.txn_key = m.txn_key
LEFT JOIN payee p ON p.id = o.payee_id
WHERE m.deleted_at IS NULL AND m.matched_txn_key IS NULL;

-- 3. Card statements: at most one snapshot per card per day (the latest sync's), found through an index.
DELETE FROM liability_snapshot WHERE id NOT IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY budget_id, provider_account_id, as_of ORDER BY created_at DESC) AS rn
    FROM liability_snapshot
  ) WHERE rn = 1
);
DROP INDEX liability_latest;
CREATE UNIQUE INDEX liability_day ON liability_snapshot(budget_id, provider_account_id, as_of);

-- 4. Pending bank rows on their own (few at any time): rows pending when an account was linked can be dated before
--    its budget start, and the budget still counts them. v_txn_bank exposes b.pending as bank_pending for this.
CREATE INDEX bank_txn_pending ON bank_txn(budget_id) WHERE pending = 1;

-- 5. A payee's past categories (the category picker's "You've used for ..."), without reading every overlay.
CREATE INDEX txn_overlay_payee ON txn_overlay(budget_id, payee_id, categorized_by, category_id);
