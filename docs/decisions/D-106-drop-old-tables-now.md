# D-106: Drop the old tables now, without the 31-day check (Nov 13, 2026)

**Decided by the owner** (chat, Nov 13, 2026): "Let's fix all that now, and delete the old tables and code".
Replaces D-99 items 1 to 4 (the stepped job that empties the old tables from the owner's tap, and its check 31 days
after the last step) and D-102 item 3 (drop the tables once phase 6 has emptied them, not before).

**Decision.**

1. **One store migration drops them** (`packages/db/store-migrations/0010_drop_old_tables.sql`): every table, view,
   index and trigger that only the old server path used, whether the job emptied it or not. It runs in every store,
   sealed or not; every budget is locked (D-102), so no store has a reader of them left. Each statement is
   `DROP … IF EXISTS`, so a fresh store, a store the job had partly emptied and the owner's store all end the same.
   What it keeps, and why, is listed in the migration itself.
2. **The `budget` row stays, with nothing in it but its id**, its name and its times: the store knows its budget by
   it. Its other columns (time zone, the first month, the cached Ready to Assign and the old watermarks) go.
3. **The store stops running budget migrations.** It ran `packages/db/budget-migrations` before its own; it now
   runs only those it has run already (0001 to 0012) and then its own. A later budget migration runs on the
   devices' copies only. A later store migration must not assume any table the drop removed.
4. **The purge goes**: `seal/purge.ts`, `/api/cutover/*`, its job (a `purge_old` job still queued is dropped
   unrun, like any kind the store no longer knows), the card in Settings → Privacy and its notes in `store_note`.
   The link check job (`stamp_links`) goes too: it stamped rows copied from `connection`, and nothing copies them
   any more; a new link is stamped when it is made.
5. **What the claims may say.** For the live store, "no readable copy" is true once the migration has run.
   Cloudflare's point-in-time recovery still holds the store's past states for 30 days, whatever is dropped: a
   restore to a time before the migration would bring the old tables back. So for Cloudflare's history it becomes
   true 30 days after the migration runs. `docs/claims.md` (claims 2 and 3) and Settings → Privacy say both. The
   phase 0 question (whether SQLite keeps freed pages readable inside a Durable Object) is still not answered.

**What it costs.** No check looks at the store again after the drop; the migration's own statements are the record.
The usage notes and counts the server kept before the lock (`usage_event`, `usage_daily`, `usage_note`) and the
investment snapshots (`holding_snapshot`) go with the rest: no code reads or writes them, on the server or on a
device, so nothing is moved. The bank log from before the lock (`bank_page`, `bank_event`, `raw_page`) goes too; no
device holds it (D-103 item 6).
