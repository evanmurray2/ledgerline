# D-68: Pending the bank already counts is counted once; the bank difference waits a day (Nov 6, 2026)

**Decided by the owner** (chat, Nov 6, 2026). Changes D-66 (the bank difference line) and the working balance on
Accounts.

**Context.** Wells Fargo's balance came through Plaid before the row for the charge did. Accounts showed "$X off from
bank", so the owner added the charge with Add pending. The working balance (bank balance plus pending) then took the
charge out twice: once in the bank's figure and once as the entry. The difference line stayed, since it compared
only posted rows.

**Decision.**

1. **Counted once** (`apps/worker/src/ledger/bank-diff.ts`, `bankDiff`). When the bank balance is lower than the
   starting balance plus posted rows, and pending (bank pending rows, your entries, due upcoming rows; won't-clear
   left out) is negative, the bank has taken in up to that much of the pending already: that part is `pendingInBank`,
   and the working balance leaves it out. The same the other way for deposits. With several pending rows, the app
   can't tell which one the bank counted, only how much.
2. **The difference** is what pending can't explain. It shows (D-66's line) only once it has lasted a day
   (`DIFF_WAIT_MS`). Each sync's finalize step (`markDrift` in `sync/process.ts`) sets
   `provider_account.drift_since` the first time it sees a difference and clears it when there is none (migration
   0009). The server has no stored month totals, so it adds up the posted rows directly.
3. Accounts and the account page say "pending already in bank" when `pendingInBank` isn't zero.

**Money effect.** The working balance on Accounts (and the Cash and Credit cards totals there) no longer counts a
pending row twice when the bank balance already holds it. Budget lines, categories and Ready to Assign don't change.
Card payment categories still use the bank balance plus pending (`cards()` in `views/common.ts`): a later change can
apply the same rule there.

**Risk.** A missing posted row and an unrelated pending charge of the same sign look the same as a pending charge the
bank took in: the working balance then shows the bank figure, and the line doesn't show. The bank's balance is still
right, and the line shows again once the pending row posts or goes.
