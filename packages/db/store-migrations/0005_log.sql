-- The sealed, signed log of a budget (docs/privacy.md 5.3; docs/privacy-keys.md 7). After the cutover this is
-- where a budget lives on the server: each entry as its device signed it, in order, and where the chain stands.
-- The server reads the clear header of an entry and never its sealed body. Nothing writes here before the
-- cutover.
CREATE TABLE log_entry (
  number INTEGER PRIMARY KEY,   -- 1 for the genesis entry, then up by 1
  entry_id TEXT NOT NULL,       -- hex; the same in every part of one change (safe to resend, 5.3 check 3)
  part INTEGER NOT NULL,
  kind INTEGER NOT NULL,
  hash TEXT NOT NULL,           -- hex: H(header)
  bytes TEXT NOT NULL,          -- base64: the entry as its device encoded it
  created_at INTEGER NOT NULL
);
CREATE INDEX log_entry_id ON log_entry(entry_id, part);
CREATE INDEX log_entry_kind_day ON log_entry(kind, created_at);

-- Where the log stands after its last stored write (packages/seal chain.ts StoredChain, as JSON): the server
-- checks each new write against it and never walks the log again.
CREATE TABLE log_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  number INTEGER NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
