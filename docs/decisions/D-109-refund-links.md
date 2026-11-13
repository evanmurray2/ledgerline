# D-109: Linking a card refund to its purchase (Nov 13, 2026)

`docs/design.md` (Credit card refunds) says you can link a card refund to its purchase, and Money rule 3
(`docs/sync-spec.md`) already counts a linked refund: the payment category gives back the funded part of that purchase,
capped at the refund. Nothing made the link outside the test data (D-80, "Not done"). This builds it. The Money rules
are unchanged: only you make or remove a link, and the counting is rule 3 as written.

**Decision.**

1. **Where.** On a card refund's transaction sheet. Unlinked: "Refund of a purchase on this card?" with Pick it, which
   lists the purchases to pick from. Linked: the purchase under Refund of, with **Not this purchase** (a toast with
   Undo follows).
2. **Which purchases.** Money out on the same card, dated in the 90 days up to the refund, newest first, at most 40:
   the refund's payee first (From {payee}), then the card's other purchases. The design's "a rule suggests this when
   the payee matches" is the order of that list; nothing is linked by itself. Not offered, and refused: transfers,
   scheduled rows, rows marked won't clear, rows from before the budget start, money in, and other accounts' rows.
3. **One purchase per refund.** A new pick replaces the old link. Money in that pays back what's owed to you can't also
   be a refund: undo the match first.
4. **The category stays yours.** Linking doesn't change the refund's category. When the purchase has a category the
   refund doesn't, the sheet offers **Put in {category}**, which you save with Save.
5. **API.** `GET /api/transactions/:key/refund-of` (`RefundOfView`) and `POST /api/transactions/:key/refund-of`
   (`RefundLink`, `purchaseKey: null` to unlink), engine routes in `apps/worker/src/routes/refunds.ts`. A link is a
   `txn_link` row of kind `refund_of`; unlinking sets its `undone_at`. No migration.

**Money effect.** None beyond rule 3: a linked refund gives back the funded part of the linked purchase (capped at the
refund), an unlinked one `min(r, max(P, 0))`. A link or unlink rebuilds both transactions' budget lines, so the copy
works the budget out again from the purchase's month (`apps/worker/test/refund-link.test.ts`, twin cases in
`apps/worker/test/twin.test.ts`).
