# D-67: The budget start is a date: rows dated before it belong to the starting balance (Nov 5, 2026)

**Decided by the owner** (chat, Nov 5, 2026). Changes `docs/design.md` Budget start ("Every transaction pending at
link, and the posted transaction it becomes, is budgeted even if its date is earlier") and the reading of Money rule 8
in `docs/sync-spec.md`. Builds on D-66 (the bank difference line).

**Context.** The owner's Accounts showed two cards off from the bank, by $156.87 (Wells Fargo) and $187.53 (Amex).
The backup of Nov 5 showed why. Four Wells Fargo purchases from Oct 31 were pending at the bank when it was linked on
Nov 1, but Plaid sent them only on Nov 4, already posted. Amex sent a $390.16 Hertz hold at link, removed it, and sent
the $187.53 charge as a new row with no link to the hold. Both were dated before the budget start, and neither was
marked pending at link, so the app treated them as history. They weren't in the stored starting balance either, so
the purchases were in no category and the accounts were off. Meanwhile five Atmos purchases from Oct 30–31 that were
pending at link were counted in November's Fun money. Whether an October purchase counted depended on bank timing the
owner can't see.

**Decision.**

1. **The row's date decides.** The budget date (the authorized date for a card purchase) is compared with the
   account's `budget_from`. A bank row dated before it is never in a category. A row dated on or after it is in the
   budget. Checking, savings and cards follow the same rule.
2. **The starting balance is the balance at the start of `budget_from`.** The stored starting balance is the bank's
   balance at link. Two kinds of rows adjust it (`packages/domain/src/budget/start.ts`, `startRole`):
   - **before**: dated before `budget_from` and not in the balance at link. This is a row pending at link (or now), or
     a posted row that arrived after the first sync, within 14 days of the link (settling) and dated at most 14 days
     before `budget_from`. It adds to the starting balance: on a card, to the starting debt (never to RTA); on
     checking and savings, to the RTA starting inflow.
   - **linkDay**: dated on or after `budget_from` but posted and already in the balance at link (it came with the
     first sync, when that sync ran within an hour of the link). It counts in the budget like any row and comes out
     of the starting balance, so it counts once.
   - "In the balance at link" means the row arrived within an hour of the connection's first row, or before the
     stored balance was read (Setup's last step saves it again, and records the time of the bank balance it showed).
     A posted row that matches a removed posted row (same account, amount and posted date: the bank sending it again)
     keeps that row's arrival. A link made before the account's budget start keeps only the pending rule. CSV history
     rows have no link.
3. **No new storage.** The role comes from what is stored: each row's first arrival (`bank_txn.created_at`), the
   connection's `linked_at` and first row, the account's `starting_balance_confirmed_at`, and `pending_at_link`.
   Filing now compares the budget date when it marks a row pending at link.
4. **After settling** (14 days after the link), a late row from before the start is history again, and the bank
   difference (D-66) shows it.
5. **What you see.**
   - Each linked account's page has a **Starting balance** (cards: **Starting debt**) row with "settling" or "final".
     It opens a sheet: the balance when you linked, the rows from before the start that came in later, the link-day
     rows counted in the budget instead, the total, and "Settling. Final on …" or "Final."
   - For 7 days after a late row comes in, Accounts shows "Starting debt updated: Hertz $187.53" under the account.
     (Replaced by D-70: no note on Accounts; the row moves to the ⋯ menu once final.)
     The account page says "Hertz $187.53 from Oct 29 came in late. It is part of your starting debt, not your
     budget."
   - The read-only sheet of such a row says "Part of your starting balance" instead of "Not counted".
   - Setup's link step says that purchases from before the start are part of the starting balance, and that some
     may come in over the next 2 weeks.
   - Lists leave out posted rows dated before the start, as before (D-62). A pending one is listed under Pending
     with the "Before your budget" badge, because the account's pending total counts it; its sheet is read-only. It
     never shows in Needs attention or in payee counts.
6. **Existing rows** (migration 0008): rows pending at link and dated before the start lose their category,
   Ready to Assign mark and splits. The old values go to the audit log (`transaction.starting_balance`). A card's
   pending purchase authorized before the start is marked pending at link. The phone's engine rebuilds every line
   once (`DERIVE_VERSION` 2).

**Limits.** If Plaid's first sync runs hours after the link, rows that posted in between count as in the balance
at link, and the bank difference shows them. A late refund on a card with no starting debt makes its unbudgeted
debt negative, as a credit balance at start would. A pending row from before the start can't be marked "won't
clear"; it leaves the starting balance when the bank removes it. The reissue match is by account, amount and posted
date only: two same-day purchases of the same amount, one reissued and one sent late, both stay history (the bank
difference shows it), and a reissue with a new posted date counts as late. Setup saves the balance the screen showed
with the time of the latest sync, so a sync that finishes between the two can leave its rows out.

**Money effect.** On the owner's budget of Nov 5: Wells Fargo active cash's starting debt grows by $156.87, Amex
platinum's by $187.53, and Atmos Summit's by $124.80 (four purchases, which leave Fun money, so it gets $124.80 back).
A $0.40 Atmos row authorized Nov 1 stays in November. Both "off from bank" lines go away. Ready to Assign doesn't
change, because card starting debt never touches it. On a checking account, a row that comes in late from before
the start lowers Ready to Assign, and the account page says why.
