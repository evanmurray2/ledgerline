-- Ledgerline schema, migration 0001. Forward-only.
-- Conventions: text ULID keys (integer row ids for append-only, high-volume tables), money in INTEGER cents,
-- dates as TEXT YYYY-MM-DD, budget months as TEXT YYYY-MM, timestamps as INTEGER epoch milliseconds.
-- Every budget-owned table carries budget_id; the data-access layer scopes every query by it.

-- ---------------------------------------------------------------- users and budgets
CREATE TABLE user (
  id TEXT PRIMARY KEY,
  github_login TEXT,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE budget (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  time_zone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  budget_start_month TEXT,                       -- YYYY-MM; NULL until first-run setup
  processed_through INTEGER NOT NULL DEFAULT 0,  -- highest apply_seq fully processed (watermark)
  summary_dirty_from TEXT,                       -- earliest month whose summaries are stale
  summary_version INTEGER NOT NULL DEFAULT 0,    -- bumped by every write that changes budget inputs
  summary_month TEXT,                            -- month the cached RTA was computed for
  rta INTEGER NOT NULL DEFAULT 0,                -- cached Ready to Assign (cents)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE budget_member (
  budget_id TEXT NOT NULL REFERENCES budget(id),
  user_id TEXT NOT NULL REFERENCES user(id),
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (budget_id, user_id)
);

-- ---------------------------------------------------------------- provider layer (immutable source of truth)
CREATE TABLE connection (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budget(id),
  provider TEXT NOT NULL CHECK (provider IN ('plaid', 'csv', 'fake')),
  provider_item_id TEXT,
  institution_id TEXT,
  institution_name TEXT NOT NULL,
  access_token_enc TEXT,             -- AES-256-GCM, base64 (iv || ciphertext); never returned by the API
  key_version INTEGER,
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'login_required', 'error', 'removed')),
  last_synced_at INTEGER,
  last_attempt_at INTEGER,
  error_code TEXT,
  days_requested INTEGER NOT NULL DEFAULT 180,
  sync_lock TEXT,                    -- owning sync_run id
  lock_expires INTEGER,
  resync_requested INTEGER NOT NULL DEFAULT 0,
  linked_at INTEGER NOT NULL,
  removed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX connection_budget ON connection(budget_id);
CREATE UNIQUE INDEX connection_item ON connection(provider, provider_item_id) WHERE provider_item_id IS NOT NULL;

CREATE TABLE provider_account (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budget(id),
  connection_id TEXT NOT NULL REFERENCES connection(id),
  provider_account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  official_name TEXT,
  type TEXT NOT NULL,
  subtype TEXT,
  mask TEXT,
  current_balance INTEGER,           -- cents, as the provider reports (cards: amount owed, positive)
  available_balance INTEGER,
  credit_limit INTEGER,
  iso_currency TEXT,
  balance_as_of INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (connection_id, provider_account_id)
);
CREATE INDEX provider_account_lookup ON provider_account(provider_account_id);

CREATE TABLE sync_run (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budget(id),
  connection_id TEXT NOT NULL REFERENCES connection(id),
  phase TEXT NOT NULL CHECK (phase IN ('fetching', 'applying', 'finalizing', 'done', 'failed')),
  run_start_cursor TEXT,
  restart_count INTEGER NOT NULL DEFAULT 0,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  applied_through INTEGER NOT NULL DEFAULT -1,  -- last page fully applied
  applied_events INTEGER NOT NULL DEFAULT 0,    -- events of page applied_through + 1 already applied (chunked apply)
  next_cursor TEXT,
  handoff_depth INTEGER NOT NULL DEFAULT 0,
  trigger TEXT NOT NULL DEFAULT 'manual',
  error_code TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sync_run_connection ON sync_run(connection_id, started_at);

-- Staged pages: metadata only. The page body is stored once in R2 (binding RAW) by the fetch step; staging rows
-- are pruned when the run is done or failed, while applied pages stay in R2 as the raw archive (see bank_page).
CREATE TABLE sync_page (
  sync_run_id TEXT NOT NULL REFERENCES sync_run(id),
  page INTEGER NOT NULL,
  budget_id TEXT NOT NULL,
  restart INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  next_cursor TEXT NOT NULL,
  has_more INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sync_run_id, page)
);

-- Every applied page, permanently: where its raw body lives in R2 and the body's SHA-256. Append-only.
CREATE TABLE bank_page (
  sync_run_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  budget_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  events INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sync_run_id, page)
) WITHOUT ROWID;
CREATE TRIGGER bank_page_no_update BEFORE UPDATE ON bank_page
BEGIN SELECT RAISE(ABORT, 'bank_page is append-only'); END;
CREATE TRIGGER bank_page_no_delete BEFORE DELETE ON bank_page
BEGIN SELECT RAISE(ABORT, 'bank_page is append-only'); END;

