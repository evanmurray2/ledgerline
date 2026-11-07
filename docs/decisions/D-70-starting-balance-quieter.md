# D-70: The starting balance note leaves Accounts; the row moves to the ⋯ menu once final (Nov 7, 2026)

**Asked by the owner** (chat, Nov 7, 2026): "Can't we just get rid of the starting balance updated note since it's in
the accounts page?" and "there won't be a need for it after a month or two; it is weird it has its own space." Also:
"the payment category just links to the budget page, that's a little weird." Changes item 5 of D-67
(`docs/decisions/D-67-start-date-rule.md`).

**Context.** On Accounts, a card could carry three muted lines at once: the bank difference (D-66), pending in the bank
balance (D-68) and "Starting debt updated: {payee} {amount}" (D-67). The last one repeats the account page's own note.
The account page gave the Starting debt row its own space for good, though it can change only in the 14 days after the
link.

**Decision.**

- Accounts no longer shows "Starting debt updated" / "Starting balance updated" (`AccountRow.startNote` is gone). The
  account page still says "{payee} {amount} from {day} came in late…" for 7 days after the row came in.
- The account page shows the Starting balance (cards: Starting debt) row while it is settling or a late row is new.
  After that it is an item in the page's ⋯ menu, which opens the same sheet.
- A card's Payment category row opens that category's sheet over the account page
  (`/accounts/{id}/category/{categoryId}`); closing it goes back to the account page.

**Money effect.** None: only where things show.
