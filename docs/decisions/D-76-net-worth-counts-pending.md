# D-76: Net worth counts pending, like the account totals (Nov 9, 2026)

**Decided by the owner** (chat, Nov 9, 2026): asked whether net worth and the Cash and Credit cards totals should use
one basis, with or without pending, they answered "Yes with pending".

**Context.** `docs/design.md` (Net worth) sums the linked accounts' balances. Accounts and Reports showed that net
worth next to Cash and Credit cards totals that count pending (working balances), so the three numbers did not add
up: in the November copy, $23,492.40 − $1,138.05 is $22,354.35, but net worth read $22,555.35. Found in the design
critique of Nov 9, 2026.

**Decision.**

1. **Net worth = Cash working total − Credit cards working total** (`routes/accounts.ts`), the same numbers as the
   two group totals. Money owed to you is still left out.
2. **"+$X in November"** is what posted this month plus the pending gap (net worth − the bank's balances), so it
   equals the step on the Reports chart from last month's end to now.
3. **Reports' net worth chart:** this month's point is the same net worth as Accounts. A finished month's point is
   still the bank's balances today minus everything posted after that month: its pending has posted since.

**Money rules.** Display only: no category, Ready to Assign or budget line changes. The budget identity in
`docs/design.md` already uses working balances.

**Checked by** `apps/worker/test/api.november.test.ts` (net worth equals the group totals; the chart's last point and
step equal Accounts).