-- One-row table used by every fence (lease, watermark, summary version). ok has no default and must be 1:
-- INSERT OR REPLACE with a computed 0 fails the CHECK, which aborts the whole D1 batch.
CREATE TABLE lease_guard (
  id INTEGER PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

CREATE TABLE apply_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL
);
INSERT INTO apply_counter (id, seq) VALUES (1, 0);

CREATE TABLE bank_event (
  id INTEGER PRIMARY KEY,            -- equals apply_seq
  budget_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  sync_run_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  position INTEGER NOT NULL,
  apply_seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('added', 'modified', 'removed')),
  provider_txn_id TEXT NOT NULL,
  provider_account_id TEXT,
  payload TEXT NOT NULL,             -- normalized JSON
  raw_ref TEXT NOT NULL,             -- the provider's JSON for this record: R2 key of the page + '#' + list/index
  sha256 TEXT NOT NULL,              -- SHA-256 of payload
  created_at INTEGER NOT NULL,
  UNIQUE (sync_run_id, page, position)
);
-- id = apply_seq, so replay in apply order is a primary-key range scan and needs no extra index
-- (each index adds a D1 row write per insert).
CREATE TRIGGER bank_event_no_update BEFORE UPDATE ON bank_event
BEGIN SELECT RAISE(ABORT, 'bank_event is append-only'); END;
CREATE TRIGGER bank_event_no_delete BEFORE DELETE ON bank_event
BEGIN SELECT RAISE(ABORT, 'bank_event is append-only'); END;

