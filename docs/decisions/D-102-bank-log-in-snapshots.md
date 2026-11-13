# D-102: A sealed budget's bank log lives in the copy, travels in bank entries, and is part of snapshots (Nov 13, 2026)

Answers the open question in `docs/build-plan.md` ("decide with `bank_log_size` whether it lives in the copy or
beside it") and replaces the row "The bank log" of the table in `docs/privacy.md` 5.4, which said it is stored
beside the main copy and appended in chunks.

**Context.** The owner's bank log was measured at the move (Nov 12, 2026, `bank_log_size`): 504 pages and 891
events, about 2 MB. A device that files a sealed run writes the run's `bank_event` and `bank_page` rows into its
copy. Until now those rows went nowhere else: the bank entry carried only the budget tables, so another device that
took the entry had no bank log, and a snapshot held none. Filing itself does not read the log of earlier runs (it
reads the events past `budget.processed_through`, which are the run's own, and numbers new events from that
watermark), so a device that joined from a snapshot could already file the next run; but the copies of two devices
were not the same, and the record of what the bank said was on one device only.

**Decision.**

1. **In the copy.** The bank log stays in the copy's own `bank_event` and `bank_page` tables, with their append-only
   guards. 2 MB is about a fifth of a copy that is held in memory and saved whole today; a second store beside the
   copy (`copy/vault.ts`) would add a second encrypted file, its own save path and its own failure cases for a
   saving the size does not need. If the log grows past what one save handles (phase 0's memory measurement on the
   iPhone), the split comes then.
2. **In bank entries.** The two tables are recorded tables (`RECORDED_TABLES`, `local/engine.ts`): a filing's bank
   log rows go in its bank entry with the rest, and a filing that is taken back out takes them out too. A device
   that takes the entry adds them; a row it already holds is left as it is (`appendOnly`), as the guards require.
   A run's bank log is about 1 KB an event, well inside one write (about 1 MB); a write that is too large already
   files fewer runs at a time.
3. **In snapshots.** `SNAPSHOT_TABLES` is the recorded tables, so a snapshot holds the bank log and its table hashes
   cover it: two devices that drift in their bank log find out at the next check. 2 MB is three chunks of 900 KB
   more; a snapshot is written rarely and read row by row, a page at a time. A snapshot written before this lists
   no bank tables in its first line, and its hashes are compared without them.
4. **The move compares fewer tables.** The phone never read the bank log from the old routes, so the move's table
   comparison (`MOVE_TABLES`, `seal/cutover.ts`) leaves it out.
5. **Runs filed before this release.** Their bank log is on the device that filed them only. Each copy sends that
   part of its log once, as edits of a device-only route (`LogSession.shareBankLog`, `/api/device/bank-log`, a few
   hundred KB an edit), so every copy ends with the same log and the next snapshot check compares equal. A copy made
   from a snapshot sends nothing.
6. **The log from before the move stays on the server.** The 504 pages and 891 events filed by the server before
   Nov 12 are in the server's old tables only, which the owner's "Delete the readable copy" empties (D-99). No device
   holds them. Bringing them into the copy would need them in the log too (as edits, about 2 MB, so a few writes),
   or every copy would differ from every snapshot. Left open in `docs/build-plan.md`; nothing counts money from
   them.
