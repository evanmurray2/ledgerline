-- Posted totals per account per finished month, so Accounts and Reports don't re-add every posted transaction after
-- each change (apps/worker/src/ledger/totals.ts). A month's totals are computed the first time they're needed and
-- reused until something that could change them happens: the sync's apply step (old and new dates of every row it
-- touches), processing (from the earliest month it touched), CSV history import, or re-pointing an account. The
-- current month is always added up live. month_total_done marks months whose totals are complete; an account
-- with nothing posted that month has no row.
CREATE TABLE account_month_total (
  budget_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  month TEXT NOT NULL,
  posted_all INTEGER NOT NULL,        -- every posted row dated that month (Reports)
  posted_in_budget INTEGER NOT NULL,  -- the rows the budget counts: dated from the account's budget start, or pending at link
  PRIMARY KEY (budget_id, month, account_id)
) WITHOUT ROWID;

CREATE TABLE month_total_done (
  budget_id TEXT NOT NULL,
  month TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (budget_id, month)
) WITHOUT ROWID;