CREATE TABLE bank_txn (
  provider_txn_id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  amount INTEGER NOT NULL,           -- cents, outflow negative
  date TEXT NOT NULL,                -- posted date (transaction date while pending)
  authorized_date TEXT,
  pending INTEGER NOT NULL,
  pending_provider_txn_id TEXT,
  raw_name TEXT NOT NULL,
  merchant_name TEXT,
  merchant_entity_id TEXT,
  provider_category TEXT,
  payment_channel TEXT,
  removed_at INTEGER,
  txn_key TEXT NOT NULL,
  first_apply_seq INTEGER NOT NULL,
  last_apply_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX bank_txn_account_date ON bank_txn(budget_id, provider_account_id, date);
CREATE INDEX bank_txn_key ON bank_txn(txn_key);

CREATE TABLE holding_snapshot (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE liability_snapshot (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  statement_balance INTEGER,
  statement_date TEXT,
  due_date TEXT,
  minimum_payment INTEGER,
  apr_bp INTEGER,                    -- APR in basis points
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX liability_latest ON liability_snapshot(budget_id, provider_account_id, as_of);

-- ---------------------------------------------------------------- core
CREATE TABLE account (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budget(id),
  provider_account_id TEXT,          -- provider_account.provider_account_id; NULL for manual/CSV accounts
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'budget' CHECK (role IN ('budget', 'tracking')),
  kind TEXT NOT NULL CHECK (kind IN ('checking', 'savings', 'credit', 'brokerage', 'ira', '401k', 'loan', 'asset')),
  budget_from TEXT NOT NULL,         -- later of budget start and link date; earlier rows are history
  starting_balance INTEGER NOT NULL DEFAULT 0, -- cents; checking/savings positive, cards negative (debt)
  starting_balance_confirmed_at INTEGER,
  opening_anchor INTEGER NOT NULL DEFAULT 0,   -- reported balance at link minus imported posted history
  stale_pending_days INTEGER NOT NULL DEFAULT 7,
  sort INTEGER NOT NULL DEFAULT 0,
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX account_budget ON account(budget_id);
CREATE UNIQUE INDEX account_provider ON account(budget_id, provider_account_id) WHERE provider_account_id IS NOT NULL;

-- ---------------------------------------------------------------- budget structure
CREATE TABLE category_group (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budget(id),
  name TEXT NOT NULL,
  is_bills INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE category (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budget(id),
  group_id TEXT REFERENCES category_group(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('spending', 'saving', 'cc_payment')),
  card_account_id TEXT REFERENCES account(id),  -- set only for cc_payment
  low_threshold INTEGER,             -- optional per-category Low amount (cents)
  due_day INTEGER,                   -- bills with a due date are never Low
  sort INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((kind = 'cc_payment') = (card_account_id IS NOT NULL))
);
CREATE INDEX category_budget ON category(budget_id);

CREATE TABLE assignment (
  budget_id TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES category(id),
  month TEXT NOT NULL,
  amount INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (budget_id, month, category_id)
);

CREATE TABLE target (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES category(id),
  type TEXT NOT NULL CHECK (type IN ('refill', 'set_aside', 'by_date', 'no_date', 'none')),
  amount INTEGER NOT NULL DEFAULT 0,          -- A (refill), N (set aside), B (balance targets)
  period_months INTEGER NOT NULL DEFAULT 1,   -- refill period: 1, 3, 6 or 12
  period_anchor TEXT,                         -- YYYY-MM the first period starts (refill > 1 month)
  target_month TEXT,                          -- by_date: funded by the start of this month
  monthly_contribution INTEGER,               -- no_date: optional C
  effective_from TEXT NOT NULL,               -- YYYY-MM; versions never change past months
  created_at INTEGER NOT NULL,
  UNIQUE (category_id, effective_from)
);

-- ---------------------------------------------------------------- payees and rules
CREATE TABLE payee (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  name TEXT NOT NULL,
  remember_category INTEGER NOT NULL DEFAULT 0,
  default_category_id TEXT,
  merged_into TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX payee_budget ON payee(budget_id, name);

CREATE TABLE payee_alias (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  pattern TEXT,                      -- cleaned raw-description key
  merchant_entity_id TEXT,
  payee_id TEXT NOT NULL REFERENCES payee(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX payee_alias_pattern ON payee_alias(budget_id, pattern);
CREATE INDEX payee_alias_merchant ON payee_alias(budget_id, merchant_entity_id);

CREATE TABLE rule (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  sort INTEGER NOT NULL,
  name TEXT NOT NULL,
  conditions TEXT NOT NULL,          -- JSON condition tree (AND with optional OR groups)
  actions TEXT NOT NULL,             -- JSON action list
  apply_to_pending INTEGER NOT NULL DEFAULT 1,
  stop_after INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX rule_budget ON rule(budget_id, sort);

-- ---------------------------------------------------------------- overlay (user intent)
CREATE TABLE txn_overlay (
  txn_key TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  payee_id TEXT,
  category_id TEXT,                  -- NULL = uncategorized (or split / transfer / RTA via flags below)
  to_rta INTEGER NOT NULL DEFAULT 0, -- inflow categorized to Ready to Assign
  income_tag TEXT,                   -- 'income' | 'rewards' | 'investment_withdrawal' | 'starting_balance'
  memo TEXT,
  budget_month TEXT,                 -- override (YYYY-MM)
  estimated_amount INTEGER,          -- your estimate for a bank pending row
  wont_clear INTEGER NOT NULL DEFAULT 0,
  transfer_state TEXT,               -- NULL | 'paired' | 'unsorted' | 'manual' | 'payment'
  transfer_account_id TEXT,
  wtm_state TEXT,                    -- NULL | 'waiting' | 'matched' | 'income' | 'send_back'
  categorized_by TEXT,               -- 'user' | 'rule' | 'payee' | 'provider'
  rule_id TEXT,
  field_edits TEXT,                  -- JSON {field: epoch ms} for most-recent-edit-wins merges
  reviewed_at INTEGER,
  orphaned_at INTEGER,               -- edits held after the row was removed (14 days)
  pending_at_link INTEGER NOT NULL DEFAULT 0, -- pending when its account was linked: budgeted even if dated earlier
  alert TEXT,                        -- JSON: amount changed on clearing, cleared despite won't-clear, conflict
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX txn_overlay_budget ON txn_overlay(budget_id);

CREATE TABLE manual_pending (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  txn_key TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES account(id),
  kind TEXT NOT NULL CHECK (kind IN ('pending', 'upcoming')),
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payee_name TEXT NOT NULL,
  repeats TEXT NOT NULL DEFAULT 'never' CHECK (repeats IN ('never', 'monthly', 'yearly')),
  matched_txn_key TEXT,
  matched_by TEXT,                   -- 'auto' | 'user'
  stale_snooze_until TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX manual_pending_account ON manual_pending(budget_id, account_id, date);

CREATE TABLE txn_split (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  txn_key TEXT NOT NULL,
  category_id TEXT,
  amount INTEGER NOT NULL,
  memo TEXT,
  absorbs_remainder INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX txn_split_key ON txn_split(txn_key);

CREATE TABLE txn_link (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('transfer', 'refund_of', 'reimbursement_of', 'pending_match', 'reissue')),
  from_key TEXT NOT NULL,
  to_key TEXT NOT NULL,
  amount INTEGER,                    -- reimbursement_of: how much of the inflow pays this owed item
  created_by TEXT NOT NULL CHECK (created_by IN ('provider', 'auto', 'user')),
  created_at INTEGER NOT NULL,
  undone_at INTEGER
);
CREATE INDEX txn_link_from ON txn_link(from_key);
CREATE INDEX txn_link_to ON txn_link(to_key);

CREATE TABLE expected_reimbursement (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  txn_key TEXT NOT NULL,
  split_id TEXT,
  amount INTEGER NOT NULL,           -- owed amount (cents); for fractions, recomputed when the amount posts
  fraction_num INTEGER,
  fraction_den INTEGER,
  expect_by TEXT,
  memo TEXT,
  rule_id TEXT,
  closed_at INTEGER,
  closed_month TEXT,
  closed_amount INTEGER,
  canceled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX expected_reimbursement_key ON expected_reimbursement(txn_key);

-- ---------------------------------------------------------------- derived caches
-- Budget lines: each logical transaction's effect on the budget (packages/domain BudgetLine), rebuilt on write
-- for the transactions that change. The recompute reads them by month.
CREATE TABLE budget_line (
  budget_id TEXT NOT NULL,
  txn_key TEXT NOT NULL,
  line TEXT NOT NULL,                -- suffix of the line id: '0', '1', 'owed:<item>', 'close:<item>', 'start'
  month TEXT NOT NULL,
  date TEXT NOT NULL,
  seq INTEGER NOT NULL,              -- time added, for same-day ordering
  -- Budget kinds (read by computeBudget) and three totals for the rule 10 identity and card coverage:
  -- 'wait' (Waiting to match), 'unsorted' (transfer sides not yet sorted), 'uncat' (uncategorized amounts).
  kind TEXT NOT NULL CHECK (kind IN ('rta', 'cat', 'owed', 'close', 'payment', 'debt', 'wait', 'unsorted', 'uncat')),
  account_id TEXT NOT NULL,          -- for payment and debt lines: the card account
  card INTEGER NOT NULL,             -- 1 when the account is a credit card
  category_id TEXT,
  amount INTEGER NOT NULL,
  ref TEXT,                          -- refunds: the purchase line id; owed and close: the owed item id
  PRIMARY KEY (budget_id, txn_key, line)
) WITHOUT ROWID;
CREATE INDEX budget_line_month ON budget_line(budget_id, month);

-- The read model for transactions (design: Data model): one row per logical transaction from bank_txn (not
-- removed) and manual_pending (unmatched, not deleted), with the overlay applied. Every screen queries this view.
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

-- One row per budget month: that month's category and card cells plus the carry-forward state and running Ready to
-- Assign components at its end (packages/domain MonthResult). One row per month keeps a first-month edit to about
-- 36 row writes instead of one per category per month.
CREATE TABLE month_snapshot (
  budget_id TEXT NOT NULL,
  month TEXT NOT NULL,
  state TEXT NOT NULL,               -- JSON (packages/domain StoredMonth)
  hash TEXT NOT NULL,                -- change hash of state; recomputes read only this to decide what to write
  PRIMARY KEY (budget_id, month)
) WITHOUT ROWID;

-- ---------------------------------------------------------------- ops
CREATE TABLE alert (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  type TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL,
  acked_at INTEGER,
  snooze_until TEXT,
  UNIQUE (budget_id, type, ref_key)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  budget_id TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  before TEXT,
  after TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_log_budget ON audit_log(budget_id, created_at);

CREATE TABLE setting (
  budget_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (budget_id, key)
);

CREATE TABLE health_status (
  budget_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (budget_id, key)
);

-- Account-wide D1 usage per UTC day (all Workers, migrations, exports), refreshed from GraphQL Analytics.
CREATE TABLE usage_day (
  day TEXT PRIMARY KEY,
  rows_read INTEGER NOT NULL,        -- from GraphQL Analytics as of refreshed_at
  rows_written INTEGER NOT NULL,
  est_read INTEGER NOT NULL DEFAULT 0,     -- this app's own counts since the last refresh
  est_written INTEGER NOT NULL DEFAULT 0,
  refreshed_at INTEGER NOT NULL
);

CREATE TABLE usage_event (
  id INTEGER PRIMARY KEY,
  budget_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  app_version TEXT NOT NULL,
  screen TEXT NOT NULL,
  event TEXT NOT NULL,
  target TEXT,
  value INTEGER
);
CREATE INDEX usage_event_at ON usage_event(budget_id, at);

CREATE TABLE usage_daily (
  budget_id TEXT NOT NULL,
  date TEXT NOT NULL,
  app_version TEXT NOT NULL,
  screen TEXT NOT NULL,
  event TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL,
  median_value INTEGER,
  PRIMARY KEY (budget_id, date, app_version, screen, event, target)
);

CREATE TABLE usage_note (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  screen TEXT NOT NULL,
  text TEXT NOT NULL,
  recent_events TEXT NOT NULL
);
