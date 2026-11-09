# D-80: Close out and Remove the mark can be undone; an earlier month stays as it was (Nov 9, 2026)

**Decided by the owner** (chat, Nov 9, 2026): asked how undoing Close out should count when the item was closed in an
earlier month, the owner chose "Option B": the earlier month stays as it was, and the amount moves back in the month of
the undo. Adds to Money rule 11 (`docs/sync-spec.md`), which had Close and Cancel but no way back.

**Decision.**

1. **Reopen.** `POST /api/owed/:id` takes `{ action: 'reopen' }`. It undoes Close out on a closed item and Remove the
   mark on a canceled one. The item is open again, with its amount and paybacks as they were.
2. **Closed this month:** reopening is as if it was never closed.
3. **Closed in an earlier month:** that month keeps its close line, so its numbers don't change. The undo is a close
   line of the opposite amount in the month of the undo: the original category gets the amount back and Ready to
   Assign gives it up. Both lines are stored in `owed_close` (migration 0010, synced to the phone); the item's
   `closed_at`, `closed_month` and `closed_amount` keep holding only its current close, so closing it again works as
   before. Past closes and their undos count even if the mark is removed later, so the earlier month never changes.
4. **Remove the mark** is undone as if it never happened. Rule 11 counts it in the transaction's own month, so there is
   no later month to move it to.
5. **Where.** Undo on the Close out sheet's done step (Close out and Remove the mark, as before for Give it more time),
   and Reopen on items under **Closed out** on Owed to you (closed in the last three months).

**Money effect.** As above: a close undone in a later month leaves that month as it was and moves the amount in the
month of the undo (`packages/domain` `pastCloses`; property test "Reopen in a later month (D-80)" and
`apps/worker/test/owed-reopen.test.ts`).

**Not done.** "Not this purchase" on a card refund: no code makes a `refund_of` link outside the test data, so there is
nothing to unlink yet (`docs/build-plan.md`).
