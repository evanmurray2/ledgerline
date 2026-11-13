# D-105: Money in you added can be matched to what's owed to you (Nov 13, 2026)

**Decided by the owner** (chat, Nov 13, 2026): asked how to link a pending payback they had added to an owed item, and
told that Match showed only on money in from the bank, the owner answered "Money in, and yes" to adding Match to money
in you add, with the match moving to the bank's row when it posts. Extends D-98 point 2 (where Match is offered).

**Before.** The transaction sheet offered "Money back for something owed to you? Match" only on bank money in (an
`income` or `refund` sheet). An entry you added (Add pending) has the `manual` sheet, so a payback you typed in while
it was pending could not be matched until the bank's row posted.

**Decision.**

1. **Match on your entry.** The sheet of money in you added (a `manual` row, not an Upcoming one: that money hasn't
   come yet) offers Match, as bank money in does. The Match routes needed no change: they take any money in.
2. **It moves with your key.** While your entry covers the bank's pending row, and when the posted row takes the
   entry's key (D-64 points 3 and 4), the match stays on that key, so it is the posted row's match. Nothing is copied.
3. **Its amount can't go below what it pays back.** `PATCH /api/transactions/:key` refuses a lower amount
   (`too_little`): undo the match first.
4. **Deleting the entry undoes its matches** (Delete, and Delete on a check not cleared): what it paid back is owed
   again. A bank row that took the entry's key keeps its matches.

**Money effect.** None on how money is counted: rule 12 as it is. A matched entry is in Ready to Assign, all of it,
like matched bank money; the items it pays back are settled. Point 4 stops a deleted entry from still settling items.

**Not done.** Owed to you's "came in. Is it money back?" banner still offers only bank money from a person. A posted
amount below what the entry already pays back isn't caught (as for bank rows whose amount changes on posting).

Code: `apps/web/src/screens/TxnEdit.tsx`, `apps/worker/src/routes/transactions.ts`; tests
`apps/worker/test/entry-match.test.ts` and `entry-covers.test.ts`.
