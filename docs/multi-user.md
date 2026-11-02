# Multi-user design

Status: revised after an adversarial review, Nov 2, 2026 (section 12). Asked for by the owner: "I want the code ready if I do ever decide to share. Everything built, but signing up not turned on."

## 1. Goal

Build everything other people need to use Ledgerline, each with their own budget, and ship it **switched off**.

"Off" has a precise meaning here: **while the instance has one active user, the owner's app behaves exactly as today.** Same screens, same sync timing, same limits, same sign-in. Any new public route returns 404. Every fair-share or scheduling change in section 7 is active only in **multi-user mode** (more than one active user), which can't happen while sign-up is off.

Turning it on later should be a deploy-variable change plus the owner decisions in section 9 (money, legal, Plaid), not new code.

Non-goals: paying plans, email, a custom domain, native apps, off-site backups (D-29 stands until the owner decides otherwise), and sharing one budget between two people (the design lists the shared-budget UI as a non-goal).

## 2. What does not change

- **Money rules.** `packages/domain` and `computeBudget()` are per budget. Nothing here changes how money is counted.
- Sync guarantees in `docs/sync-spec.md` (leases, fences, watermark, the write breaker). Sections 7 and 8 add limits and one narrow exception to append-only tables (8.2). They don't loosen any fence.

## 3. Where the code assumes one owner today

Verified against the code on Nov 2, 2026.

| #   | Place                                                                                                                    | Assumption                                                                                                                                                                     | Effect with two users                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `http/auth.ts` `identify()`, `ownerEmail()`                                                                              | Any valid session is "the owner"; identity is `OWNER_EMAIL`                                                                                                                    | Every user signed in as the owner                                                                                                                                          |
| A2  | `db/scoped.ts` `resolveMembership()`                                                                                     | Looks up by email, bootstraps the first user                                                                                                                                   | Same as A1                                                                                                                                                                 |
| A3  | `passkey`, `auth_session`, `device_link` (migration 0003)                                                                | No `user_id` column                                                                                                                                                            | Can't tell whose passkey or session it is                                                                                                                                  |
| A4  | `routes/auth.ts:37` and registration options                                                                             | Every passkey uses the WebAuthn user handle `ledgerline-owner` and the name "Ledgerline"; `excludeCredentials` lists every passkey in the database; `passkeyCount()` is global | A new account's passkey on a device that holds the owner's could **replace the owner's passkey** (same site, same handle); every credential id goes to anyone with a grant |
| A5  | `routes/auth.ts:117`                                                                                                     | First passkey needs `SETUP_CODE` while no passkey exists; no other way to create an account                                                                                    | No sign-up path                                                                                                                                                            |
| A6  | `routes/security.ts`                                                                                                     | Lists every passkey; "sign out everywhere" deletes every session; deletes any passkey by id; device links aren't tied to a user                                                | One user could see, sign out or lock out another                                                                                                                           |
| A7  | `sync/provider.ts` `connectionToken()` (Link repair, `routes/settings.ts:714`); `startSync()` (`routes/settings.ts:900`) | Load a connection by id with no budget check                                                                                                                                   | A user could open Plaid Link update mode on another user's bank                                                                                                            |
| A8  | Split lines (`routes/activity.ts`), then the CSV export and payee list joining `category` by id                          | A category id in a request body isn't checked against the budget                                                                                                               | Another budget's category name could show up in an export                                                                                                                  |
| A9  | `sync/steps.ts:430–460` `bank_txn` upsert and removal                                                                    | Matches on the global `provider_txn_id` with no budget predicate                                                                                                               | Safe only because Plaid ids are unique; one bad id would cross budgets                                                                                                     |
| A10 | `routes/settings.ts:722` `ITEM_LIMIT`, checked when the link token is made                                               | Counts Plaid rows in this budget                                                                                                                                               | Plaid's Trial limit is 10 Items **for the whole Plaid account, for life**; two users could each "have 10"                                                                  |
| A11 | `apply_counter` (one row), read by `http/etag.ts:57` and `ledger/totals.ts:70,117`                                       | One global counter of applied bank rows                                                                                                                                        | Every sync changes every user's ETag and blocks their month-totals done mark (extra reads; leaks when someone else syncs)                                                  |
| A12 | `bank_event` indexes                                                                                                     | No index starts with `budget_id`; `WHERE budget_id = ? AND id > ?` (`sync/process.ts:86`) and the health lag (`routes/ops.ts:93`) scan past other budgets' events              | Reads grow with other users' activity                                                                                                                                      |
| A13 | `cron.ts`                                                                                                                | Loops over every budget (daily scan inline) and every due connection in one invocation                                                                                         | Runs out of 10 ms CPU / 50 queries after a few users                                                                                                                       |
| A14 | `maintenance.ts:78`, `:219–221`                                                                                          | Each budget's run refreshes account usage (a GraphQL call) and prunes the global `auth_*` tables                                                                               | N calls and N prunes a day                                                                                                                                                 |
| A15 | `routes/api.ts:51` (ops token), `routes/ops.ts:114–118` (monitor check-in)                                               | Pick the first budget                                                                                                                                                          | Health and monitor report only on the owner                                                                                                                                |
| A16 | `sync/breaker.ts`, `usage_day`                                                                                           | One account-wide write budget, first come first served; only `POST /api/usage` adds estimates, the rest comes from analytics up to 4 hours old                                 | One user's first sync could use the day's writes and put everyone in read-only                                                                                             |
| A17 | `bank_page`, `bank_event`, `raw_page` triggers (`0001_init.sql:136,173`, `0002:13`)                                      | Append-only: any delete aborts                                                                                                                                                 | An account can't be deleted; a deleted user's raw bank data would stay for ever                                                                                            |
| A18 | Web: `screens/Auth.tsx` (only sign in or setup code); `state/saved.ts:8` (one saved-data key)                            | One person per browser                                                                                                                                                         | No sign-up screens; two accounts on one browser share saved screens until a 401 clears them                                                                                |
| A19 | `design.md:28` ("more users need no schema change")                                                                      | Stated as a property of the design                                                                                                                                             | Not true (A3, A4, A17); superseded by D-37                                                                                                                                 |

