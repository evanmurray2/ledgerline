# D-93: Close an account that still has your own pending entries (Nov 12, 2026)

**Decided by the owner** (chat, Nov 12, 2026): "I want to close out the account. To do that I need zero balance.
Which means the bank must post this row. But I don't think it's going to." Asked to approve the rule below:
"Approve". Changes D-73 item 1.

**Context.** A bank that closes an account stops sending updates. A pending entry of yours there (the other side of
a transfer, D-83) then never posts, and the bank's last balance never changes. D-73 needed a bank balance of $0 and
nothing pending, so the account could never be closed: with the entry, Close refused the pending row; without it,
the balance was not $0.

**Decision.**

1. **Close also works when the working balance is $0 and every pending row is your own entry.** The bank balance
   need not be $0 then. A pending row from the bank that no entry of yours covers still blocks Close, and so does an
   upcoming entry (`closeBlocked` and the close route in `apps/worker/src/routes/account-close.ts`). The server
   checks the rows; the working balance is the phone's, with its change number, as before (D-45).
2. **The entries stay, as final rows.** They count exactly as they did (the account's balance, a paired transfer,
   a category), and they stop waiting for the bank: not under Not posted yet on Activity, never "Not at the bank
   yet". The closed account's register lists them on their day, in the running balance.
3. **The closed account is $0 everywhere.** Accounts shows $0 for it, not the bank's last balance. Net worth leaves
   closed accounts out, as before; the month's change on Accounts and the net worth chart on Reports count a final
   entry in the month of its date, as they count a posted row (`FINAL_ENTRIES_BY_MONTH`).
4. **Opens again** on a new bank row or an entry you add (D-73), by Reopen account, and now also when you delete a
   final entry, change its amount, mark it won't clear, or unpair the transfer that made it: the account would no
   longer be $0. Open again, the entries are pending entries as before, and a bank row can still take one over
   (`docs/payee-names.md` 9.2).

**Money effect.** None at the close: it needs a working balance of $0, and every row keeps counting as it did. What
changes is that this state is now allowed to be the end: an entry the bank never confirmed stays counted for good.

**Not done.** Final entries show in the closed account's register and on the other side's Transfer sheet, not in
Activity's list of posted rows (`docs/build-plan.md`).
