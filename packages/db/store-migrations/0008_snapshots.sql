-- Snapshots of a sealed budget (docs/privacy.md 5.3; docs/privacy-keys.md 8). A device writes its whole base,
-- sealed, in chunks, under a sealed manifest and a clear header it signs. The server reads only the header. A
-- snapshot is whole when every chunk is stored, and checked when a device says, with a signature, that it rebuilt
-- the budget and got the same. Older entries and filed bank runs are deleted only for a checked snapshot, and
-- the snapshot before it is kept. Nothing writes here before the cutover.
CREATE TABLE snapshot (
  id TEXT PRIMARY KEY,              -- the snapshot's id (a ULID its device made)
  number INTEGER NOT NULL,          -- the log entry it stands at
  key_version INTEGER NOT NULL,
  header BLOB NOT NULL,
  signature BLOB NOT NULL,
  manifest BLOB NOT NULL,           -- sealed
  chunks INTEGER NOT NULL,          -- how many chunks it has
  whole_at INTEGER,                 -- every chunk is stored
  check_signature BLOB,
  check_device TEXT,
  checked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX snapshot_number ON snapshot(number);

CREATE TABLE snapshot_chunk (
  snapshot_id TEXT NOT NULL,
  k INTEGER NOT NULL,               -- from 1
  bytes BLOB NOT NULL,              -- sealed
  PRIMARY KEY (snapshot_id, k)
);

-- Small numbers the store keeps for itself. `log_floor`: the entry number below which sealed entries may have
-- been deleted (a device whose place is lower opens a snapshot).
-- `snapshot_day`, `snapshots_begun`: how many snapshots were begun on the current day (they have a daily limit).
CREATE TABLE store_note (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
