# Open sign-up: built, switched off

Status: v3, Nov 9, 2026: one adversarial review (section 15), then the owner's answers (section 15). Decision D-75 (`docs/decisions/D-75-open-signup.md`). It replaces the invite design in `docs/multi-user.md` 7.3 and 7.4. The rest of `docs/multi-user.md` stands.

## 0. What the owner asked

- Drop the invite-only design. Anyone may make an account once sign-up is on.
- Build what thousands of users need, but **keep sign-up off**.
- **Change no other decision.** The $0 free plan (D-26, D-27), no off-site backups (D-29), no staging (D-36), no monitor (D-49), the 10 ms CPU rule and the D-40 breaker stay. Where scale needs one of them changed, this doc lists it for the day sign-up is turned on (section 13).

Non-goals: turning sign-up on, paid plans, Plaid Production, email, billing, sharing one budget, backups, monitoring, a session cache.

## 1. Rules that hold everywhere

1. **While the switch is off, the owner sees no change.** Section 14 lists every change that reaches the owner anyway, and why it is safe.
2. **A user's data is reachable only through that user's session** (`docs/multi-user.md` 11). A test proves it for every route and every store method (section 11).
3. **Only admins link banks** while Plaid's 10 Trial links for life apply (section 5). Other users never see a link count or an allowance.
4. **Other users together can't use up the free plan.** They share a pool that leaves the owner room (section 8).
5. **No change to how money is counted.** Nothing here touches `packages/domain`.
6. **No data is lost by accident.** Only a user's own explicit delete removes data (section 12).

## 2. The switch

Worker variables in `apps/worker/wrangler.jsonc` (`vars`). Changing one is a merge to `main` (D-49), so turning sign-up on is a reviewed PR.

| Variable             | Default | Meaning                                                                                                   |
| -------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `SIGNUPS`            | `off`   | `open` lets anyone make an account. Any other value is `off`.                                             |
| `MAX_USERS`          | `1`     | Accounts allowed, counting active, turned-off and deleting users.                                         |
| `SIGNUPS_PER_DAY`    | `50`    | New accounts per UTC day, account-wide.                                                                   |
| `OTHER_USERS_BANKS`  | `off`   | `on` lets users who aren't admins link banks. Only for a Plaid plan with no lifetime link limit (5).      |
| `OTHER_USERS_SHARE`  | `0.5`   | The part of each daily limit that users who aren't admins may use together (8). `off` turns fair use off. |
| `TURNSTILE_SITE_KEY` | none    | Cloudflare Turnstile site key (public).                                                                   |

New secret, used only once sign-up is on: `TURNSTILE_SECRET`. It is added to `tools/ci/worker-secrets.mjs` and the `deploy.yml` env now, so adding it to the GitHub `production` environment later is enough. Until then it is absent, and sign-up stays closed.

Sign-up is open only when **all** of these hold: `SIGNUPS` is `open`, both Turnstile values are set, `devSignIn()` is false, an admin exists, and the breaker state (D-40) is `normal`. The **Worker** checks the variables before it calls the Directory, so a closed or bad request costs no Durable Object request. Closed → 404, the same as an unknown route. `GET /api/auth/status` gains `signupOpen`, which is `false` while closed.

## 3. Making an account

### 3.1 Screens

- Sign-in screen: **Create account** under **Sign in**, only when `signupOpen` is true.
- Create account: **Name** (1–60 characters, shown on the passkey and to admins), the Turnstile check, then **Create passkey**. The screen says, before the passkey: "Your passkey is how you sign in. If you lose every passkey and your recovery code, you can't get back into your budget. No one can recover it for you."
- Then the recovery code screen (4), which says the same again. The user ticks "I saved my recovery code. I understand that without it and my passkeys, my budget is lost." to go on.
- Then the existing first-run Setup (`apps/web/src/screens/Setup.tsx`) on an empty budget.
- UI text goes into `docs/copy.md` first.

### 3.2 Server

`POST /api/auth/signup/options` with `{ name, turnstileToken }`, in the Worker:

1. The switch check (2). Closed → 404.
2. The rate limit: `AUTH_LIMITER` (20 a minute per IP), under its own key `signup:<ip>`.
3. Turnstile: the Worker posts the token to Cloudflare's `siteverify` with the secret and the client IP. It checks `success`, `hostname` (the RP id) and `action` (`signup`). Cloudflare accepts a token once.
4. Then the Worker calls the Directory RPC `signupOptions(name)`. It reads (no write) users < `MAX_USERS`, sign-ups today < `SIGNUPS_PER_DAY` and the breaker state, so a full sign-up fails early with "Sign-up is full right now. Try again tomorrow." Step 6 is the real guard.
5. A new random WebAuthn handle (32 bytes) and the name go into the signed challenge cookie as the grant `{ kind: 'signup', ref: handle, name }`. The registration options use that handle, with `excludeCredentials` empty.

