-- Where requests are served (docs/multi-user.md 8.1): 'none' = D1 as today; 'frozen' = the move is copying and D1
-- refuses every write (migration 0012's triggers); 'moved' = the Directory and the budgets' Durable Objects serve
-- everything, and D1 still refuses writes; 'restoring' = the way back is copying into D1, which accepts writes
-- again. One row.
CREATE TABLE move_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL CHECK (phase IN ('none', 'frozen', 'moved', 'restoring')),
  started_at INTEGER,
  lease_expires INTEGER,
  markers TEXT,
  updated_at INTEGER NOT NULL
);
INSERT INTO move_state (id, phase, updated_at) VALUES (1, 'none', 0);
