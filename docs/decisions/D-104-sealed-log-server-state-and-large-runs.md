# D-104: The sealed log's state on the server, and a bank run too large for one write (Nov 13, 2026)

Closes four server items of the privacy design (`docs/privacy-keys.md` 7.2, 8) and decides one more. Where the build
differs from the design's words, this file says how and why.

1. **One lock is the storing transaction's fence.** 7.2 says "the server checks and stores a write under one lock".
   A Durable Object lets a second request in while the first waits on WebCrypto, so the check itself is not under a
   lock. The lock is the step that stores: one `transactionSync` (`DurableDb.batch`) that first checks the log still
   ends at the write's base and that no bank run was completed since the check, then writes the entries, the chain
   state, the device counters and the day's count. Two writes checked against one state can't both be stored; the
   second is told "behind" and reads on. `apps/worker/test/log-store.test.ts` holds one write at its storing step
   while another is stored.
2. **Device counters are rows; the list of public entries is not kept.** The chain state was one JSON value, parsed
   and written whole on every append, and it grew with every device and every public entry. Now each counter is a
   row of `store_note` (`device:<id>`), read only for the devices of a write. The server never read the list of
   public entries (`PublicState.publics`): the entries themselves are rows of `log_entry`, never deleted, so the
   list is dropped from what is stored. The 4,096-device limit, which the rules can't see from the counters of one
   write, is checked by the server. No migration: `store_note` is a table the purge keeps (`seal/purge.ts`
   `KEPT_TABLES`), so a new table could not be emptied by a purge already under way, and a state in the old format
   (every counter in the JSON value) is read as it is and moved to rows at its next write. The value written keeps
   `counters` and `publics`, empty, so that a rolled-back release still reads it (it would then refuse writes on
   the device counter until the next release, and never fork the log).
3. **Entries are stored as BLOBs.** Base64 made a byte at a time cost about 33 ms per 1 MB write. New rows are BLOBs
   in the same column; rows stored as text stay as they are and are sent as they are.
4. **The never-held kinds are counted per day in a note.** The count came from today's rows of `log_entry`, and the
   delete rule may remove a sign-out stored today. It is now noted in `store_note` (`key_day`, `key_entries`) in the
   storing transaction; the higher of the note and today's rows counts, so today's count carried over. The limit
   stays 32 a day, at most 4 a write.
5. **The entry a snapshot stands at stays while the snapshot does.** The delete rule kept the entry of the kept
   snapshot, but a snapshot being deleted keeps its row until its last chunks go (a few a call), and its entry could
   go first. Now no entry is deleted while any snapshot row names it.
6. **A sealed page is one row.** Durable Object SQLite allows a string, BLOB or row of up to 8 MB (Cloudflare's
   limits page, read Nov 13, 2026). The largest sealed page is about 220 KB, a snapshot chunk at most 1.1 MB, a log
   entry about 64 KB: none is split.

## A bank run too large for one write

A write holds at most 16 entries, so a change set has at most 16 parts, about 1 MB of rows (`MAX_WRITE_ENTRIES`;
32 entries do not fit 10 ms of CPU). A daily run is a few KB. A new link's first run with transactions brings 180
days of history: for a busy card that is over a thousand transactions, and the rows a filing writes for each (the
bank event and the bank row, every column) are likely to pass 1 MB. That size was not measured. Today the device
halves the runs in an entry down to one, then stops with `TooLarge`, and every edit waits behind the unfiled run
("bank runs first"). Options:

- **More entries in a write.** Refused: the CPU limit.
- **One run over several bank entries.** Refused: a bank entry files whole runs with one receipt each, and an edit
  between two halves would break "bank runs first".
- **The Worker ends a run between bank pages.** Refused: when the bank's data changes during a sync, Plaid asks for
  the whole sync to start again from its first cursor, which a filed half can't undo.
- **Compress the change set before it is sealed.** Rows of this kind are text that repeats; deflate commonly makes
  them 5 to 10 times smaller, so 16 parts would hold several MB of rows. One change on the device (`local/`,
  packages/seal entry bodies) under a new processing version; the server's rules don't change.
- **A staged write.** The parts of one set go over several requests into a table apart from the log and are
  appended as one set in the last request. Every rule holds, at the cost of new server code and a table.

**Decided:** compress the change set (deflate) under a new processing version, and measure the rows of a real
180-day first run in that PR. A staged write is built only if a compressed first run still passes 16 parts. Neither
is built yet: the device side of the log is other work in progress, and the change is not small. Until then, a new
bank linked to a locked budget may stop filing at its first run with transactions.

## Built: compressed change sets (Nov 13, 2026)

This replaces "Neither is built yet" above: the compression is built; the staged write is not.

- **Where it runs: on the device.** The change set exists only there: the device files the run and seals the rows
  it wrote, and the server never sees them in the clear. Sealed bytes don't compress, so the server's fetch job
  can't help, and compressing the bank's pages would not shrink the rows a filing writes. The 10 ms rule is the
  server's, so the device's compression costs it nothing; the server's rules and CPU don't change (it stores fewer
  entries for a large set).
- **Format** (`apps/worker/src/local/change-set.ts`, `docs/privacy-keys.md` 6.2): a change set whose JSON needs more
  than one part is `0x01 || u32(JSON length) || deflate-raw(JSON)`, with `CompressionStream`, which every browser
  has had since 2023 (Safari 16.4) and Workers have: no library, nothing added to the app's bundle. Its entries
  carry **schema version 3**, not a new processing version: an app on today's release checks only the schema
  version when it reads (`advance`), so a new processing version would let it read the compressed bytes as JSON
  and stop with "not a change set". With schema version 3 it stops at the header with `UpdateNeededError` and takes
  nothing. A change set that fits one part (an edit, a daily scan or a daily bank run is a few KB) stays plain
  under schema version 2, so a device on today's release keeps reading those; it meets version 3 only for a large
  set, and a reload brings the new release. A new app reads both. The server takes schema versions up to 3.
- **Measured** with a test first run of 2,000 transactions over 180 days (`apps/worker/test/sealed-large-run.test.ts`,
  random Plaid-style ids, ten merchants): about 8,000 rows, 5.14 MB of JSON (79 parts) plain, 8 parts compressed. Each
  transaction is about 2.6 KB plain and 250 bytes compressed (random ids are most of it), so one write holds a run
  of about 4,000. This is test data: a real 180-day run is still to be measured.
- **Larger than a write even compressed:** nothing is dropped. The device takes the filing back out of its copy,
  files fewer runs to an entry, and for a single run stops with "A bank update is too large for this version of
  Ledgerline to save. It waits on the server. Nothing is lost." The run stays on the server and edits wait behind it
  ("bank runs first"). The staged write above is built only if a real run needs it.

## Built: counters as rows only, entries as BLOBs (Nov 13, 2026)

The release with items 2 and 3 still wrote every device counter into the JSON value and entries as base64 text, so
that a rollback found the format it knew. The next release writes counters as rows only (the value keeps
`counters` and `publics`, empty) and entries as BLOBs. It reads both forms: a row stored as text is read and sent
as it is and never rewritten, and a value that still holds counters (stored by the release before, or after a
rollback to it) has them moved to rows at its next write, a few rows in that write's transaction. No migration.
A rollback of this release goes to the one before, which reads rows and BLOBs.

## Checked: no staged write (Nov 13, 2026)

A compressed first run fits one write up to about 4,000 transactions; the owner's whole budget brings about 900 in
180 days (`docs/measurements.md`, "the sealed log's limits"). The staged write stays unbuilt.
