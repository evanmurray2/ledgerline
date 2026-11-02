# Multi-user design

Status: draft, Nov 2, 2026. Asked for by the owner: "I want the code ready if I do ever decide to share. Everything built, but signing up not turned on."

## 1. Goal

Build everything other people need to use Ledgerline, each with their own budget, and ship it **switched off**. With sign-up off, the app behaves exactly as it does today for the owner: same screens, same limits, no new public endpoints that do anything.

Turning it on later should be a setting change plus the owner decisions in section 9 (money, legal, Plaid), not new code.

Non-goals for this build: paying plans, email, a custom domain, native apps, off-site backups (D-29 stands until the owner decides otherwise).

## 2. What does not change

- **Money rules.** `packages/domain` and `computeBudget()` are per budget already. Nothing here changes how money is counted, so nothing here needs the owner's sign-off under the Money rules.
- The budget-scoped data layer (`apps/worker/src/db/scoped.ts`): every budget-owned table already carries `budget_id`, and every request already resolves to one budget.
- Sync guarantees in `docs/sync-spec.md` (leases, fences, watermark). They are per connection and per budget.

## 3. Where the code assumes one owner today

| #   | Place                                                                                           | Assumption                                                                                                                      | Effect with two users                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `http/auth.ts` `identify()`, `ownerEmail()`                                                     | Any valid session is "the owner"; identity is `OWNER_EMAIL`                                                                     | Every user would be signed in as the owner                                                                                                |
| A2  | `db/scoped.ts` `resolveMembership()`                                                            | Looks up by email, bootstraps the first user                                                                                    | Same as A1                                                                                                                                |
| A3  | `passkey`, `auth_session`, `device_link` (migration 0003)                                       | No `user_id` column                                                                                                             | Can't tell whose passkey or session it is                                                                                                 |
| A4  | `routes/auth.ts:117`                                                                            | First passkey needs `SETUP_CODE` while no passkey exists; no other way to create an account                                     | No sign-up path                                                                                                                           |
| A5  | `routes/security.ts`                                                                            | Lists every passkey, "sign out everywhere" deletes every session, deletes any passkey by id, device links aren't tied to a user | One user could see, sign out or lock out another                                                                                          |
| A6  | `sync/provider.ts` `connectionToken()`, used by Link repair (`routes/settings.ts:714`)          | Loads a connection by id without checking the budget                                                                            | A user could open Plaid Link update mode on another user's bank by sending its id                                                         |
| A7  | `routes/settings.ts:722` `ITEM_LIMIT`                                                           | Counts links per budget, and only links that still exist                                                                        | Plaid's Trial limit is 10 links **for the whole Plaid account, for life**; two users could each "have 10"                                 |
| A8  | `apply_counter` (single row, `id = 1`), read by `http/etag.ts:57` and `ledger/totals.ts:70,117` | One global counter of applied bank rows                                                                                         | Every user's sync changes every other user's ETag and invalidates their month totals (wasted reads, and it leaks when someone else syncs) |
| A9  | `cron.ts`                                                                                       | Loops over every budget (daily scan runs inline) and every due connection in one invocation                                     | Runs out of the 10 ms CPU / 50 queries per invocation after a handful of users                                                            |
| A10 | `routes/api.ts:51` ops token                                                                    | Health picks the first budget                                                                                                   | Health only reports on the owner                                                                                                          |
| A11 | `sync/breaker.ts`, `usage_day`                                                                  | One account-wide write budget, first come first served                                                                          | One user's first sync can use the whole day's writes and put everyone in read-only                                                        |
| A12 | `usage_event`, `usage_daily`, `usage_note`                                                      | Screen and tap telemetry is always on                                                                                           | Collects other people's behaviour without asking                                                                                          |
| A13 | Web `screens/Auth.tsx`                                                                          | Welcome screen offers only "sign in" or "set up with code"                                                                      | No sign-up or recovery screens                                                                                                            |

## 4. Accounts and sign-in

