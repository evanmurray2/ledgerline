# Multi-user design: Durable Objects for everything

Status: v3.1, Nov 2, 2026. This replaces v1 (one shared D1 database) and v2 (a database per budget plus a D1 directory). v3 got an adversarial review, and this revision includes its fixes. Section 14 keeps the history.

What the owner asked for:

- Build everything other people need to use Ledgerline, but keep sign-up switched off.
- Give each budget its own database.
- Move all data into the new databases and delete the old D1 database.
- **Preserve all data on every path.**
- Plan accounts and sign-up in the same design.
- New users start with 0 bank links.

## 1. Goal

1. **Move all data out of D1 into Durable Objects**, each with its own SQLite database:
   - one `BudgetStore` per budget;
   - one `Directory` for users, passkeys, sessions, invites, Plaid slots, and which budget each bank link belongs to.
2. **Delete the D1 database** once the move is verified and the owner says so.
3. **Build accounts, invites and sign-up for other users, switched off.** While the instance has one active user, the owner's app works as it does today, apart from the move. New public routes return 404, and fair-share limits run only in multi-user mode (more than one active user).

**Hard rule: no data is lost on any path.** That covers the move, a failed move, going back, deleting D1, deploys, killed background steps, and restores. Every step that could lose data either has a verified copy behind it or doesn't run. Sections 8 and 9 show how each path keeps the rule.

Non-goals: paying plans, email, a custom domain, native apps, off-site backups (D-29: the owner keeps their own downloaded copies), and sharing one budget between two people.

## 2. What does not change

- **Money rules.** `packages/domain` and `computeBudget()` are untouched. Nothing here changes how money is counted.
- **The SQL schema and queries**, except for the changes listed in 5.6. Durable Objects run SQLite, as D1 does.
- **The sync guarantees** in `docs/sync-spec.md`:
  - the cursor never moves backwards;
  - retries add nothing;
  - summaries equal a full recompute;
  - background work can't exceed the daily write limit.

  Leases, fences and the watermark keep their meaning (6.3).

- **The 10 ms CPU rule.** Every request and every alarm invocation stays inside it. Section 12 (phase 0) measures this on Cloudflare.

One visible change, recorded as a decision: an edit to a month 3–6 months back used to finish recomputing in the same request. It will now show "Updating" for a moment, because recompute steps shrink from 6 months to 2 (D-22 is revised).

## 3. Why this shape

- **One database per budget.** Each person's data is physically separate. Each budget gets its own size limit (1 GB on Free, 10 GB on Paid) and its own writer. Deleting an account deletes one database.
- **The Directory is a Durable Object, not D1,** because the owner wants D1 gone.
- **Durable Objects rather than one D1 per user.** The app can only reach D1 databases listed in its deployed config, so every new account would need a deploy.
- **Alarms rather than Workflows.** In-process SQLite counts as CPU, so background work has to run in small steps. Phase 0 sized these at 2 months of recompute and 25 events of apply or processing per step, about 2–4 ms each. As Workflow steps, that many small steps would use up the 3,000 a day allowed on Free. An alarm counts as one Durable Object request instead (100,000 a day on Free).

## 4. Cloudflare services at the end

| Service                      | Used for                                                                                      | Free-plan limits that matter                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Workers**                  | Static web app, API entry, sign-in checks, routing each request to the right object           | 100,000 requests a day; 10 ms CPU                                                                                                  |
| **Durable Objects (SQLite)** | `Directory` (one) and `BudgetStore` (one per budget); alarms run all background work          | 1 GB per object, 5 GB per account; 5M rows read and 100k rows written a day; 100,000 requests a day; 13,000 GB-s of duration a day |
| **Cron Triggers**            | One daily trigger: account usage refresh, plus a check that every budget's jobs are scheduled | 1 of 5                                                                                                                             |
| **Rate Limiting binding**    | Sign-in and invite attempts                                                                   |                                                                                                                                    |
| **GraphQL Analytics API**    | Account-wide usage, for the write breaker                                                     |                                                                                                                                    |

Removed: **D1** (deleted after the move) and **Workflows** (replaced by alarms). Not used: R2, KV, Queues, Zero Trust, Email. Nothing here needs a payment card.

## 5. Architecture

### 5.1 Request path

1. The Worker serves static files directly.
2. For `/api/*`, the Worker:
   1. authenticates with the Directory (`authenticate(tokenHash)` returns `{ userId, budgetId, verifiedAt, sessionId }` or a refusal);
   2. checks CSRF, rate limits and the recent-passkey rule;
   3. forwards to `BudgetStore(budgetId).api(request, { userId, verifiedAt })` over RPC.
3. **Session cache.**
   - For GET requests only, the Worker caches the Directory's answer in the isolate for 30 seconds.
   - Writes, and every route that needs a recent passkey, always ask the Directory, so a revoked session can't write at all.
   - A revoked session can keep reading for up to 30 seconds in an isolate that cached it. `threat-model.md` records this.
   - `last_seen_at` is written at most once an hour per session, so authentication isn't a write per request.
