-- Bank runs of a sealed budget (docs/privacy.md 5.5; docs/privacy-keys.md 9). After the cutover the fetch step
-- seals each page it fetches to the budget's inbox key and signs the run; the server keeps nothing readable of
-- it. Nothing writes here before the cutover.

-- The signing and inbox public keys the server took from a checked log entry, each with the Worker's stamp
-- (`keyMac`, 9.2), so someone who can write to the database can't put a key of their own here and have bank data
-- sealed to it. kind 1: a signing key. kind 2: an inbox key.
CREATE TABLE key_stamp (
  kind INTEGER NOT NULL CHECK (kind IN (1, 2)),
  version INTEGER NOT NULL,
  pub TEXT NOT NULL,            -- hex, 32 bytes
  mac TEXT NOT NULL,            -- hex
  n INTEGER NOT NULL,           -- the Worker key number that stamped it
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, version)
);

-- Where the budget's runs stand: the last complete run, the hash of its manifest and its time. With every row of
-- `link_cursor` it is the budget's whole run state, under one stamp (`runsMac`, 9.2), written in the step that
-- completes a run and checked before the next fetch.
CREATE TABLE run_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run INTEGER NOT NULL,
  last_manifest_hash TEXT NOT NULL,   -- hex; zeros before any run
  last_run_time INTEGER NOT NULL,
  mac TEXT NOT NULL,                  -- hex
  n INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Each link's cursor after its last complete run.
CREATE TABLE link_cursor (
  link_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The one run being fetched. A budget's runs are numbered across all its links, and a page is sealed under its
-- run's number, so one link fetches at a time.
CREATE TABLE run_stage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  link_id TEXT NOT NULL,
  run INTEGER NOT NULL,
  restart INTEGER NOT NULL,
  inbox_version INTEGER NOT NULL,
  n INTEGER NOT NULL,                 -- the Worker key number of the run's receipts and signature
  start_cursor TEXT NOT NULL,         -- the link's cursor before the run ('' for a link's first run)
  cursor TEXT NOT NULL,               -- after the last page fetched
  has_more INTEGER NOT NULL,          -- the bank has another page of transactions
  describes INTEGER NOT NULL,         -- 1: the link's first run, which holds its description and no transactions
  pages INTEGER NOT NULL,
  added INTEGER NOT NULL,
  modified INTEGER NOT NULL,
  removed INTEGER NOT NULL,
  started_at INTEGER NOT NULL
);

-- Sealed pages: of the run being fetched, and of each complete run until a checked snapshot covers it.
CREATE TABLE sealed_page (
  run INTEGER NOT NULL,
  page INTEGER NOT NULL,
  what INTEGER NOT NULL,              -- 0 transactions, 1 balances, 2 liabilities, 3 the link's description
  hash TEXT NOT NULL,                 -- hex: H(sealed page)
  bytes BLOB NOT NULL,
  PRIMARY KEY (run, page)
);

-- Complete runs: the manifest the Worker signed. `receipt_hash` and `first_cursor` stay after the pages are gone.
CREATE TABLE sealed_run (
  run INTEGER PRIMARY KEY,
  link_id TEXT NOT NULL,
  manifest BLOB NOT NULL,
  signature BLOB NOT NULL,
  receipt_hash TEXT NOT NULL,         -- hex: H(receipt), which a filing entry must match
  first_cursor TEXT NOT NULL,
  pages INTEGER NOT NULL,
  run_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