### 4.1 Schema (migration `0010_multi_user.sql`, additive)

- `user`: add `display_name TEXT`, `is_admin INTEGER NOT NULL DEFAULT 0`, `status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleting'))`, `last_seen_at INTEGER`, `link_allowance INTEGER NOT NULL DEFAULT 0`, `telemetry INTEGER NOT NULL DEFAULT 0`. `email` stays `NOT NULL UNIQUE` (the column can't be relaxed in a forward-only migration without a table rebuild); new users get a synthetic unique value `u:<user id>` and email is never used as identity again.
- `passkey`, `auth_session`, `device_link`: add `user_id TEXT REFERENCES user(id)`. Index `passkey(user_id)`, `auth_session(user_id)`.
- Backfill in the same migration: the existing user row gets `is_admin = 1`, `telemetry = 1`, `link_allowance = 10`, and every existing passkey, session and device link gets that user's id. If the `user` table is empty (fresh install), the backfill does nothing and the setup-code path (4.3) creates the first user as admin.
- New tables:
  - `invite (token_hash TEXT PRIMARY KEY, created_by TEXT NOT NULL, kind TEXT CHECK (kind IN ('account','member')), budget_id TEXT, link_allowance INTEGER NOT NULL DEFAULT 0, created_at, expires_at, used_at, used_by)`. Single use, 7 days, only the hash is stored.
  - `recovery_code (user_id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, created_at INTEGER NOT NULL)`. One per user.
  - `app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT)`. Holds `signup_mode`.
  - `plaid_link_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, budget_id TEXT NOT NULL, connection_id TEXT, created_at INTEGER NOT NULL)`. One row per Plaid Item ever created. Never deleted, not even on account deletion (it only holds ids).
  - `budget_usage_day (budget_id, day, est_written, est_read, steps, PRIMARY KEY (budget_id, day))`. Per-budget share of the account-wide limits.
- `budget`: add `applied_seq INTEGER NOT NULL DEFAULT 0` (A8, see 6.3).

### 4.2 Identity

- `identify()` returns `{ kind: 'user', userId, sessionId, verifiedAt }`, read from `auth_session.user_id` and joined to `user.status = 'active'`. `ownerEmail()` and `OWNER_EMAIL` go away; local dev keeps `DEV_AUTH_EMAIL`, mapped to a dev user.
- `resolveMembership(db, userId, requestedBudgetId?)` checks `budget_member` by user id. With no budget requested it returns the user's first budget (by `created_at`), which for everyone in this build is their only one. The bootstrap branch moves to the setup and sign-up flows.
- A disabled user's sessions stop working on the next request; disabling also deletes their sessions.

### 4.3 How accounts are created

1. **Setup code** (unchanged for a fresh install): works only while the `user` table is empty. It creates the first user (admin), their budget, membership and passkey in one batch.
2. **Account invite** (new): an admin makes a link in Settings → People. Opening it shows "Create your account": the visitor picks a name for their passkey, the browser makes it, and one D1 batch creates the user, budget, owner membership, passkey, session and recovery code, and marks the invite used. The batch is fenced on `invite.used_at IS NULL AND expires_at > now`, on the sign-up gate (4.4), and on the user count being under `MAX_USERS`, so a reused link or a race can't create two accounts.
3. **Open sign-up** (built, off unless `signup_mode = 'open'`): same flow without an invite.

After the account exists, the new user lands in the existing first-run setup (start month, accounts, categories). New users start with `link_allowance` from their invite (default 0), so they can use manual accounts and CSV import but can't spend a Plaid link unless the admin gave them one.

### 4.4 The sign-up gate (how "off" works)

Two keys, both needed:

- **Worker variable `SIGNUPS`** (in `wrangler.jsonc`, default `"off"`; values `off`, `invite`, `open`). This is the ceiling and needs a deploy to raise. With `off`, the sign-up routes return 404 and the web app never shows sign-up, so the switched-off build exposes nothing new.
- **`app_config.signup_mode`** (default `off`), set by an admin in Settings → People. The effective mode is the lower of the two (`off` < `invite` < `open`). This lets the owner pause sign-ups from their phone without a deploy.

`MAX_USERS` (Worker variable, default `1`) caps active plus deleting users. Raising it is part of turning on.

### 4.5 Recovery without email

The app sends no email (D-24), so a lost passkey can't be recovered through an inbox.

- At account creation the user is shown a **recovery code** once (24 random characters in groups of four, so it can be saved in the iPhone Passwords app). Only its hash is stored.
- "Lost your passkey?" on the welcome screen takes the code and lets the user register a new passkey. Using the code deletes it, signs out every session, and shows a new code.
- Recovery attempts are rate-limited (4.6). An admin can also make a single-use device link for a user from People, after checking who they are outside the app.
- The owner gets a recovery code the first time they open Settings → Security after this ships.

### 4.6 Public endpoints and abuse

Today the unauthenticated `POST /api/auth/login/start` writes an `auth_challenge` row. With more users and public sign-up, anyone could spend the account's 100,000 daily writes by calling it in a loop, which would take the app offline for everyone.

- **Stateless challenges**: the challenge and its purpose and grant are put in an HMAC-signed, 5-minute cookie (key derived from `TOKEN_KEYS`) instead of a D1 row. Starting a ceremony writes nothing. Finishing one writes only after the passkey checks out. Replay is stopped by the passkey signature counter for sign-in, and by the invite's or code's single-use fence for sign-up and recovery.
- **Rate limits** on finish, sign-up and recovery: the Workers rate-limiting binding if it's available on the free plan (check before building), otherwise a fixed-window counter keyed by IP hash in D1 that only writes when a ceremony fails.
- Sign-up and recovery count against a small daily ceiling (`SIGNUP_DAILY_MAX`, default 5) on top of `MAX_USERS`.

## 5. Roles and the admin screen

- `user.is_admin` marks who runs the instance (the owner). This is separate from `budget_member.role`, which says who owns a budget.
- **Settings → People** (admins only): sign-up mode, invite links (create, copy, revoke; set the Plaid link allowance for each invite), list of users (name, joined, last seen, banks linked, today's writes and steps), disable or enable, raise or lower a user's link allowance, delete a user (section 8), and the account-wide counters: Plaid links used of the cap, users of `MAX_USERS`, today's writes, reads and Workflow steps.
- An admin can't see another user's budget, transactions or accounts. People shows only counts and dates.

## 6. Keeping users apart

### 6.1 Fixes

- A5: every query in `routes/security.ts` and `routes/auth.ts` filters by `user_id`: passkey list and delete (and "keep at least one" counts that user's passkeys only), sign out everywhere (that user's sessions), device links.
- A6: `connectionToken(env, budgetId, connectionId)` binds the budget id, and so does every other lookup by connection id in `sync/` and `routes/`. The workflow paths already know their budget.
- A10: the ops token's health check reports account-wide numbers (usage, worst connection lag across all budgets, stale connection count) and never returns a budget's data.
- A12: telemetry is recorded only when `user.telemetry = 1`. It's on for the owner and off for everyone else, with a toggle in Settings for each user.
- Exports, CSV import and rules export are already budget-scoped; the isolation test (6.2) proves it.

### 6.2 Proving it: the two-tenant test

An integration test (`apps/worker/test/isolation.test.ts`) seeds two complete budgets, A and B, through the real sign-up path, with banks, transactions, splits, rules, targets, passkeys and sessions. It then:

1. Enumerates every route registered on the Hono app (so a new route is covered automatically, and an unlisted one fails the test).
2. Calls each one as user A, substituting B's ids (connection, account, category, transaction key, passkey, rule, invite) wherever the route takes one.
3. Checks that no response contains any of B's ids or names, and that a hash of every B row is identical before and after.

Add a lint rule (or a test that greps the source): `env.DB.prepare` / `c.env.DB.prepare` is allowed only in a short list of files (auth, breaker, cron, workflows, `db/scoped.ts`). Everything else goes through `Scoped`.

### 6.3 Per-budget applied counter (A8)

`bank_event.id` stays globally unique and is still assigned from `apply_counter` (ids must be unique across budgets, and the apply batch reads the counter in the same transaction). The same apply batch also runs `UPDATE budget SET applied_seq = applied_seq + n WHERE id = ?`. ETags and the month-totals stamp use `budget.applied_seq` instead of `apply_counter.seq`. Processing still uses `bank_event.id > processed_through` filtered by budget, which is already correct with gaps.

## 7. Sharing the free plan fairly

Cloudflare's free limits and Plaid's Trial cap belong to the whole account. Each one needs a per-user share so one user can't use it up for everyone.

### 7.1 Plaid links (A7)

- `PLAID_LINK_CAP` (Worker variable, `10` in Trial) is checked against `count(*) FROM plaid_link_log`, across all users and including removed links. The current 7 are written into the log by the migration from existing `connection` rows.
- A user may start a new link only if their own count in the log is under their `link_allowance` **and** the global count is under the cap. Both checks run again in the batch that records the new connection, so two users can't take the last slot together.
- The existing "Confirm using one of your remaining bank links" prompt shows the user's own remaining number.
- Repair (update mode) never uses a slot, as today.

### 7.2 D1 writes and reads (A11)

- `noteUsage()` also adds to `budget_usage_day` for the budget doing the work.
- **New-bank backfills are admitted, not just started.** A first sync of a new connection is estimated at 5 rows written per transaction expected (Plaid returns up to 180 days; assume 3,000 if unknown, about 15,000 writes). It starts only if today's account writes plus the estimate stay under the 70% pause line. Otherwise it waits in `sync_run` with status `queued` and the backstop cron starts it after 00:00 UTC. At most `BACKFILLS_PER_DAY` (default 2) start per UTC day.
- **Per-user daily write share** for interactive writes: `USER_WRITE_SHARE` (default 20,000 rows). Past it, that user's writes get 503 "Daily limit reached for your budget" while other users carry on. The admin is exempt. Background sync for a user over their share pauses until midnight, like the breaker does today.
- The account-wide breaker (70% pause, 90% read-only) stays as the last line.

### 7.3 Workflow steps and cron (A9)

- **Cron fan-out**: the daily scan moves out of the cron invocation and becomes the first step of each budget's maintenance Workflow. The maintenance cron only creates instances, at most `MAINT_PER_RUN` (default 25) per run, ordered by budget id from a cursor in `app_config`. It runs again from the backstop cron until every budget has its instance for the day.
- **Backstop**: starts at most 20 syncs per run, oldest `last_synced_at` first. Webhooks stay the main trigger.
- **Dormant budgets**: a budget with no sign-in for 14 days gets the full recompute and drift check weekly instead of daily, and its banks sync once a day (from the backstop) instead of on every webhook. Webhooks for it mark `resync_requested`.
- Steps are counted in `budget_usage_day.steps` and `usage_day` so People can show them. If Cloudflare's per-account step limit is real (sync spec lists 3,000 a day, "verify"), the breaker pauses new Workflow instances at 70% of it.

### 7.4 Storage

`raw_page` is the largest table. Maintenance already prunes it; the prune runs per budget. People shows the database size (from D1's metadata) against 500 MB, and sign-up refuses new accounts above 70%.

### 7.5 Rough capacity on the free plan

Estimates from `docs/measurements.md`; to be measured with a seeded 10-user test before anyone else is invited.

| Limit                           | Per active user, per day                           | Users it allows                                |
| ------------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| Plaid Trial links               | 1 to 7                                             | 3 links left in total: 1 to 3 more people      |
| D1 writes (100k)                | a few thousand; ~15,000 on the day a bank is added | about 10 to 15 steady users, 2 new banks a day |
| D1 reads (5M)                   | ~150,000 normal, up to 1M on a heavy day           | about 20 to 30                                 |
| Workflow steps (3,000, if real) | ~10 maintenance + ~12 per sync × syncs             | about 10                                       |
| Storage (500 MB)                | a few MB per year of history                       | not the first limit                            |

On the free plan and Plaid Trial, "many users" means a handful. Section 9 lists what raises it.

## 8. Deleting an account

- The user (Settings → Security → Delete account, with a fresh passkey check and typing the budget name) or an admin starts it. `user.status = 'deleting'`, sessions are deleted at once, and a `DeleteAccountWorkflow` runs.
- Steps: remove each Plaid Item (`/item/remove`; this does **not** give the Trial link back, and the confirm screen says so), then delete the budget's rows table by table in chunks of 500, each step checking the write breaker and pausing until midnight if needed, then delete membership, passkeys, recovery code and the user row. `plaid_link_log` rows stay.
- The owner's account (the last admin) can't be deleted from the app.
- Before deleting, the screen offers the existing JSON export.

## 9. Turning it on (owner decisions, not built here)

Each of these changes a hard rule or a decision, so none happens without the owner:

1. **Plaid**: Trial has 3 links left in total. Real use needs Plaid Production (application, security questionnaire, per-Item monthly fees). Breaks "Plaid Trial" and "$0".
2. **Cloudflare Workers Paid** ($5 a month) raises every limit in 7.5 a lot. Breaks "$0".
3. **Backups**: D-29 (no off-site backup) is fine for the owner's own data; holding other people's needs a decision.
4. **Privacy policy and terms**, and what happens to people's data if the app shuts down.
5. **Monitoring**: someone needs to know when it breaks for other people.
6. Raise `SIGNUPS` (deploy) and `MAX_USERS`, then set the mode in People.

## 10. Build phases

Each phase lands on `master` with `pnpm check` passing and changes nothing for the owner while `SIGNUPS` is `off`.

1. **Schema and identity**: migration 0010 with backfill; `identify()` and `resolveMembership()` by user id; security routes scoped by user (A1–A3, A5). _Verify:_ migration test on a copy of the current schema with the owner's rows; existing e2e sign-in tests pass unchanged.
2. **Isolation**: fix A6, A8, A10; the two-tenant test (6.2) and the `DB.prepare` allowlist. _Verify:_ isolation test passes and fails when a scope is removed on purpose.
3. **Stateless challenges and rate limits** (4.6). _Verify:_ starting a sign-in writes 0 rows; replayed challenge fails.
4. **Sign-up gate, invites, recovery codes** (4.3–4.5) and the web screens. _Verify:_ with `SIGNUPS=off` the routes 404; e2e for invite sign-up, reused invite, recovery.
5. **Fair share**: Plaid link log and allowance, backfill admission, per-user write share, cron fan-out, dormant budgets (7.1–7.4). _Verify:_ integration tests for the last-slot race and for a backfill queued past the pause line; a cron run with 60 budgets stays under 10 ms CPU and 50 queries.
6. **People screen, telemetry opt-in, account deletion** (5, 6.1, 8). _Verify:_ e2e for each; deletion leaves no rows with that `budget_id`.
7. **Capacity measurement**: seed 10 users with the November fixture, run a simulated day, write the numbers into `docs/measurements.md` and update 7.5.
8. Docs: D-37 in `decisions.md` (sign-in by user id; email no longer identity; recovery codes), update `design.md` Users row and `threat-model.md`, tick `build-plan.md`.

Sharing one budget between two people (`budget_member` role `member`) is not in this build: the design lists the shared-budget UI as a non-goal. The schema and invite kind `member` leave room for it.

## 11. Open questions

- Is the Workers rate-limiting binding available on the free plan? (Decides 4.6.)
- Is the 3,000 Workflow steps a day account limit real? (Decides how much of 7.3 matters.)
- Should a new user's link allowance default to 0 (admin grants) or 1? Draft says 0, because Trial links are gone for good once used.
