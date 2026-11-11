-- Bank links, on the server only (docs/privacy.md 5.5 and section 8 step 4). After the cutover a budget's tables
-- are sealed and `connection` is emptied; what the server needs to go on fetching lives here: which Items the
-- budget holds, and each one's token (still encrypted under TOKEN_KEYS, with the connection id and key version it
-- was encrypted with). Until the cutover the cursor, the lock and the fetch state stay in `connection`.
--
-- `mac` is the Worker's stamp over the budget, the link, the Item and the token (packages/seal server-keys.ts): a
-- row can't be invented or moved to another budget. A migration is plain SQL and holds no secret, so copied rows
-- have none; a job stamps them, and checks first that the copied token still opens and the bank still takes it
-- (`checked_at`, `check_result`).
CREATE TABLE bank_link (
  id TEXT PRIMARY KEY,                  -- the link's id: the connection's id without its 'con_' prefix
  connection_id TEXT NOT NULL UNIQUE,   -- the id the token was encrypted with
  budget_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_item_id TEXT,
  access_token_enc TEXT,
  key_version INTEGER,
  linked_at INTEGER NOT NULL,
  mac TEXT,
  checked_at INTEGER,
  check_result TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX bank_link_budget ON bank_link(budget_id);

INSERT INTO bank_link (id, connection_id, budget_id, provider, provider_item_id, access_token_enc, key_version, linked_at, created_at)
SELECT iif(substr(id, 1, 4) = 'con_', substr(id, 5), id),
       id, budget_id, provider, provider_item_id, access_token_enc, key_version, linked_at, created_at
FROM connection WHERE removed_at IS NULL;

-- Until the cutover the two tables can't drift apart: every link made, changed or removed in `connection` shows
-- here at once, whatever code wrote it. A changed token or Item loses its stamp and its check. These triggers
-- exist on the server only (a phone never runs a store migration) and go at the cutover. (iif, not CASE: the
-- migration runner reads CASE's END as the end of a trigger body.)
CREATE TRIGGER bank_link_made AFTER INSERT ON connection WHEN NEW.removed_at IS NULL BEGIN INSERT INTO bank_link (id, connection_id, budget_id, provider, provider_item_id, access_token_enc, key_version, linked_at, created_at) VALUES (iif(substr(NEW.id, 1, 4) = 'con_', substr(NEW.id, 5), NEW.id), NEW.id, NEW.budget_id, NEW.provider, NEW.provider_item_id, NEW.access_token_enc, NEW.key_version, NEW.linked_at, NEW.created_at); END;
CREATE TRIGGER bank_link_changed AFTER UPDATE OF provider_item_id, access_token_enc, key_version ON connection WHEN NEW.removed_at IS NULL AND (OLD.provider_item_id IS NOT NEW.provider_item_id OR OLD.access_token_enc IS NOT NEW.access_token_enc OR OLD.key_version IS NOT NEW.key_version) BEGIN UPDATE bank_link SET provider_item_id = NEW.provider_item_id, access_token_enc = NEW.access_token_enc, key_version = NEW.key_version, mac = NULL, checked_at = NULL, check_result = NULL WHERE connection_id = NEW.id; END;
CREATE TRIGGER bank_link_removed AFTER UPDATE OF removed_at ON connection WHEN NEW.removed_at IS NOT NULL BEGIN DELETE FROM bank_link WHERE connection_id = NEW.id; END;
CREATE TRIGGER bank_link_restored AFTER UPDATE OF removed_at ON connection WHEN NEW.removed_at IS NULL AND OLD.removed_at IS NOT NULL BEGIN INSERT OR IGNORE INTO bank_link (id, connection_id, budget_id, provider, provider_item_id, access_token_enc, key_version, linked_at, created_at) VALUES (iif(substr(NEW.id, 1, 4) = 'con_', substr(NEW.id, 5), NEW.id), NEW.id, NEW.budget_id, NEW.provider, NEW.provider_item_id, NEW.access_token_enc, NEW.key_version, NEW.linked_at, NEW.created_at); END;
CREATE TRIGGER bank_link_deleted AFTER DELETE ON connection BEGIN DELETE FROM bank_link WHERE connection_id = OLD.id; END;
