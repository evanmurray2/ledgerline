# D-78: No new multi-user work until Plaid Production (Nov 9, 2026)

**Decided by the owner** (chat, Nov 9, 2026): after an architecture review said the multi-user layer serves no one
yet, the owner agreed to freeze it ("Yes, and fix everything").

**Decision.**

1. **Nothing new is built for other users** until Plaid Production (no lifetime link limit) is an option. Today
   sign-up is off (`SIGNUPS`), and only admins link banks, with 3 of Plaid Trial's 10 links left.
2. **What is built stays and keeps working**: open sign-up, recovery codes, fair-use shares, idle budgets, Settings →
   Users and Delete account (D-75, `docs/open-signup.md`). Its tests stay green, and changes elsewhere keep it working
   (for example, `Directory.authenticate` keeps its fair-use check).
3. **Waiting on this decision** (`docs/build-plan.md`): accounts without a bank link, and removing a deleted
   account's banks at Plaid.
4. Not built for this reason: a short signed read pass that skips the Directory on each read. It mainly helps many
   users share the Directory, and it would let a signed-out device read for a short while.

**Money effect.** None.
