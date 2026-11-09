# D-74: Open sign-up replaces invites, built and switched off (Nov 9, 2026)

**Decided by the owner** (chat, Nov 9, 2026): "I don't want an invite only design, get rid of that. I want to be ready to turn it on for thousands of users, when I do decide to upgrade the Cloudflare and Plaid plans", and "I don't want to change any of my existing decisions yet (except invite only sign up)."

**Context.** `docs/multi-user.md` 7.3 and 7.4 planned invite links made by an admin, a People screen with a reset link, and no open sign-up (owner, Nov 2, 2026). None of it was built.

**Decision.**

1. **Open sign-up, not invites.** Anyone may make an account with a passkey once the `SIGNUPS` switch is `open`. Invites and the reset link are dropped. The `invite` table stays unused (migrations are forward-only).
2. **Built, switched off.** `SIGNUPS` stays `off` and `MAX_USERS` stays `1`. Turning sign-up on is its own PR, after the owner's choices in `docs/open-signup.md` section 12.
3. **Recovery codes** replace the reset link for users other than admins.
4. **Bank links are counted account-wide** in the Directory, because Plaid's limit is per Plaid account, not per budget.
5. **Per-user shares of the free plan** are built and apply only while more than one user is active.
6. **No other decision changes.** The $0 free plan (D-26, D-27), no off-site backups (D-29), no staging (D-36), no monitor (D-49), the 10 ms rule and the breaker (D-40) stay. The breaker's limits become settings with today's values as defaults.

**Design.** `docs/open-signup.md`.
