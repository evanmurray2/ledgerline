# D-73: Close an account only at $0; a new row opens it again (Nov 8, 2026)

**Decided by the owner** (chat, Nov 8, 2026). Fills in `account.closed_at` from `docs/design.md` (Data model), which
nothing set until now.

**Context.** An account closed at the bank stayed on Accounts with its last balance, and a card kept its payment
category on Budget. The owner asked how to close one.

**Decision.**

1. **Close only at $0.** Close account (the account's ⋯ menu) runs only when the bank balance is $0, nothing is
   pending or upcoming, the working balance is $0 and, for a card, its payment category has $0 available. Otherwise
   the sheet says why (`closeBlocked` in `apps/worker/src/routes/account-close.ts`). The phone sends the working
   balance, the available and its change number, as archiving a category does (D-45); the server refuses if anything
   changed since, and checks the bank balance and pending rows itself.
2. **What closing does.** The account leaves Accounts (a Closed list at the bottom opens its register) and the Add
   list; a card's payment category is archived and leaves Budget. Every row stays, so past months don't change. The
   bank link is kept: closing never removes a Plaid Item.
3. **Opens again on a new row.** A new row from the bank (an `added` event in the sync's apply step) or an entry you
   add opens the account again, with its payment category. Reopen account in the ⋯ menu does the same by hand.
4. Settings → Categories doesn't list a closed card's payment category as archived: it comes back with the card.

**Money effect.** None: closing needs every balance at $0, so no money moves and every number stays the same.

**Cost.** One more pair of `UPDATE`s per applied chunk that holds an `added` row; they touch rows only for a closed
account.