4. Sign-in, security, invites, People and the Plaid webhook go through the Directory.
5. The Worker never takes a budget id from the request. The store is chosen only from the session's membership.

A GET with a cached session costs one Worker request and one Durable Object request. A write costs one Worker request and two Durable Object requests.

### 5.2 Directory (one object)

**Tables:**

- `user` (with the 7.1 columns), `budget` (`id`, `name`, `created_at`), `budget_member`
- `passkey`, `auth_session`, `device_link`, `invite`
- `plaid_link_slot`
- `connection_route` (Plaid item id as primary key → budget id, connection id)
- `usage_day`, `budget_usage_day`
- `app_state` (cron cursor, job health)
- `job` (its own background work, 6.1)

**RPC methods:**

- `authenticate`
- ceremonies: sign-in, setup, invite, device link (also used for People's reset link)
- security, invites, People
- `reserveSlot`, `useSlot`, `releaseSlot`
- `routeFor`, `registerRoute`
- `noteUsage`, `usageToday`
- `health`, `dumpChunk`, `loadChunk`

The soft limit is about 1,000 requests a second per object. The GET cache keeps this app far below that up to thousands of active users. Past that, sessions would be split across several `SessionShard` objects keyed by token hash, with users, invites and slots staying in the Directory. That isn't built now. The Directory's People screen shows requests per second, so the need would be visible well before it bites.

**If the Directory breaks** (a bad migration, a bug), the whole app is down, reads included. Two things limit the damage:

- The deploy smoke test migrates the Directory first, so a bad migration fails the deploy (5.8).
- The runbook's recovery path is Cloudflare's dashboard data browser for Durable Object SQLite, plus the full dump (8.7). Phase 0 checks that the data browser works from the owner's iPhone. It replaces today's `wrangler d1` recovery, which goes away with D1.

### 5.3 BudgetStore (one per budget)

- **Data:** every other table in today's schema, plus the budget's own fields from today's `budget` row, now in a one-row `budget` table. Also its `job` table.
- **API:** the budget's Hono routes (budget, activity, accounts, owed, reports, settings except security, export and import, usage), running inside the store with `env.DB` set to the adapter (5.5).
- **RPC:** `api`, `startSync`, `ensureJobs`, `health`, `dumpChunk`, `loadChunk`, `verifyChunk`, `wipe`.
- **Id:** `idFromName(budgetId)`.

### 5.4 Who calls whom

- **Worker → Directory:** authentication and everything in 5.2.
- **Worker → BudgetStore:** API requests, the webhook (after `routeFor`), the daily `ensureJobs`.
- **BudgetStore → Directory:** `noteUsage` (batched), `usageToday` (cached for a minute), `useSlot`, `registerRoute`.
- **Directory → BudgetStore:** creating a new budget's store at sign-up, and `wipe` at deletion.

No transaction ever spans two objects. Every change that touches both is a series of idempotent, retried steps (6.4).

### 5.5 The D1-shaped adapter

Inside an object, `env.DB` is an adapter with D1's interface over `ctx.storage.sql`.

- **Binding values:** bound values are coerced as D1 does it. Booleans become 0 or 1, `undefined` throws, and `ArrayBuffer` and `Uint8Array` become blobs.
- **`first`, `all`, `run`** call `sql.exec`. `meta` then carries:
  - `changes` from `SELECT changes()` and `last_row_id` from `SELECT last_insert_rowid()`, run right after the statement. The cursor's `rowsWritten` counts index writes too, and the sync leases depend on `changes === 1`.
  - `rows_read` and `rows_written` from the cursor. The two extra statements add a few rows read, and those are counted.
  - **`RETURNING` rows**, from single statements and from batches. The code uses them in `sync/steps.ts:236` and `routes/auth.ts:70`.
- **`batch(stmts)`** runs inside `ctx.storage.transactionSync(...)`. A statement that throws rolls back the whole batch. So the fence pattern, where `lease_guard`'s `CHECK (ok = 1)` aborts the batch, works unchanged.
- **Errors:** `isFenceAbort()` and any other matched error text accept both D1's wording and the Durable Object's. A test forces each fence on both backends.
- **No `await` inside a batch.** Batches are built before they run.
- **Limits** match D1: 100 bound parameters, 2 MB per value, 100 KB per statement.
- **Freeze switch** for the move (8.2): when set, every write through the adapter throws `frozen`. Every object write passes through here.

The fence tests, integration suite and measure suite run against both D1 and the adapter until D1 is removed. After that, they run against the adapter alone.

### 5.6 What actually changes in the code

`env.DB` appears in 17 source files, about 400 calls in all. These need real changes beyond the adapter:

| Area                                                                                                     | Change                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `http/auth.ts`, `routes/auth.ts`, `routes/security.ts` (29 sites)                                        | Move into the Directory. Queries filter by `user_id` (7.1).                                                                                                                                                                          |
| `routes/api.ts` middleware                                                                               | Split: identity, membership, CSRF, rate limit and reauth stay in the Worker. ETags, `bumpOnChange` and the read-only breaker move into the store.                                                                                    |
| `sync/workflow.ts`, `budget/workflow.ts`, `maintenance.ts`, `cron.ts`                                    | Replaced by the job runner (6.1). The step functions (`beginRun`, `fetchPage`, `applyPage`, `processPending`, `finalizeConnection`, `recompute`, the maintenance steps, `dailyScan`) are reused as job steps at the new chunk sizes. |
| `maintenance.ts` watchdog                                                                                | Split: the auth prune runs in the Directory; the rest runs in the store.                                                                                                                                                             |
| `sync/breaker.ts`, `ops/usage.ts`                                                                        | Account usage comes from `Directory.usageToday()`. `noteUsage` goes to the Directory.                                                                                                                                                |
| `routes/ops.ts` `/usage`                                                                                 | The store writes first, then the Directory note.                                                                                                                                                                                     |
| Webhook, `startSync`, link exchange                                                                      | See 6.4.                                                                                                                                                                                                                             |
| `routes/api.ts` ops-token health and `routes/ops.ts` monitor stamp                                       | Account numbers come from the Directory and the owner's store health from the store. The monitor stamp is stored in the Directory.                                                                                                   |
| `apply_counter`, `lease_guard`                                                                           | Become per-store tables.                                                                                                                                                                                                             |
| JSON export                                                                                              | Stays as the human-readable export. The full dump (8.7) is the copy that can be restored.                                                                                                                                            |
| `measure/*`, `measure/dev.ts` seed routes, `tools/ci/sandbox-e2e.mjs`, `tools/monitor.mjs`, `deploy.yml` | Seed routes run inside a store in dev. The sandbox e2e test drives jobs instead of Workflows. The monitor reads the new health. `deploy.yml` drops the D1 migration step in phase 5 and calls `health()` in its smoke test.          |
| Tests                                                                                                    | The 26 seeding sites that use `env.DB` get store fixtures. `vitest-pool-workers` runs the objects.                                                                                                                                   |
| Web app                                                                                                  | `/api/session` reports `moving`, and the app shows a "Moving your data" banner with writes paused (8.2). Unsent writes are kept and retried after the move.                                                                          |

A lint test fails on `.prepare(` or `.batch(` outside an allowlist of files, and each listed file names the object it runs in.

### 5.7 Schema and migrations

- Migrations live in `packages/db/budget-migrations/` and `packages/db/directory-migrations/`. Each starts from a baseline equal to today's schema after 0009, split between the two.
- The `budget_id` columns stay, always equal to the store's id. Removing them would touch every query, so that's left for later.
- Each object runs pending migrations at start, inside `blockConcurrencyWhile`. Each migration runs in its own `transactionSync` and is recorded in `_migrations`. Running them again does nothing.
- **Expand-only.** A migration may add tables, columns and indexes. It never drops or renames anything the previous release still reads. Objects may run old code for a while after a deploy, and a rollback restores old code but not the old schema. Removing something takes two releases. `tools/ci/migration-check.mjs` checks both directories.
- **A failing migration** makes the object refuse requests with a clear error, rather than serve a half-migrated schema. The deploy smoke test calls `health()` on the Directory, then on the owner's store, so a bad migration fails the deploy before it reaches anyone else.

### 5.8 Deploys and rollback

- Cloudflare's rollback can't step back over a deploy that adds a Durable Object class. So the classes ship in a deploy of their own that changes no behaviour (phase 1). Normal deploys roll back as today after that.
- Phase 0's throwaway Worker is a separate Worker, approved by the owner. It doesn't affect the live Worker's classes.

## 6. Background work on alarms

### 6.1 The job runner

Each object has a `job` table with these columns: `id`, `kind`, `connection_id`, `state` (JSON), `run_at`, `attempts`, `last_error`, `recurring`, `created_at`.

The alarm handler does this:

1. Pick the earliest due job.
2. **Before running anything,** commit `attempts = attempts + 1` and set a watchdog alarm for 5 minutes ahead. A step that is killed (CPU overrun, a deploy restarting the object, an isolate reset) still counts as an attempt and still gets retried. The platform's own retries of `alarm()` (up to 6, with backoff from 2 seconds) are only a fallback; the job's own `attempts` is what counts. `alarmInfo.retryCount` is logged.
3. Run **one step**, sized for about 2–4 ms of CPU.
4. Save the job's new state, or delete the job when it's finished. In the same transaction, reset `attempts` to 0 after a successful step.
5. Set the next alarm, synchronously, for the earliest `run_at`.

If a step fails:

- `run_at` backs off: 10 s, 30 s, 2 min, 10 min, 1 h.
- After 6 attempts the job is marked failed, an alert is written, and a sync job releases its lease the way `releaseFailed` does today.
- **No data is lost by a failed step.** Steps are idempotent, as today's Workflow steps are, and the data a step works on stays in the database until a later step succeeds.

| Job kind                 | Steps                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sync`                   | begin → fetch one page (100 transactions) per step → apply 25 events per step → process 25 events per step → finalize → release or hand off. Same phases, tables and fences as today's Workflow. |
| `recompute`              | 2 months per step until caught up                                                                                                                                                                |
| `maintenance`            | Today's steps, smaller (full recompute at 2 months per step)                                                                                                                                     |
| `daily_scan`             | Today's `dailyScan`, 40 Upcoming entries per step                                                                                                                                                |
| `register_link`          | Finishes a new link in the Directory (6.4)                                                                                                                                                       |
| `dump`, `load`, `verify` | Copying and checking data (section 8)                                                                                                                                                            |

### 6.2 Recurring jobs

- Each store keeps three **recurring job rows**: the sync backstop every 4 hours, the daily scan at 08:10 UTC, and maintenance at 10:20 UTC (the same times as today). A recurring row is never deleted; finishing a run just moves its `run_at` forward.
- The one daily cron trigger refreshes account usage and starts an `ensure_all` job in the Directory. That job calls `ensureJobs` on `ENSURE_BATCH` budgets per step (default 25), from a cursor, until every budget has been checked that day. This covers any number of budgets without a longer cron run. `ensureJobs` recreates any missing recurring rows, checks that an alarm is set, re-registers any of the store's items missing from `connection_route`, and reports failed jobs.
- With one budget, the cron makes one call.

### 6.3 Leases and fences inside one object

- A store runs one alarm at a time. While a step is waiting on Plaid, other requests and the watchdog alarm can run.
- So the connection lease stays exactly as it is (`sync/lease.ts`, the `lease_guard` fences, the 90-minute TTL), and a step that has lost its lease can't apply a page.
- Hand-off works as today: the new run is a new `sync` job.
- "Pause until 00:00 UTC" becomes `run_at` set to the next UTC midnight, with the lease extended as today.

### 6.4 Changes that touch both objects

**New bank link**

1. `Directory.reserveSlot(userId)` writes a `reserved` slot. It is checked against the cap and the user's allowance in one transaction, **lasts as long as the Plaid link token** (4 hours unless phase 0 finds otherwise), and its id is tied to that token.
2. The user finishes Plaid Link.
3. The store's exchange checks that the slot id matches. It **always** saves the connection and token, because the slot is spent the moment Link finishes. It then queues `register_link`.
4. `register_link` calls `registerRoute(itemId, budgetId, connectionId)` and `useSlot(slotId)`. Both are idempotent and retried until they succeed.

If the item is already routed to another budget, the Directory refuses. The connection is then marked `duplicate_item` and an alert is shown.

**Webhook**

The Worker verifies the signature, asks `routeFor` which budget owns the item, then calls `startSync` (or records `item_error`) in that store. An unknown item is logged and answered 200. `ensureJobs` reconciles routes daily.

**Sign-up**

1. One Directory transaction creates the user, budget, membership and passkey, and marks the invite used. The session follows.
2. The Worker then calls the new store's `health()`, which creates the store and runs its migrations.
3. The store fills in its first-run rows on first request. If the steps are interrupted part-way, the result is an empty budget that still works.

**Deletion:** see section 10.

## 7. Accounts and sign-in

### 7.1 Identity

- `user` gains these columns: `display_name`, `is_admin`, `status` (`active` / `disabled` / `deleting`), `last_seen_at`, `link_allowance` (default **0**), `webauthn_handle`.
- `passkey`, `auth_session` and `device_link` gain `user_id`.
- The move (section 8) writes the owner as admin, with link allowance 10 and handle `ledgerline-owner`, on their existing passkeys.
- `identify()` takes the user id from the session. `OWNER_EMAIL` goes away. Email is no longer identity; new users get `u:<id>` in its place.
- Disabling a user deletes their sessions and pauses their banks' sync jobs.

### 7.2 Passkeys, challenges, rate limits

- **Per-user passkey handles.** New users get a random WebAuthn user handle and their name as `userName`. `excludeCredentials` lists only that user's passkeys. Sign-in checks that the assertion's `userHandle` matches the passkey's user.
- **Challenges in a cookie.** Starting a ceremony writes nothing. The challenge goes in a 5-minute HMAC-signed cookie (HKDF key from `TOKEN_KEYS`, label `ledgerline-challenge`). A successful finish stores `challenge_id` on the session under a unique index, so replaying the cookie and assertion fails.
- **Rate limits.** The rate-limiting binding allows about 20 a minute per IP on every sign-in and invite route.

### 7.3 The switch and invites

**Later, not built (owner, Nov 2, 2026):** 7.3 and 7.4 are deferred. Only the per-user databases are built now; the identity columns, per-user passkey handles and the `invite` table are in place for when invites are wanted.

- `SIGNUPS` (`off` / `invite`, default `off`) and `MAX_USERS` (default 1) are Worker variables, so turning invites on takes a deploy. While `off`, the invite and People routes return 404 and the web app hides them. Any other value counts as `off`.
- **Invite:**
  - The token goes in the URL fragment. It's single use and lasts 7 days, and only its hash is stored.
  - One Directory transaction creates the account, checked against the invite, the switch and `MAX_USERS` (counting active, disabled and deleting users).
  - The new user starts with the invite's link allowance, which defaults to 0.
- **Cut (owner, Nov 2, 2026):** open sign-up and recovery codes. Invites are enough for people the owner knows, and a locked-out user gets a reset link from People (7.4) instead of a code.
- **The owner** keeps D-27's device link. Below that, the runbook uses the dashboard data browser (5.2).

### 7.4 Settings → People (admins)

**People** appears once `SIGNUPS` is `invite`:

- invites: make one (with a bank-link allowance), cancel one
- users: name, joined, last seen, links used of allowance
- turn an account off or on (off signs it out everywhere), set bank-link allowances, delete (section 10)
- **reset link** for a locked-out user: removes their passkeys, sessions and device links and makes a one-day, single-use link to add a new passkey, which the admin sends them. Not for admins.
- shared counters: Plaid links used of the cap, users of `MAX_USERS`

**Cut (owner, Nov 2, 2026):** the Diagnostics screen. The full backup (8.7) is on Import and export, and the Cloudflare dashboard covers the rest. There is no restore button: restores are a runbook step (8.8).

## 8. Moving all data and deleting D1

The owner's D1 database is 4.2 MB: 718 transactions, 7 banks, 20 raw pages (Nov 2, 2026). The move runs once, at a time the owner picks, and should take a few minutes.

### 8.1 Before the move

- Phases 1–3 ship with D1 still serving everything. The Directory and the owner's store exist but are empty.
- The move is controlled by a new D1 table, `move_state`, with columns `phase` (`none` / `frozen` / `moved`), `started_at`, `lease_expires`, and `changes` (a counter).

### 8.2 The freeze, enforced by the database

Migration 0010 adds triggers to every D1 table except `move_state` and `move_queue`:

- a `BEFORE INSERT`, `BEFORE UPDATE` and `BEFORE DELETE` trigger that runs `RAISE(ABORT, 'frozen')` when `move_state.phase != 'none'`;
- an `AFTER` trigger that adds 1 to `move_state.changes`.

So a write that slips past a code check still can't land, and the switch only needs to compare one counter. While the phase is `none`, the triggers do nothing except count. Phase 0 measures what the counter costs in writes. If it costs too much, the counter triggers are added only for the move, in the same migration as the freeze.

**No data is dropped while frozen:**

| Writer                                                                                       | While frozen                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API writes                                                                                   | The web app shows "Moving your data", keeps unsent changes on the phone, and sends them after the move                                                                                                                                              |
| Screen reads that would write (`fresh()` recompute, month-totals cache fill, `bumpOnChange`) | Skip the write; serve stored values                                                                                                                                                                                                                 |
| Sign-in                                                                                      | Paused with the same banner; existing sessions keep reading                                                                                                                                                                                         |
| Plaid webhooks (sync requests and `item_error`)                                              | Recorded in `move_queue` (exempt from the triggers), replayed into the store after the switch                                                                                                                                                       |
| A Plaid link finished during the freeze                                                      | Can't happen: no new link tokens are issued for 4 hours before a freeze, and a freeze can't start while a reservation or link token is younger than 4 hours. If one happens anyway, the exchange saves the token in `move_queue` and it is replayed |
| `/api/usage` telemetry                                                                       | The app keeps the events and resends them                                                                                                                                                                                                           |
| Monitor health stamp                                                                         | Written again by the next monitor run (a status, not data)                                                                                                                                                                                          |
| Workflows, crons, `startRecompute`                                                           | The move waits until no lease is held and no Workflow instance is running, then freezes. Crons skip while frozen                                                                                                                                    |

- **Lease:** the freeze lasts at most 30 minutes. If the move hasn't switched by then, it aborts on its own: the phase goes back to `none`, D1 carries on serving, and the new objects are wiped.
- **Recording the counter:** the move records `changes` when the freeze starts.

### 8.3 Copy (`move_in`)

The new objects read D1 through the D1 binding, which stays configured until phase 5.

- **Directory rows:**
  - `user`, `budget_member`, `passkey`, `auth_session`, `device_link`, with the new 7.1 columns;
  - one `connection_route` per Plaid item;
  - Plaid slots, starting at 7 used.
- **Store rows:** every budget table, in foreign-key order. Steps are about 50 KB of rows each: phase 0 measured a 150 KB step at 10.5 ms (p50) on Cloudflare, and CPU grows with bytes. A step always copies at least one row, and a 200 KB `raw_page` row is a step on its own.
- **Tables without `budget_id`:**
  - `apply_counter` takes D1's value;
  - `lease_guard` is created fresh;
  - leases are copied as NULL.
- **Canonical hash.** A running SHA-256 per table, over a canonical encoding: typed values, rows in primary-key order. The schema has no REAL or BLOB columns, which keeps the encoding simple. Hashing runs inside the copy steps.

### 8.4 Verify

Verification checks, all of them in steps:

- row counts per table;
- the same canonical hash computed on the D1 side;
- a full recompute in the store, which must equal the stored month snapshots and Ready to Assign;
- the rule 10 identity.

Any difference stops the move. The phase goes back to `none`, D1 carries on with nothing changed, and the new objects are wiped.

### 8.5 Switch

The switch happens in this order:

1. One D1 statement sets `phase = 'moved'`, but only if `changes` still equals the value recorded at the freeze. A write that somehow got through aborts the switch.
2. D1's triggers keep refusing every write from then on: `phase` isn't `none`.
3. The Worker reads `move_state` (cached for 10 seconds) and starts routing to the Directory and the stores. A request that still reaches D1 in those seconds can only read.
4. The store replays `move_queue` and queues a sync for every connection.

### 8.6 Going back before D1 is removed (`move_out`)

While the D1 code paths still exist (before phase 5), going back copies everything, including every change made since the move:

1. Freeze the objects' writers at the adapter (5.5), with the same 30-minute lease.
2. Unfreeze D1. The copy writes into D1's tables **after emptying them**: each table is emptied and refilled in one step per chunk, with the append-only triggers' `move_state` exemption active only during `move_out`.
3. Verify with the same counts, hashes, recompute and identity check as the move.
4. Switch the Worker back to D1.

This works only while D1's schema still matches. The expand-only rule and CI keep the D1 schema covering both object schemas until phase 5, and `move_out` runs in CI both ways on the November fixture and on a 3,000-transaction budget, with edits made between the two moves.

### 8.7 The full dump

The **full dump** is a copy of every table of every object the user can reach: the Directory rows for the user, plus their budget's store, including raw pages, sync state, snapshots, the audit log and the encrypted Plaid tokens.

- **Format:** one NDJSON file. Each line is `{ table, row }`, with a header carrying the schema versions and the canonical hash of every table.
- **Download:** Settings → Import and export → Full backup. It is streamed in chunks, and the download needs a fresh passkey check.
- **Restore:** a runbook step loads a dump into new, empty objects through `loadChunk`, then runs the same verification as the move.

It replaces "keep the JSON export" as the copy the owner keeps. The JSON export stays as the readable one.

Tokens stay encrypted under `TOKEN_KEYS`, so the dump is safe to store without them, but it can only be restored on an instance that has the same `TOKEN_KEYS`. The runbook says so.

### 8.8 Deleting D1, and the way back afterwards

D1 is deleted only when the owner says so, after all of these:

1. The owner has used the app on the new databases for a while (their choice; a week is suggested).
2. The owner downloads a full dump and keeps it.
3. A **restore dry run** passes: a dump of the owner's data is loaded into fresh scratch objects, verified against the live ones, then wiped. This needs no D1 and no deploys.
4. A deploy removes the D1 binding, the D1 serving paths and the Workflows (phase 5). Then the `ledgerline` D1 database is deleted. Cloudflare can still undelete it for 7 days, as an extra safety net.

**After phase 5, the way back is the full dump,** not D1. If an object is damaged or a restore is needed, the runbook loads the latest dump, or the object's own point-in-time backup, into fresh objects.

Point-in-time restore is a runbook step, never an in-app button:

1. Download a full dump.
2. Take the undo bookmark that Cloudflare returns.
3. Restore.
4. Reconcile the Directory's routes and slots with the store's connections, so nothing is orphaned. This is checked by `ensureJobs`.

Phase 0 confirms point-in-time recovery works on Free.

## 9. Sharing the free plan

### 9.1 Plaid links (always on)

- `PLAID_LINK_CAP` is 10 (set it to 0 for no cap on Plaid Production). `PLAID_LINKS_USED_BEFORE` is 7.
- Slots are reserved before Link opens. Each reservation lasts as long as its link token and is tied to it (6.4).
- The exchange always saves the Item, including during a freeze (8.2).
- Cancelling Link releases the slot. Repairing a link never reserves one.

### 9.2 Daily limits

- Each object tracks its own rows read and written in its own SQLite. It sends them to `Directory.noteUsage` at most once a minute.
- **The account breaker** (70% pause, 90% read-only) uses GraphQL Analytics plus the Directory's recent counts. Phase 0 finds the right dataset and checks whether Durable Object rows share D1's pool.
- **Cut for now (owner, Nov 2, 2026):** per-user daily shares, admitting backfills against today's usage, and the weekly recompute for idle budgets. They only matter with many users; the account breaker still protects the free plan.

### 9.3 Capacity on Free

Estimates only; phases 0 and 8 measure these.

| Limit                             | Per active user per day                                        | Users it allows                     |
| --------------------------------- | -------------------------------------------------------------- | ----------------------------------- |
| Plaid Trial links                 | 1 to 7, once                                                   | 3 left in total: 1 to 3 more people |
| Durable Object requests (100,000) | 1–2 per API call, ~20–60 alarm steps; ~300 once for a new bank | dozens                              |
| Rows written (100,000)            | a few thousand; ~20,000 the day a bank is added                | about 10 to 15                      |
| Duration (13,000 GB-s)            | a few hundred GB-s                                             | dozens                              |
| Storage                           | ~9 MB a year                                                   | 1 GB each, 5 GB total               |

## 10. Deleting an account

1. The user starts it from Settings → Security → Delete account, with a fresh passkey check and by typing the budget name. An admin can also start it from People.
2. The screen offers the full dump first and says plainly that the data will be gone.
3. `status` becomes `deleting` and the user's sessions are deleted.
4. The store removes each Plaid Item (the Trial slot doesn't come back) and then wipes itself.
5. The Directory deletes the user's rows. `plaid_link_slot` rows stay.

This is the one path where data is deleted on purpose, at the user's explicit request.

`wipe`, `dumpChunk` and `loadChunk` refuse unless the Directory holds a matching record for that budget: a delete, a move or a dump. The last admin can't be deleted.

## 11. Keeping users apart

- The store is chosen only from the session's membership. A test signs in as user A and tries to reach B's data through every route, with B's ids in both the path and the body.
- Directory queries filter by `user_id`: passkeys, sessions, device links.
- `wipe`, `dumpChunk` and `loadChunk` are guarded (section 10).
- Webhooks are routed only through `connection_route`.

## 12. Build phases

Each phase lands on `main` with `pnpm check` passing. Until phase 4's switch, which runs only when the owner says so, the owner's app runs on D1 as today.

**0. Measure on Cloudflare**

This runs on a throwaway Worker in the owner's account (approved), deployed by a manual GitHub workflow using the existing `CLOUDFLARE_API_TOKEN`, and deleted afterwards. It measures or checks:

- **CPU, from Workers Logs, at p50, p95 and p99:**
  - apply (25 events);
  - processing (25 events);
  - recompute (2 months);
  - a `move_in` step (about 150 KB);
  - the Budget and Activity screens on 3,000 transactions.

  The gate is p95 under 8 ms. If the Activity screen misses, the fallback is a stored list of recent rows, updated by sync.

  **Result (Nov 2, 2026, `docs/measurements.md`):** every sync step, recompute step and screen passes, except the Activity screen (p95 10.8 ms) and the 150 KB move step (p95 17.9 ms). Move steps shrink to 50 KB.

  **The Activity screen: a gate before the move, not built yet.** Profiling showed no single expensive query to fix. The cost is spread over about a dozen indexed queries (the largest about 1 ms locally) plus row building. The local `localDate` formatter was rebuilt on every call and is now kept, a small saving on every screen. The measured data was three years of transactions; the owner has six months, and the screen's cost grows with history. So phase 4 starts by re-measuring Activity on Cloudflare with an owner-sized copy (phase 0 workflow). If p95 is under 8 ms, the move goes ahead without the stored list. If not, the stored list of recent rows (kept up to date by sync and edits) is built and measured first. Either way the result is recorded in `docs/measurements.md` before the owner's data moves. Durable Objects on Free did not stop at 10 ms: a 49 ms request succeeded. Point-in-time recovery needs a retest on an older object.

- **Platform behaviour:**
  - whether Durable Object rows share D1's daily pool, and which GraphQL dataset reports them;
  - point-in-time recovery on Free;
  - `alarm()` retries, including after a CPU overrun;
  - the dashboard data browser from an iPhone;
  - the write cost of the counter trigger;
  - the Plaid link token's lifetime (from Plaid's docs, or Sandbox if keys exist).

The results go in `docs/measurements.md`. If anything misses its gate, the work stops and the owner gets a report.

**1. Classes, adapter, migrations (no behaviour change)**

- Build the `Directory` and `BudgetStore` classes, the adapter, both migration runners and the expand-only check.
- _Verify:_ the integration suite and fence tests run against D1 and the adapter in CI; the deploy adds the classes and nothing else.

**2. Job runner**

- Sync, recompute, maintenance and daily scan become jobs, with recurring rows, attempts committed before each step, and the watchdog alarm.
- _Verify:_
  - the 3,000-transaction backfill through jobs gives the same rows as through the Workflow;
  - a step killed mid-run is retried, and its job is marked failed after 6 attempts;
  - lease and fence tests pass on jobs;
  - the measure suite on the adapter stays under 5 ms a step.

**3. Routing and Directory**

- Worker → Directory → store routing; Directory sign-in and security, scoped by user; webhook routing; the middleware split; usage through the Directory; the "moving" banner. All of this is used only after the switch.
- _Verify:_ the e2e suite against a test instance with `phase = 'moved'`.

**4. The move, `move_out`, and the full dump**

- Build the freeze triggers (migration 0010), `move_queue`, `move_in`, verification, the switch, `move_out`, the full dump, and the restore runbook.
- _Verify:_
  - CI runs both directions on the November fixture and on a 3,000-transaction budget, with edits between the moves, and every row survives;
  - a write during the freeze is refused by the database;
  - a forced mismatch stops the move with nothing changed;
  - a freeze past its lease aborts on its own;
  - a link finished during the freeze is saved;
  - a dump restored into fresh objects verifies.
- **Then, at a time the owner picks, move the owner's data.**

**5. Remove D1 and Workflows**

- Only when the owner says so, after a full dump and a passing restore dry run (8.8).
- Remove the D1 binding, the Workflow classes, the extra crons and the D1 serving paths. Delete the D1 database. Update the runbook.

**6. Accounts: later (owner, Nov 2, 2026).** The switch, invites and People with its reset link (7.3, 7.4). Not built now.

**7. Plaid slots, deletion, and the isolation test: later (owner, Nov 2, 2026)** (sections 9.1, 10 and 11). Only needed once there are other users.

**8. Capacity measurement:** cut for now (owner, Nov 2, 2026). The estimates in 9.3 are enough for a few people.

**9. Docs**

- D-37 in `decisions.md`, covering:
  - Durable Objects for everything; D1 and Workflows removed;
  - alarms instead of Workflows;
  - the new chunk sizes, which revise D-22;
  - identity by user id; invites only, with a reset link instead of recovery codes;
  - the no-loss rule and the full dump.
- Updates to `design.md`, `sync-spec.md`, `threat-model.md` (including the 30-second read window), `build-plan.md`, `runbooks/setup.md` and `CLAUDE.md`.

**Cleanup after the move (with phase 5).** The move is one-time code. Once the owner's data has moved, been checked, and the owner says D1 can go, these are deleted:

- the move and the way back: `store/move.ts`, `store/move-jobs.ts`, `store/frozen.ts`, `resetForMove`/`startMoveOut`/`afterMove`/`restoreDump`-style move methods on both objects, `POST`/`GET /api/move` and `/api/move/back`, the Storage card, and their tests;
- the frozen and restoring modes in `index.ts` and `router.ts` (`servingPhase`, the lease abort), and the "moving" write state and banner;
- every D1 serving path: the D1 `api` mount in `index.ts`, `identify`'s D1 use, `resolveMembership`, the D1 scheduled handler, the D1 binding and `packages/db/migrations` (kept in git history);
- Workflows: the SYNC, RECOMPUTE and MAINTENANCE classes and bindings and the job shims that stand in for them;
- the phase 0 tooling (`apps/worker/phase0`, `.github/workflows/phase0.yml`, `measure/store.measure.ts`).

What stays: the Directory, the budget stores, the adapter, the job runner, routing, sign-in, and the full backup (the way back once D1 is gone).

**Rough size:** phases 0–5 take five to eight weeks of sessions; phases 6–8 take one to two more.

## 13. Open questions

- **Limits after this plan** (not built, by design):
  - splitting sessions out of the Directory at very large scale (5.2);
  - automatic backups for many users (needs R2 and a payment card);
  - billing for Plaid Production fees;
  - email recovery (needs a domain);
  - support and monitoring for other people.

  Everything else scales with settings.

- **Answered by phase 0:**
  - CPU gates (pass, except the Activity screen and 150 KB move steps);
  - the GraphQL datasets (`durableObjectsInvocationsAdaptiveGroups` for CPU, `durableObjectsPeriodicGroups` for rows);
  - CPU overruns (no platform cutoff at 10 ms on Free).
- **Still open:**
  - point-in-time recovery on Free (retest on an older object);
  - whether the daily row limits pool with D1's;
  - the data browser on iPhone (owner);
  - the counter's write cost;
  - the link token's lifetime.
- Do Plaid Trial terms allow other people's banks at all? This needs an answer before sign-up is turned on.

## 14. History

- **v1** (one shared D1 database), reviewed twice. Findings carried forward:
  - Plaid slots reserved before Link opens;
  - per-user passkey handles;
  - a unique challenge id for replay protection;
  - the rate-limiting binding;
  - recovery codes for non-owners only;
  - fair share only in multi-user mode.
- **v2** (a store per budget plus a D1 directory), reviewed once. Findings carried forward:
  - in-process SQLite counts as CPU (phase 0, and smaller steps fix it);
  - the move must stop every writer and switch only if nothing changed;
  - the adapter needs a real `changes`;
  - errors cross objects as codes, not classes;
  - an honest list of changes;
  - no transaction spans two objects;
  - adding a class can't be rolled back past;
  - byte-sized copy steps.
- **v3** (everything in Durable Objects, D1 deleted), reviewed once, verdict "Revise". Fixed in v3.1:
  - the way back after D1 is gone is now the full dump, not a D1 copy that would drift from the new schemas;
  - the freeze is enforced by database triggers, and the switch is fenced on one change counter;
  - jobs commit their attempt count before running and keep recurring rows, so killed steps are retried and recurring work isn't lost;
  - copy steps are sized by measured CPU;
  - writes and recent-passkey routes skip the session cache;
  - no link tokens before a freeze, and the exchange is never frozen out;
  - restore is a runbook step with a dump first;
  - the JSON export is no longer called a backup;
  - the Activity screen has a p95 gate and a fallback;
  - the dashboard data browser is the Directory's recovery path;
  - nothing is dropped during the freeze;
  - the D-22 change is recorded;
  - the "moving" banner and retries;
  - the tooling list;
  - a longer estimate.
