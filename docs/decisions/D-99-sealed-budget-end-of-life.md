# D-99: The rest of phases 5 and 6 for a sealed budget: idle rules, delete with banks, device backup, emptying the old tables (Nov 12, 2026)

Builds what `docs/privacy.md` phase 5 still lacked (the idle job, Delete account with banks, restore retired, the
backup on the device) and phase 6 (section 8, steps 8 and 9). Where the build differs from the design's words, this
file says how and why.

1. **Emptying the old tables starts only from the owner's tap.** The design (section 8 step 8) says "a stepped job
   under the breaker empties the tables over days". It is that job (`apps/worker/src/seal/purge.ts`), but nothing
   queues it but `POST /api/cutover/purge`: Settings → Privacy → "Delete the readable copy…", after `ConfirmInline`
   and a passkey check at most 2 minutes old on the server. Deleting the owner's real data can't be undone, so no
   deploy, migration or daily job starts it. The route and every step refuse a budget that is not sealed. Once it
   began, the way back is shut too. **Changed Nov 13, 2026** by the owner ("I want to delete readable copy now"):
   it may start while the way back is still open; the card and its confirm say that it ends the way back.
2. **The triggers go by the job, not by a store migration.** The design says a store migration drops the triggers
   that refuse deletes (`bank_event`, `bank_page`, `raw_page`) and write `change_log` rows. A migration runs in every
   budget's store, sealed or not, and would also have broken the way back. The job's first steps drop, in this one
   store, every trigger on an old table and on `budget` (20 a step), including `bank_link_deleted` on `connection`,
   which would otherwise delete the sealed budget's bank links with the old rows. A later budget migration must not
   assume those triggers exist (use `DROP TRIGGER IF EXISTS`).
3. **What is emptied.** Every table but the sealed ones (`store_mark`, `bank_link`, the log, the runs, the
   snapshots, `store_note`), the job queue and `budget`: the old budget tables, the change log, the undo records,
   and the shadow run's plain inbox (`inbox_run`, `inbox_scan`). Children go before parents, a few rows a step (4 for
   bank pages, 200 for most), at most 20,000 rows written a day, and the breaker's pause holds it to the next day.
   The `budget` row stays, because the store knows its budget by it; its name is set to empty. The store's own
   readers of `budget.name` (`BudgetStore.info`) give no name for a sealed budget.
4. **The check, 31 days after the last step** (Cloudflare keeps 30 days of past versions): every old table is looked
   at for a row, with the budget's name in the store and in the Directory (which only ever holds "My budget"). The
   result is kept in `store_note` and shown in Settings → Privacy. The phase 0 question, whether SQLite keeps deleted
   rows in freed pages inside a Durable Object, is not answered by this check.
5. **A3 for a sealed budget.** "Opened" is a request of a signed-in person that reaches the sealed store, noted at
   most hourly (`store_note.opened_at`); before the first one, the cutover's time. Past 90 days, the backstop queues
   no fetch and the bank's webhooks only note news on the link; the next request asks every link for a fetch at
   once. A budget that is not sealed still fetches as before (A3 there is not built).
6. **24 months.** As 5.8: the Directory's daily `expire_idle` job marks a budget (`expire:<budget>`) when every
   member's later of creation and last request is over 730 days ago, clears the mark on a later request, and 30 days
   after the mark starts the same deletion as Delete account, at most 3 a day; a deletion under way is queued again
   daily. Never an admin's account or one turned off. Health does not show the count yet; the job logs
   `idle_accounts` with counts only.
7. **Delete account with banks.** The delete job removes each link at Plaid (`/item/remove`) with its stored token
   before the store wipes itself; "already gone" answers count as removed, and any other failure retries the job.
   The store refuses unless the Directory holds the deletion record; the job refuses an admin's account; and the
   removal refuses Plaid Production without `OTHER_USERS_BANKS` (Plaid Trial, where only the admin links banks). For
   a sealed budget the server can't check the typed name; the app checks it against the copy on the device. The
   request is not signed with the budget's key yet (5.5 asks for it).
8. **The full backup of a sealed budget** is the device's copy as one SQLite file, made after a fresh passkey prompt
   (the same "Confirm it's you" dialog). By default it is sealed with a key the recovery key gives
   (`docs/privacy-keys.md` 5, `packages/seal` backup.ts): the person types the recovery key on that screen, and a slip
   is caught by its check bytes. It is not checked against the budget's current recovery slot. Saved without a lock,
   the screen warns first. `GET /api/export/dump` already refuses a sealed budget (its routes are the log's); the
   server's rewind is refused for it too (`restoreTo`, `restoreUndo`, `restoreDump`), and Settings → Backup says so. As
   5.8 says, the two open items about restoring a full backup close as not wanted.
