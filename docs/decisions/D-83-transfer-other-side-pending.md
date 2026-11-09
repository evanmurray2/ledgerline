# D-83: A transfer's other side can be picked before it arrives, as a pending entry (Nov 9, 2026)

**Decided by the owner** (chat, Nov 9, 2026): "I want to be able to pick an account even if it hasn't received a
transfer yet", and, asked how the money counts until the other side arrives: "Why can't it just be pending?"

**Before.** "Which account got this money?" (`docs/design.md`, Transfer detection) listed only accounts with a row
of the opposite amount within 5 days. When the other bank hadn't sent its side yet, the only answers were an account
that isn't linked, or a payment.

**Decision.**

1. **Every other open budget account is offered**, below the ones with a matching row, as "Pending until the bank
   sends it". The route takes `accountId` with `otherKey: null` (`TransferPick`).
2. **Picking one adds a pending entry** in that account: the opposite amount, the row's date, named "Transfer from
   {account}" (or "to"), paired with the row as a transfer (both overlays `paired`, one `txn_link`). It counts as any
   entry of yours does (`docs/design.md`, Pending in the budget): in the account's pending and working balance, in
   no category, and not in Ready to Assign. A pending payment to a card draws its payment category as a paired
   transfer always has.
3. **The bank's row takes the entry over** when it comes, like any entry (`docs/payee-names.md` 9.2), so the pair
   stays. For an entry that is a transfer's other side, the exact amount is evidence on any day of the candidate
   window (`entryEvidence`); other entries still need the same name or the same day.
4. **If the bank never sends it,** the entry is a stale pending entry like any other (Check these).
5. **Undo** (unpair) deletes the entry while the bank hasn't taken it over; after that, both halves stay as rows.
6. An account whose budget starts after the row's date is refused: the entry would be history there.

**Money effect.** None on categories or Ready to Assign: the money moves between your accounts, as a paired
transfer. Until the other side posts, the receiving account's working balance includes the pending entry.
