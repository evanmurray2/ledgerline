# D-98: No Waiting to match: money from a person counts like any other money in (Nov 12, 2026)

**Decided by the owner** (chat, Nov 12, 2026), after asking what Money to match is: "Can we remove money to match I
feel like its confusing", then, shown Money rules 9 and 10 and the choice between removing the hold and keeping it
with a clearer screen: "Yea I don't like this get rid of it." Changes Money rules 9, 10 and 12 in
`docs/sync-spec.md` and the Reimbursement links rows of `docs/design.md` (Match, Possible payback, and the Activity
row of the screens table).

**Before.** Money in from a person (a name with Zelle, Venmo, Cash App, PayPal transfer or Apple Cash) was held in
Waiting to match: in no category and not in Ready to Assign, listed under Activity → Needs attention → Money to match,
until you chose Match or Income. A match could keep the rest waiting, or keep it until you sent it back ("I'll send it
back"). Unlinking a match put the money back in Waiting to match.

**Decision.**

1. **Nothing is held.** Sync no longer marks money from a person as Waiting to match. It is placed like any other
   money in: Ready to Assign for money into checking or savings (D-85); a card credit or a deposit that looks like a
   transfer still needs a category.
2. **Match stays**, from the transaction's sheet ("Money back for something owed to you? Match") and from Owed to you.
   It links the money to what it pays back and settles those items; all of the money is in Ready to Assign, the
   matched part and any rest alike. The rest choices (Keep it waiting to match, Count it as income, I'll send it back)
   are gone. "It's income" stays: it puts the money in Ready to Assign as your choice. `MatchRequest.rest` is ignored
   and optional, so an edit an older app queued offline still applies.
3. **Unlink** opens the owed items again and puts the money back where the usual rules place it (point 1).
4. **Owed to you offers the newest money in from a person** in the last 30 days that pays back nothing yet, and that
   you haven't called income or a transfer: its banner ("Venmo +$40.00 came in. Is it money back? Match") and each
   item's Match money back open the Match sheet for it. It is only offered; nothing is held or counted for it, and it
   is not in Needs attention.
5. **Money held when this shipped is released once** (budget migration `0012_release_waiting_to_match.sql`, server
   and phone): a row that already pays back something becomes matched (all of it in Ready to Assign); a row with
   nothing matched goes back to the usual rules. Each released row is in the audit log
   (`transaction.release_waiting`). Ready to Assign goes up by what was held.
6. **Rule 10** loses its Waiting to match term (it is always 0). The domain still has the `waiting` use and the
   `wait` line kind, which nothing produces now; removing them (with the November fixture's held Venmo row) is open
   work in `docs/build-plan.md`.

Code: `apps/worker/src/sync/file-fresh.ts`, `apps/worker/src/ledger/ledger.ts` (`useOf`),
`apps/worker/src/routes/activity.ts` (Match, Unlink, `possiblePayback`), `apps/worker/src/routes/activity-view.ts`,
`apps/web/src/screens/ActivityMatch.tsx`, `apps/web/src/screens/Owed.tsx`.