`POST /api/auth/register/verify` with a `signup` grant:

6. One Directory batch (one SQLite transaction), in order:
   - Record the challenge id in `used_challenge` (primary key). A second use of the same challenge throws, so the whole batch rolls back.
   - `INSERT INTO user … SELECT … WHERE (SELECT count(*) FROM user) < MAX_USERS AND (SELECT count(*) FROM user WHERE created_at >= today) < SIGNUPS_PER_DAY`. Columns: a new id, `email = 'u:' || id` (the column is `NOT NULL UNIQUE`; email isn't identity, `docs/multi-user.md` 7.1), `display_name`, `is_admin = 0`, `status = 'active'`, `webauthn_handle` from the grant. `link_allowance` keeps its default and is never read (5).
   - A fence: `INSERT INTO fence (ok) SELECT count(*) = 1 FROM user WHERE id = ?`. The `fence` table has `CHECK (ok = 1)`, so a full sign-up throws here and nothing is written. This is the `lease_guard` pattern; the Directory gets its own table.
   - `budget`, `budget_member`, `passkey`, `recovery_code` (4).
   - The session, with `challenge_id`.
7. A refused batch answers 403 "Sign-up is full right now. Try again tomorrow."
8. The Worker calls the new store's `health()`, which creates it and runs its migrations. The store makes its budget row only after the Directory confirms the budget exists (12.3). An interrupted sign-up leaves an empty budget that works.

A sign-up grant can't make an admin: `is_admin` is a constant 0 in the statement. The owner's setup with `SETUP_CODE` stays, with one fix (3.4).

### 3.3 Used challenges

Today a finished ceremony is single use because its challenge id sits on a session (`auth_session.challenge_id`). A fresh passkey check overwrites that column (`apps/worker/src/routes/auth.ts:391`), so an older challenge looks unused again for the rest of its five minutes. `used_challenge (id PRIMARY KEY, used_at)` replaces that test for every ceremony. `auth_prune` deletes rows older than a day. This also closes the gap for the owner's own ceremonies.

### 3.4 The owner's setup and recovery, with other users

`passkeyCount()` counts every user's passkeys (`apps/worker/src/routes/auth.ts:55`), and setup works only at 0. The runbook's recovery (`docs/runbooks/setup.md`, Recovery) runs `DELETE FROM passkey; DELETE FROM auth_session;`, which would sign everyone out and delete their passkeys.

- The setup grant checks "no admin has a passkey" instead of "no passkey exists". With one user this is the same test.
- If no user exists, setup makes the first user (as today). If an admin exists with no passkey, setup adds the passkey to that admin.
- The runbook's SQL is limited to the admin: `DELETE FROM passkey WHERE user_id = (SELECT id FROM user WHERE is_admin = 1 ORDER BY created_at LIMIT 1)`, and the same for `auth_session`.

### 3.5 Abuse

- Turnstile stops scripted sign-ups. The rate limit and `SIGNUPS_PER_DAY` cap what gets through.
- A new account can do little that costs: no bank links (5) and a share of a pool (8).
- An admin can turn an account off (10).

## 4. Recovery codes

Invites came with a reset link the owner sent by hand. That doesn't work for strangers, and email needs a domain. Synced passkeys (iCloud Keychain, Google Password Manager) make losing every passkey rare. A recovery code covers the rest.

- **The code:** 20 random bytes, 32 base32 characters in groups of 4. Only its SHA-256 is stored (`recovery_code.code_hash`, already in migration 0003). With 160 bits, a slow hash adds nothing.
- **Shown once**, at sign-up, with Copy, and the warning from 3.1. Settings → Sign-in → **New recovery code** (recent passkey check) replaces it and shows the new one once.
- **Use:** Sign-in → **Use a recovery code** → code and Turnstile → `POST /api/auth/recover/options` (Worker checks Turnstile, then the Directory). A match puts `{ kind: 'recovery', ref: code_hash }` in the challenge cookie. Nothing is written yet.
- `register/verify` with that grant runs one batch: `used_challenge`; the new passkey, `INSERT … SELECT user_id FROM recovery_code r JOIN user u … WHERE r.code_hash = ? AND u.status = 'active' AND u.is_admin = 0`; a fence that throws unless that insert made one row; delete that code row; a new code row; a `recovery_notice` row (`user_id`, `used_at`). Then a session and the new-code screen. A code rotated after the grant was issued no longer matches, so the grant fails.
- **Recovery adds a passkey. It removes nothing.** A leaked code must not silently lock the real user out. The old passkeys, sessions and devices stay.
- **The notice:** for 14 days after a recovery, every sign-in of that user shows "Your recovery code was used on {date}. If this wasn't you, remove the passkeys you don't know." with a link to Settings → Sign-in, where passkeys can already be removed (recent check). Removing a passkey there signs out its sessions. **This was me** dismisses the notice.
- **Not for admins.** The owner keeps D-27's device link and the runbook.
- A turned-off account can't recover.
- Wrong codes count against the same rate limit as sign-in.
- `docs/threat-model.md` gains rows for sign-up, recovery codes and other users.

## 5. Bank links: admins only

**Problem today:** `link-token` counts connections in the asking budget only (`ITEM_LIMIT = 10`, `apps/worker/src/routes/settings/connections.ts`). Plaid's 10 Trial links are for the whole Plaid account, so two users could pass it.

**What a link is:** one person's login at one bank (a Plaid Item). Two users at the same bank are two links: one user's link never reads another user's accounts.

**Rule (owner, Nov 9, 2026):** users who aren't admins can't link banks. They add accounts by hand and import CSV files. Allowances are not a concept users see.

- `link-token` in new mode refuses with 403 unless the caller is an admin or `OTHER_USERS_BANKS` is `on`. The Directory passes `isAdmin` to the store with the caller.
- For users who aren't admins, the app hides **Link a bank** and the link count. Bank connections isn't shown to them at all while they have no connections.
- Only the first user is an admin, and nothing can make another. So every link is in the owner's budget, and today's per-budget count (`ITEM_LIMIT`) is the account-wide count. Bank connections for the owner doesn't change. If a second admin is ever possible, an account-wide count comes first.
- `user.link_allowance` and `plaid_link_slot` (migration 0003) stay unused.
- **On Plaid Production** (the owner's later choice), a PR sets `OTHER_USERS_BANKS` to `on`. Production has no lifetime limit, so no count or allowance is needed. Repair, webhooks and deletion (12) already work for any user's banks.

## 6. Each user's own passkey handle

Already built: non-setup grants make and store a per-user handle (`apps/worker/src/routes/auth.ts:187`), and the owner's row holds `ledgerline-owner`. One gap: sign-in skips the `userHandle` check when the response has none (`apps/worker/src/routes/auth.ts:357`). Every Ledgerline passkey is discoverable, so the response always has one. The check becomes required.

## 7. The breaker's limits become settings

`sync/breaker.ts` has the free plan's daily limits as constants. Each becomes a Worker variable with today's value as its default: `LIMIT_ROWS_WRITTEN` (100,000), `LIMIT_ROWS_READ` (5,000,000), `LIMIT_DO_REQUESTS` (100,000), `LIMIT_DO_GBS` (13,000), `LIMIT_WORKER_REQUESTS` (100,000). A missing or invalid value uses the default. The 70%, 90% and 95% rules (D-40) don't change. On a paid plan, the PR that upgrades sets the plan's limits.

## 8. Sharing the free plan

The breaker is account-wide, so busy users could pause everyone, the owner included. These rules apply only while more than one user is active.

- **A pool.** Users who aren't admins may use together at most `OTHER_USERS_SHARE` (default half) of each daily limit. Admins aren't limited by the pool; the account-wide breaker still covers everyone.
- **A share each.** The pool is split evenly among users active in the last 7 days. One user's share = pool ÷ active users.
- **Past the share,** that user's budget gets the D-40 states on its own: background work waits until 00:00 UTC; past 1.5 × the share, changes are refused with "Paused until tomorrow. Nothing is lost." Past the pool, all non-admin budgets wait.
- **Counting** (as built): each store counts its own rows (the database's counters) and requests, and reports them to the Directory at most once a minute (`noteBudgetUsage`, into `budget_usage_day`). The analytics API's per-object split couldn't be confirmed, so it isn't used. A store counts only while the Directory says shares apply (more than one active user, and the user isn't an admin), so with one user nothing extra runs. The Directory's own requests are counted to the budget that made them, in `authenticate`.
- **Checked** in `authenticate`, which already reads the breaker state, from a per-budget cache refreshed at most once a minute.
- A new bank's first sync writes about 20,000 rows. It runs as background work, so past the share it waits a day at a time instead of failing. Users who aren't admins can't link banks until `OTHER_USERS_BANKS` is `on` (5).

**Built to be removed.** All of fair use lives in one file, `apps/worker/src/store/shares.ts`, with its own tests. It touches the rest of the code in two places: one check in `Directory.authenticate` and one call where usage is counted. Two ways out on a paid plan:

- **Turn it off:** `OTHER_USERS_SHARE` = `off`. No code change.
- **Delete it:** remove the file, its tests and the two calls. The `requests` column on `budget_usage_day` stays unused (migrations are forward-only). Per-budget counting can stay: it shows who uses what.

**Capacity on Free stays as `docs/multi-user.md` 9.3 says: about 10 to 15 active users,** set by rows written. Thousands need a paid plan (13).

## 9. Idle budgets

Each store runs three recurring alarms a day, and `ensure_all` calls every budget daily. Abandoned accounts would cost Durable Object requests forever.

- A store whose user hasn't signed in for 30 days and that has no connections stops its recurring jobs. `ensure_all` skips budgets whose user hasn't been seen for 30 days (from `user.last_seen_at`). The next request re-arms the jobs (`ensureRecurring` already runs on first use).
- `user.last_seen_at` is written at most once an hour per user, in `authenticate`.
- Nothing is deleted for being idle (rule 6). Whether to expire unused accounts is listed in 13.

## 10. Admin: Settings → Users

For admins, shown only while more than one user exists or `SIGNUPS` is `open`:

- Counts: users of `MAX_USERS`, sign-ups today of `SIGNUPS_PER_DAY`, the pool used today.
- A list, 50 a page, newest first, filter by status: name, joined, last seen, status.
- Per user: **Turn off** / **Turn on** (off deletes their sessions and pauses their bank syncs, `docs/multi-user.md` 7.1).
- A deletion stuck on Plaid (12) shows here with **Try again**.
- Admin actions need a recent passkey check and write one log line each (`admin_action`, Workers Logs). No search and no audit table.

**What an admin can do that other users can't:**

- Link and repair banks (5).
- Use the daily limits without a share (8).
- See Settings → Users and turn accounts off and on.
- Recover with a device link or the runbook (D-27, 3.4) instead of a recovery code.

**What an admin can't do:** open, read or change another user's budget; see their passkeys or recovery code; delete their account. Only the first user is an admin, and the last admin can't be deleted.

## 11. Keeping users apart

- An integration test signs up users A and B through the real sign-up route, gives both data, then calls **every route** as A with B's ids in the path, the query and the body. The list of routes is read from the Hono apps, so a new route can't be missed. Every answer must be 403, 404 or A's own data.
- The same test checks every `BudgetStore` and `Directory` RPC method the Worker can reach: the store is still picked only from the session.
- The webhook: an Item routed to B starts a sync only in B's store.
- `wipe` (12) refuses unless the Directory holds a `deleting` record for that budget.

## 12. Deleting an account

`docs/multi-user.md` 10, with a safer order. `wipe` doesn't exist yet and is built here.

1. Settings → Sign-in → **Delete account**: a recent passkey check and typing the budget name. The screen offers the full backup first and says the data will be gone.
2. One Directory batch: `status = 'deleting'`; delete the user's sessions, devices and device links; delete the budget's routes in `connection_route` and its membership. From here, no request or webhook reaches the store.
3. A `delete_account` Directory job, each step idempotent and retried:
   1. The store removes each Plaid Item at Plaid. "Item not found" counts as done. After 6 failed tries the job stops, keeps the store as it is (the access tokens stay, so it can try again), and shows the account in Settings → Users with **Try again**. Users who aren't admins have no banks until `OTHER_USERS_BANKS` is `on`.
   2. The store wipes itself: `ctx.storage.deleteAll()` and its alarm.
   3. The Directory deletes the user's passkeys, recovery code, notices, the budget row and then the user row, so the account no longer counts toward `MAX_USERS`.
4. **The store makes its budget row only when the Directory confirms the budget** (`budgetExists(budgetId)`, checked once, when its database is empty). A late call after a wipe can't bring the budget back to life.
5. The last admin can't be deleted.

After a wipe, point-in-time recovery can't bring the data back. That is the point.

## 13. Before turning sign-up on (not now)

Turning on is a PR that sets `SIGNUPS` to `open`. Before it, the owner decides each of these. **This work does none of them.**

- **Plaid:** Plaid Production and its costs, then `OTHER_USERS_BANKS` to `on`. Until then other users can't link banks.
- **Cloudflare plan:** Free (about 10–15 active users) or Paid; the `LIMIT_*` values; `MAX_USERS`, `SIGNUPS_PER_DAY`; keep fair use, turn it off (`OTHER_USERS_SHARE` = `off`) or delete it (8).
- **Turnstile:** make the widget in the Cloudflare dashboard (free, no card), add `TURNSTILE_SECRET` to the GitHub `production` environment, set `TURNSTILE_SITE_KEY`. The same PR adds `https://challenges.cloudflare.com` to `script-src` and `frame-src` in `apps/web/public/_headers` and updates `apps/web/test/headers.test.ts`. The live CSP doesn't change before then.
- **Decisions to look at again:** no off-site backups (D-29), no monitor (D-49), no staging (D-36), the 10 ms rule on a paid plan, a session cache and splitting sessions out of the Directory (`docs/multi-user.md` 5.1, 5.2), expiring unused accounts.
- **Not code:** terms of service, a privacy policy, a support contact, billing if users pay.

## 14. What reaches the owner while the switch is off

| Change                                                  | Why it's safe                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `used_challenge` replaces the session column test (3.3) | Same rule, stricter. Covered by the sign-in tests.                                                |
| Setup checks "no admin passkey" (3.4)                   | Same result with one user.                                                                        |
| `userHandle` required at sign-in (6)                    | The owner's passkeys are discoverable and send it. A test signs in with the owner's handle first. |
| `link-token` checks the caller is an admin (5)          | The owner is the admin. A test links (mock Plaid) as the owner.                                   |
| Breaker limits read from settings (7)                   | Defaults are today's numbers.                                                                     |
| Per-budget usage counting (8)                           | Only counting; the pool and shares apply with more than one active user.                          |
| `last_seen_at` once an hour (9)                         | One row written an hour while the app is used.                                                    |
| `signupOpen: false` in `/api/auth/status`               | The app ignores it while false.                                                                   |

## 15. Review

The v1 draft was reviewed adversarially on Nov 9, 2026. Fixes taken into v2:

- The daily `register_link` would have added a slot per bank per day and locked the owner out on day one: slots are now an upsert on `connection_id`.
- Links could be undercounted (a lost `exchange`, removed banks missing from routes, a migration backfill and a rollback): slots now come from the stores' own connection rows, expired reservations stay counted, and the untracked count has no default.
- Recovery grants could be replayed, and `changes = 1` can't stop a batch: the code hash is in the grant, a fence throws, and used challenges have their own table.
- A leaked recovery code would have been a silent takeover: recovery now adds a passkey, removes nothing, and shows a notice.
- The owner's runbook recovery would have deleted every user's passkeys: it is limited to the admin.
- Sign-up bypassed the breaker: it now needs the `normal` state.
- The claims about usage counting and capacity were wrong: corrected, and shares come from a pool.
- Idle and deleted budgets kept costing requests, and a late call could recreate a wiped store: idle stores stop their jobs, routes go before the wipe, and stores need the Directory's confirmation.
- Smaller: the switch and Turnstile run in the Worker; the secret plumbing is listed; the session cache is cut; the passkey handle was already built; `PLAID_LINK_CAP = 0` no longer means no cap; the user row is deleted at the end; the audit table and search are cut.

Owner's answers, Nov 9, 2026 (v3):

- No allowances users can see. Users who aren't admins can't link banks; on Plaid Production they can. This removed the link slots, `NEW_USER_LINKS`, `PLAID_LINK_CAP` and `PLAID_LINKS_UNTRACKED`, and with them the review's findings on undercounting.
- Fair use must be easy to remove (8).
- Users are told plainly that losing every passkey and the recovery code loses the budget (3.1).

## 16. Database changes

- **Directory migration 0008** (forward-only; the owner approves before merge; the number is checked against `main` first): `used_challenge`; `fence` (`ok INTEGER CHECK (ok = 1)`); `recovery_notice`; an index on `user (created_at)`; a `requests` column on `budget_usage_day`. No rows are copied or changed.
- **No budget migration.**

## 17. Build order

Each step is one PR, with `pnpm check` and every CI job green. Section 14 says what each one changes for the owner.

1. This doc, D-75 and the doc updates.
2. Directory migration 0008, used challenges (3.3), the setup and runbook fix (3.4), `userHandle` required (6), breaker limits as settings (7). Owner approval before merge (migration).
3. Bank links for admins only (5).
4. Usage per budget, the pool and shares (8), idle budgets (9).
5. Sign-up and recovery codes behind the switch (2, 3, 4), with e2e tests that open the switch in the test Worker only, Turnstile's test keys and a mocked `siteverify`.
6. The isolation test (11).
7. Account deletion (12) and Settings → Users (10).
