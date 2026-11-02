-- Where requests are served (docs/multi-user.md 8.1): 'none' = D1 as today; 'frozen' = the move is copying, writes
-- wait; 'moved' = the Directory and the budgets' Durable Objects serve everything. One row. The freeze triggers that
-- enforce 'frozen' in the database come with the move itself.
CREATE TABLE move_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL CHECK (phase IN ('none', 'frozen', 'moved')),
  started_at INTEGER,
  lease_expires INTEGER,
  changes INTEGER NOT NULL DEFAULT 0,
  markers TEXT,
  updated_at INTEGER NOT NULL
);
INSERT INTO move_state (id, phase, updated_at) VALUES (1, 'none', 0);
