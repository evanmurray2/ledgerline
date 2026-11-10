# D-87: A removed bank's accounts and rows stay in the budget (Nov 10, 2026)

**Decided by the owner** (chat, Nov 10, 2026): "I agree with B", in answer to the question in `docs/privacy.md` 14.4.
Nothing is built yet: removing a bank at Plaid doesn't exist today (there is no `/item/remove` call, and nothing sets
`connection.removed_at`). This takes effect when Settings → Banks → Remove is built (`docs/privacy.md` 5.5).

**Decision.**

1. Removing a bank ends the link at Plaid and stops fetching. No new rows come for its accounts.
2. The bank's accounts and every past row stay in the budget exactly as they are. Nothing is deleted, and no past
   month changes.
3. The accounts are marked "not linked". They keep counting in the budget and in net worth at their last balance.
4. An account is hidden only by Close account, which runs only at $0, as today (D-73).

**Money effect.** None on what is already counted. After a removal the account's balance no longer follows the
bank, so it counts at its last balance until the owner closes it. A bank difference line (D-66, D-68) has nothing to
compare with for an account that isn't linked, so it doesn't show there.

**Not decided here.** Adding entries by hand to an account that isn't linked, and starting an account with no bank
link at all, are the open item "Accounts without a bank link" (`docs/build-plan.md`), which needs the owner's answers
on starting balances.
