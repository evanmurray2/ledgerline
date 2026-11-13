# D-93: Close an account that still has pending rows (Nov 12, 2026)

**Decided by the owner** (chat, Nov 12, 2026): "I want to close out the account. To do that I need zero balance.
Which means the bank must post this row. But I don't think it's going to." Asked to approve the rule below:
"Approve". Changes D-73 item 1.

**Widened the same day** (owner, chat: "The pending row came from the bank…", then "Yes"): the rule first took only
your own entries. The owner's row was the bank's own pending row, so a pending row from the bank now stays in the
same way. The text below is the rule as it stands.

**Context.** A bank that closes an account stops sending updates. A pending row there (the bank's own, or an entry of
yours such as the other side of a transfer, D-83) then never posts, and the bank's last balance never changes. D-73 needed a bank balance of $0 and
nothing pending, so the account could never be closed: with the row, Close refused it; without it, the balance was
not $0.

**Decision.**

1. **Close also works when the working balance is $0 and pending rows remain**, the bank's or yours. The bank
   balance need not be $0 then. An upcoming entry still blocks Close (`closeBlocked` and the close route in
   `apps/worker/src/routes/account-close.ts`). The server checks the rows; the working balance is the phone's, with
   its change number, as before (D-45).
2. **The pending rows stay, as final rows.** They count exactly as they did (the account's balance, a paired
   transfer, a category), and they stop waiting for the bank: not under Not posted yet on Activity, never "Not at
   the bank yet". The closed account's register lists them on their day, in the running balance.
3. **The closed account is $0 everywhere.** Accounts shows $0 for it, not the bank's last balance. Net worth leaves
   closed accounts out, as before; the month's change on Accounts and the net worth chart on Reports count a final
   row in the month of its date, as they count a posted row (`FINAL_ROWS_BY_MONTH`).
4. **Opens again** on an entry you add or by Reopen account (D-73), and on any word from the bank about the account:
   a new row (D-73), and now also a change to a row or its removal (the sync's apply step). It also opens when you
   delete a final entry, change its amount or estimate, mark a final row won't clear, or unpair the transfer that
   made an entry: the account would no longer be $0. Open again, the rows are pending rows as before, and a posted
   row can still take one over.

**Money effect.** None at the close: it needs a working balance of $0, and every row keeps counting as it did. What
changes is that this state is now allowed to be the end: a row the bank never made final stays counted for good. If
the money never moved, the right answer is Won't clear, not Close.

**Since Nov 13, 2026.** Final rows show in the closed account's register, on the other side's Transfer sheet, and
on Activity with the posted rows, by their date (`apps/worker/src/routes/activity-view.ts`).
