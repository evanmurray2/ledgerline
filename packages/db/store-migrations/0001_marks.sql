-- Store migrations (docs/privacy.md 5.3, section 8 step 2): tables that only the server's BudgetStore keeps. A
-- phone never runs these (its copy runs the budget migrations only), so nothing here can reach a device.
--
-- Marks on a budget (section 8 step 3). 'sealed': the budget lives in the sealed log, and the old code paths
-- (routes, alarms, webhooks) must not touch it. 'frozen': the budget is being moved; every write and job is
-- refused until `until`, after which it counts as not frozen, untouched.
CREATE TABLE store_mark (
  key TEXT PRIMARY KEY CHECK (key IN ('sealed', 'frozen')),
  at INTEGER NOT NULL,
  until INTEGER,
  note TEXT
) WITHOUT ROWID;