Screen and tap telemetry already has a per-budget `setting.tracking` toggle (`routes/ops.ts:28`); new budgets start with it off. No new column.

## 4. Accounts and sign-in

### 4.1 Schema (migration `0010_multi_user.sql`, additive)

- `user`: add `display_name TEXT`, `is_admin INTEGER NOT NULL DEFAULT 0`, `status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleting'))`, `last_seen_at INTEGER`, `link_allowance INTEGER NOT NULL DEFAULT 0`, `webauthn_handle TEXT`. `email` stays `NOT NULL UNIQUE` (a forward-only migration can't relax it without rebuilding the table); new users get `u:<user id>` and email is never used as identity again.
- `passkey`, `auth_session`, `device_link`: add `user_id TEXT REFERENCES user(id)`, with indexes on `passkey(user_id)` and `auth_session(user_id)`. `auth_session` also gets `challenge_id TEXT` with a unique index (4.6).
- Backfill: the existing user gets `is_admin = 1`, `link_allowance = 10`, `webauthn_handle = 'ledgerline-owner'` (the handle on their existing passkeys), and every passkey, session and device link gets that user's id. On a fresh install there is nothing to backfill; the setup code creates the first user as admin with the same handle.
- `bank_event`: index `(budget_id, id)` (A12). It costs one extra row write per bank event (about 1 in 5 of a sync's writes). That buys reads that no longer grow with other budgets; measured before and after in phase 2.
- `budget`: add `applied_seq INTEGER NOT NULL DEFAULT 0`, backfilled from `max(bank_event.id)` for that budget (A11).
- New tables:
  - `invite (token_hash TEXT PRIMARY KEY, created_by TEXT NOT NULL, link_allowance INTEGER NOT NULL DEFAULT 0, created_at, expires_at, used_at, used_by)`. Single use, 7 days, only the hash is stored.
  - `recovery_code (user_id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)`.
  - `plaid_link_slot (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, budget_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('reserved','used','released')), connection_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER)` (7.1).
  - `budget_usage_day (budget_id, day, written, read, steps, PRIMARY KEY (budget_id, day))` (7.2).
- Triggers: see 8.2.

### 4.2 Identity

- `identify()` returns `{ kind: 'user', userId, sessionId, verifiedAt }` from `auth_session.user_id`, joined to `user.status = 'active'`. `ownerEmail()` and `OWNER_EMAIL` go away. Local dev keeps `DEV_AUTH_EMAIL`, mapped to a dev user.
- `resolveMembership(db, userId)` reads `budget_member` by user id and returns the user's one budget. The bootstrap branch moves into the setup and sign-up flows.
- Disabling a user deletes their sessions, and their banks stop syncing (connections are skipped by the backstop and webhooks while the user is disabled).

### 4.3 Passkeys per user (A4)

- New users get a random 32-byte WebAuthn user handle (`user.webauthn_handle`) and their display name as `userName`. The owner keeps `ledgerline-owner`, so their passkeys keep working.
- `excludeCredentials` lists only that user's passkeys.
- Sign-in looks the passkey up by credential id, then checks that the assertion's `userHandle` equals that user's handle, so a credential can't be presented for another account.
- Because each account has its own handle, a new account made on a device that holds the owner's passkey adds a second passkey instead of replacing it.

### 4.4 How accounts are created

1. **Setup code** (unchanged): works only while the `user` table is empty.
2. **Invite link** (new): an admin makes a link in Settings → People. The token is in the URL fragment (like device links, `routes/security.ts:221`), so it isn't sent to the server or logged until the page posts it. The visitor names their passkey, the browser makes it, and one D1 batch creates the user, budget, owner membership, passkey, session and recovery code, and marks the invite used. The batch is fenced (the `lease_guard` pattern) on: the invite unused and unexpired, the sign-up gate, and the count of `active` + `disabled` + `deleting` users being under `MAX_USERS`.
3. **Open sign-up** (built; on only when `SIGNUPS = open`): the same flow without an invite.

New users land in the existing first-run setup and start with the `link_allowance` from their invite (default 0): manual accounts and CSV import work, Plaid doesn't until the admin grants a link.

### 4.5 The sign-up gate

- **`SIGNUPS`** (Worker variable in `wrangler.jsonc`, default `off`; `off` / `invite` / `open`) and **`MAX_USERS`** (default `1`). Both are deploy-time, so turning on takes a deploy and can't happen by accident from a screen.
- While `SIGNUPS = off`: the invite, sign-up and recovery routes return 404, the web app never shows them, and Settings → People shows nothing but the owner's account.
- Pausing sign-ups after turning on: set `SIGNUPS = off` and deploy (one tap in Actions).

### 4.6 Challenges and rate limits

Today `POST /api/auth/login/options` writes an `auth_challenge` row for anyone, so anyone could spend the day's 100,000 writes by calling it in a loop. That's true already, but public sign-up would advertise it.

- **Challenges without a write at start**: the challenge, purpose and grant go into a 5-minute cookie signed with HMAC-SHA-256 under a key derived from `TOKEN_KEYS` with HKDF (label `ledgerline-challenge`), not used for anything else. Starting a ceremony writes nothing.
- **Still single use**: a successful finish writes the session with `challenge_id` (unique index), in the same batch as the passkey counter update or the account creation. Replaying the cookie and assertion fails on the unique index. This replaces the `DELETE … RETURNING` single-use check, and doesn't rely on the signature counter (iCloud Keychain passkeys always report 0).
- **Rate limits**: the Workers rate-limiting binding (GA, listed with no paid-plan restriction; counts are approximate and per location) on every `/api/auth/*` and sign-up route, keyed by IP, for example 20 a minute. No D1 fallback: a counter that writes on failure would bring the same problem back.
- The challenge change applies to the owner too. It's in phase 3, tested on its own, and needs no new screen.

### 4.7 Recovery without email

The app sends no email (D-24).

- **Owner**: unchanged. The owner's recovery is D-27's (wrangler, or a device link from a signed-in device). No code is pushed on the owner.
- **Other users**: shown a recovery code once at account creation (24 random characters in groups of four). Only its hash is stored, under a unique index. "Lost your passkey?" (404 while `SIGNUPS = off`) takes the code, **deletes all of that user's passkeys and sessions**, registers a new passkey, and shows a new code.
- An admin can also make a single-use device link for a user from People, after checking who they are outside the app.

## 5. Roles and Settings → People

- `user.is_admin` marks who runs the instance. It's separate from `budget_member.role`.
- **People** (admins only; shown once `SIGNUPS` isn't `off`): invite links (create, copy, revoke, with a Plaid link allowance), users (name, joined, last seen, Plaid links used of allowance, today's writes and steps), disable and enable, change a link allowance, delete a user (section 8), and the shared counters: Plaid links used of the cap, users of `MAX_USERS`, today's writes, reads and Workflow steps.
- An admin can't see another user's budget, accounts or transactions. People shows only counts and dates.

## 6. Keeping users apart

### 6.1 Fixes

- A6: every query in `routes/security.ts` and `routes/auth.ts` filters by `user_id`, including "keep at least one passkey" (that user's passkeys).
- A7: `connectionToken(env, budgetId, connectionId)` and `startSync()` bind the budget id; so does every lookup by connection id.
- A8: every foreign id in a request body (category, account, payee, transaction key, rule) is checked against the budget before it's written. One helper, `assertOwned(s, table, ids)`, used by every route that takes ids.
- A9: the `bank_txn` upsert's `ON CONFLICT … DO UPDATE` and the removal update add `WHERE budget_id = excluded.budget_id` / `AND budget_id = ?`.
- A14: maintenance does account-wide work (usage refresh, `auth_*` prune) only in the run that the cron marks as first for the day.
- A15: the ops token's health check reports account-wide numbers (usage, worst lag, stale connection count). The monitor check-in is stored account-wide.
- A18: the saved-data key includes the user id.

### 6.2 Proving it: the two-tenant test

`apps/worker/test/isolation.test.ts` seeds two complete budgets, A and B, through the real sign-up path, with banks, transactions, splits, rules, targets, payees, passkeys and sessions. Then:

1. It enumerates every route registered on the Hono app, so a new route is covered automatically and an unknown one fails the test.
2. It calls each route as user A, putting B's ids wherever the route takes one, **in the path and in the body** (split lines, category and payee ids, transfer accounts, rule actions).
3. It checks that no response contains any of B's ids or names, and that a hash of every B row is the same before and after.

A lint test fails on any `.prepare(` outside an allowlist: `db/scoped.ts`, `routes/auth.ts`, `routes/security.ts`, `sync/*`, `budget/recompute.ts`, `budget/workflow.ts`, `http/etag.ts`, `ops/usage.ts`, `maintenance.ts`, `cron.ts`, `measure/*`, and named functions in `routes/settings.ts` and `routes/ops.ts`. Each allowed file gets a comment saying why.

### 6.3 Per-budget applied counter (A11)

`bank_event.id` stays globally unique, assigned from `apply_counter` inside the apply batch (`sync/steps.ts:390,466`). The same batch runs `UPDATE budget SET applied_seq = applied_seq + n WHERE id = ?`. ETags and the month-totals stamp use `budget.applied_seq`.

## 7. Sharing the free plan fairly

Cloudflare's limits and Plaid's Trial cap belong to the whole account. Each needs a per-user share. **Except 7.1, everything here is active only in multi-user mode.** With one user, the owner's syncs, schedules and limits are exactly today's.

### 7.1 Plaid links (A10): active always

The Trial slot is spent the moment the user finishes Plaid Link, before the app sees the result. So the slot has to be reserved **before** opening Link, not checked afterwards.

- `PLAID_LINK_CAP` (Worker variable, `10`) and `PLAID_LINKS_USED_BEFORE` (Worker variable, `7`: the owner-confirmed count from CLAUDE.md, not a count of `connection` rows, which may not match Plaid's).
- Making a link token for a new bank inserts a `reserved` slot (30-minute expiry) in a fenced batch: it goes in only if `PLAID_LINKS_USED_BEFORE` plus the `used` and unexpired `reserved` slots is under the cap, and the user's own count is under their `link_allowance`. Two people can't take the last slot together.
- Exchange **always saves the Item** (the 0005 rule: never lose a link that already counts) and marks the slot `used`. If the reservation had expired, the slot is marked `used` anyway and the over-count is reported on People. Cancelling Link marks it `released`. A reservation that expires without an exchange counts as released.
- Repair (update mode) never reserves a slot.
- **On Plaid Production** there is no lifetime cap; each Item costs a monthly fee instead. Switching is configuration only: set `PLAID_LINK_CAP` to `0` (meaning no cap) and `PLAID_LINKS_USED_BEFORE` stops mattering. The global count check is skipped, slots are still recorded (useful history), and `link_allowance` stays as the per-user control over how many paid Items each person can add. Nothing needs removing.
- For the owner this keeps today's behavior (confirm prompt, 3 left) with a stronger check.

### 7.2 D1 writes and reads (A16)

- **Counting first.** In multi-user mode, every write request sums `meta.rows_written` and `meta.rows_read` from its D1 results and adds them to `budget_usage_day` in the request's final batch (one extra row write per write request). Workflow steps do the same in the batch they already write. Reads on GET requests are summed and written at most once a minute per budget. In single-user mode none of this runs.
- **Per-user daily share**: `USER_WRITE_SHARE` (default 20,000 rows) and `USER_READ_SHARE` (default 1,000,000). Past either, that user's writes get 503 "Daily limit reached for your budget" and their background syncs pause until midnight UTC. Other users carry on. Admins are exempt.
- **New-bank backfills are admitted**: the first sync of a new connection is estimated at 7 writes and 50 steps per 1,000 transactions (from the 3,000-transaction measurement: 4.1 writes before processing, plus overlays and budget lines; 109–153 steps). Assume 3,000 transactions if unknown. It starts only if today's account writes and steps plus the estimate stay under the 70% pause line; otherwise it waits as `queued` and the backstop starts it after 00:00 UTC.
- The account-wide breaker (70% pause, 90% read-only) stays as the last line, in both modes.

### 7.3 Workflow steps and cron (A13)

Cloudflare's Workflows pricing page lists **3,000 steps a day** on Workers Free (verified Nov 2, 2026), plus 1,024 per instance and 100 concurrent instances. Workflow runs also share the 100,000 requests a day.

- **Cron fan-out (both modes)**: the daily scan and maintenance cron each create at most 25 per-budget Workflow instances per run, from a cursor, and the backstop cron finishes the rest. With one budget this is one instance at the same times as today. The daily scan becomes its own small Workflow started at 08:10 UTC, so Upcoming entries appear at the same time as today.
- **Backstop**: starts at most 20 syncs per run, oldest first.
- **Step counting and breaker** (multi-user mode): steps are counted in `budget_usage_day.steps` and summed for the account; new Workflow instances pause at 70% of 3,000.
- **Quiet budgets** (multi-user mode, not the admin's): a budget with no sign-in for 14 days gets its full recompute weekly instead of daily, and webhooks for it set `resync_requested`, picked up by the next backstop (every 4 hours) instead of syncing at once.
- sync-spec.md's limits table is updated: the step limit is verified, not "verify".

### 7.4 Storage

`raw_page` is append-only and never pruned: each 3,000-transaction backfill stores about 6 MB for good, plus ongoing syncs. People shows the database size against 500 MB, and sign-up refuses new accounts above 70%. Pruning old raw pages is a separate decision (it changes the sync spec's append-only rule) and isn't part of this build.

### 7.5 Rough capacity on the free plan

Estimates from `docs/measurements.md`; phase 7 measures them.

| Limit                  | Per active user, per day                             | Users it allows                           |
| ---------------------- | ---------------------------------------------------- | ----------------------------------------- |
| Plaid Trial links      | 1 to 7, once                                         | 3 links left in total: 1 to 3 more people |
| Workflow steps (3,000) | ~10 maintenance + ~12 per sync, 3–6 syncs per bank   | about 5 to 10; a new bank costs ~150      |
| D1 writes (100,000)    | a few thousand; ~20,000 on the day a bank is added   | about 10 to 15 steady users               |
| D1 reads (5,000,000)   | ~150,000 normal, up to 1,000,000 on a heavy day      | about 20 to 30                            |
| Storage (500 MB)       | ~6 MB per 3,000 transactions of raw pages, plus rows | 50+ before it matters                     |

On the free plan and Plaid Trial, other users means a handful. Section 9 lists what raises it.

## 8. Deleting an account

### 8.1 Flow

- The user (Settings → Security → Delete account, with a fresh passkey check and typing the budget name) or an admin starts it. `user.status = 'deleting'`, sessions are deleted at once, and a `DeleteAccountWorkflow` runs.
- Steps: remove each Plaid Item (`/item/remove`; this does **not** give the Trial slot back, and the confirm screen says so); then delete the budget's rows in chunks of 500 in foreign-key order (children first: `sync_page`, `bank_page`, `raw_page`, `bank_event`, `bank_txn`, snapshots, `txn_split`, `txn_link`, `txn_overlay`, `manual_pending`, `expected_reimbursement`, `budget_line`, totals, `assignment`, `target`, `rule`, `payee_alias`, `payee`, `category`, `category_group`, `account`, `provider_account`, `sync_run`, `connection`, `alert`, `audit_log`, `setting`, `health_status`, usage tables, `month_snapshot`, `budget_usage_day`, `budget_member`, `budget`); then passkeys, recovery code, device links and the user row. The exact order comes from the schema and is checked by a test that runs it on a seeded budget with foreign keys on. Each step checks the write breaker and pauses until midnight if needed.
- `plaid_link_slot` rows stay (they hold only ids and keep the Trial count right).
- The last admin can't be deleted from the app. The screen offers the JSON export first.

### 8.2 Append-only tables

`bank_page`, `bank_event` and `raw_page` block every delete. Migration 0010 replaces the three `*_no_delete` triggers with ones that allow a delete only when the row's budget belongs to a user with `status = 'deleting'`:

```sql
CREATE TRIGGER bank_event_no_delete BEFORE DELETE ON bank_event
WHEN NOT EXISTS (SELECT 1 FROM budget_member m JOIN user u ON u.id = m.user_id
                 WHERE m.budget_id = OLD.budget_id AND m.role = 'owner' AND u.status = 'deleting')
BEGIN SELECT RAISE(ABORT, 'bank_event is append-only'); END;
```

This is the only exception to the sync spec's append-only rule. It is recorded in D-37 and in sync-spec.md. Update triggers don't change.

## 9. Turning it on (owner decisions, not built here)

Each of these changes a hard rule or a decision:

1. **Plaid**: 3 Trial links are left in total. Real use needs Plaid Production (application, security questionnaire, monthly fees per Item). Also check that Trial terms allow linking banks for people other than the developer.
2. **Cloudflare Workers Paid** ($5 a month) raises every limit in 7.5 a lot. Most of 7.2 and 7.3 then matters much less.
3. **Backups**: D-29 is fine for the owner's own data; holding other people's needs a decision.
4. **Privacy policy and terms**, and what happens to people's data if the app shuts down.
5. **Monitoring**: someone needs to know when it breaks for other people.
6. Raise `SIGNUPS` and `MAX_USERS` and deploy.

## 10. Build phases

Each phase lands on `main` with `pnpm check` passing, and the owner's app is unchanged after each one (checked by the existing e2e suite and, for phases 1 and 3, a sign-in on the real app).

1. **Schema and identity**: migration 0010 (columns, backfill, tables, `bank_event(budget_id, id)` index, `applied_seq`, triggers); `identify()` and `resolveMembership()` by user id; security routes scoped by user (A1–A3, A6). _Verify:_ migration test on a copy of the current schema with the owner's rows; owner sign-in unchanged.
2. **Isolation**: A7–A9, A11, A12, A14, A15, A18; `assertOwned`; the two-tenant test and the `.prepare(` allowlist. _Verify:_ the isolation test passes, and fails when a scope is removed on purpose; reads per screen before and after the new index in `docs/measurements.md`.
3. **Passkeys per user, challenges, rate limits** (4.3, 4.6). _Verify:_ starting a sign-in writes 0 rows; a replayed cookie and assertion fails; an assertion with another user's handle fails.
4. **Sign-up gate, invites, recovery codes, People** (4.4, 4.5, 4.7, 5) and the web screens. _Verify:_ with `SIGNUPS = off` every new route returns 404; e2e for invite sign-up, a reused invite, `MAX_USERS` reached, recovery.
5. **Plaid slots** (7.1). _Verify:_ two link-token requests for the last slot: one gets it; an expired reservation followed by exchange still saves the Item.
6. **Fair share and fan-out** (7.2, 7.3). _Verify:_ with one user, no `budget_usage_day` writes and the same cron behavior as today; with two users, a backfill past the pause line queues; a cron run with 60 budgets stays under 10 ms CPU and 50 queries.
7. **Account deletion** (8). _Verify:_ deletion leaves no row with that `budget_id` except `plaid_link_slot`; append-only triggers still abort for active users.
8. **Capacity**: seed 10 users with the November fixture, run a simulated day, write the numbers in `docs/measurements.md`, update 7.5.
9. **Docs**: D-37 in `decisions.md` (identity by user id; email no longer identity; per-user passkey handles; recovery codes for non-owners; the append-only exception; supersedes `design.md:28`), update `sync-spec.md` (step limit, append-only exception), `threat-model.md`, and `build-plan.md`.

## 11. Open questions

- ~~Should a new user's link allowance default to 0 or 1?~~ **Decided by the owner (Nov 2, 2026): 0.** An admin grants links per person.
- Do Plaid Trial terms allow other people's banks at all? (9.1; decides whether 7.1's allowance matters before Production.)

## 12. Review (Nov 2, 2026)

Two adversarial reviews: one by the author, one by an independent agent that hadn't seen the author's reasoning. What changed from the first draft:

- **Account deletion couldn't work**: `bank_event`, `bank_page` and `raw_page` block deletes. Added 8.2 (a narrow trigger exception) and a foreign-key order.
- **The Plaid slot check came too late**: the slot is spent when Link finishes, before the app could refuse. Now reserved before Link opens (7.1), and the starting count is the owner-confirmed 7.
- **Passkeys shared one user handle** (missed in the draft): a new account's passkey could have replaced the owner's. Added A4 and 4.3.
- **"Nothing changes for the owner" wasn't true**: backfill admission, quiet budgets and moving the daily scan would have changed the owner's app. All of 7 except Plaid slots now runs only in multi-user mode, the daily scan keeps its time, and the owner gets no recovery code.
- **The replay argument was wrong** (iCloud passkeys don't count signatures): single use now comes from a unique `challenge_id` on the session. The D1 rate-limit fallback was dropped; the Workers rate-limiting binding is used.
- **Usage counters the shares relied on don't exist**: 7.2 now builds the counting first, only in multi-user mode.
- **The step limit is real** (3,000 a day on Free): admission and the breaker count steps.
- **More isolation gaps**: foreign ids in bodies (A8), the `bank_txn` upsert (A9), `startSync` (A7), no `budget_id` index on `bank_event` (A12), per-budget maintenance doing account work (A14), shared saved data in the browser (A18). The lint allowlist now matches `.prepare(`.
- **Factual fixes**: A10 counts every Plaid row ever made (none are removed), telemetry already has a toggle, `raw_page` is never pruned, and the writes-per-transaction estimate went from 5 to 7.
- **Simplified**: dropped the second sign-up switch (`app_config`), the `telemetry` column and invite kind `member`. Not dropped, though the reviewer suggested it: fair-share limits, quiet budgets and recovery codes stay, because the owner asked for everything to be built. They're gated so they cost nothing while off.
