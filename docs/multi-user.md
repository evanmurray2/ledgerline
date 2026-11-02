# Multi-user design: Durable Objects for everything

Status: v3, Nov 2, 2026. Replaces v1 (one shared D1 database) and v2 (a database per budget plus a D1 directory). Both were reviewed; their findings are kept in section 14.

What the owner asked for:

- Build everything other people need to use Ledgerline, but keep sign-up switched off.
- Give each budget its own database.
- Move all data into the new databases and delete the old D1 database.
- Plan accounts and sign-up in the same design.
- New users start with 0 bank links.

## 1. Goal

1. **Move all data out of D1 into Durable Objects**, each with its own SQLite database:
   - one `BudgetStore` per budget, holding everything about that budget;
   - one `Directory` object, holding users, passkeys, sessions, invites, Plaid slots and which budget each bank link belongs to.
2. **Delete the D1 database** only after the move is verified and the owner says so. No data is lost on any path: the way back copies everything, including changes made after the move, into a new D1 database (8.6).
3. **Build accounts, invites and sign-up for other users, switched off.** While the instance has one active user, the owner's app works as it does today, apart from the move itself. New public routes return 404, and fair-share limits run only in multi-user mode (more than one active user).

Non-goals: paying plans, email, a custom domain, native apps, off-site backups (D-29), and sharing one budget between two people.

## 2. What does not change

- **Money rules.** `packages/domain` and `computeBudget()` are untouched. Nothing here changes how money is counted.
- **The SQL schema and queries**, apart from the changes listed in 5.6. Durable Objects run SQLite, as D1 does.
- **The sync guarantees** in `docs/sync-spec.md`: the cursor never moves backwards, retries add nothing, summaries equal a full recompute, and background work can't exceed the daily write limit. Leases, fences and the watermark keep their meaning (6.3).
- **The 10 ms CPU rule.** Every request and every alarm invocation stays within it, measured (section 12, phase 0).

## 3. Why this shape

- **One database per budget**: each person's data is physically separate, each budget gets its own size limit (1 GB on Free, 10 GB on Paid) and its own writer, and deleting an account deletes one database.
- **Directory as a Durable Object, not D1**: the owner wants D1 gone. It's small: a few rows per user.
- **Durable Objects, not one D1 per user**: the app can only reach D1 databases listed in its deployed config, so a D1 per user would need a deploy for every new account. A Durable Object is created on first use.
- **Alarms, not Workflows**: in-process SQLite counts as CPU, so background work has to run in small steps (phase 0: 2 months of recompute, 25 events of apply or processing per step, about 2–4 ms each). Small steps as Workflow steps would use up the 3,000 a day allowed on Free. A Durable Object can schedule its own next step (an alarm), which counts as one request (100,000 a day on Free) and one row written.

## 4. Cloudflare services at the end

| Service                      | Used for                                                                                                                | Free-plan limits that matter                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Workers**                  | Static web app, API entry, sign-in checks, routing each request to the right object                                     | 100,000 requests a day; 10 ms CPU                                                                                               |
| **Durable Objects (SQLite)** | `Directory` (one) and `BudgetStore` (one per budget), each with its own SQLite database; alarms run all background work | 1 GB per object, 5 GB per account; 5M rows read, 100k rows written a day; 100,000 requests a day; 13,000 GB-s of duration a day |
| **Cron Triggers**            | One daily trigger: account usage refresh and a check that every budget's alarms are scheduled                           | 1 of 5                                                                                                                          |
| **Rate Limiting binding**    | Sign-in, sign-up and recovery attempts                                                                                  |                                                                                                                                 |
| **GraphQL Analytics API**    | Account-wide Durable Object usage, for the write breaker                                                                |                                                                                                                                 |

Removed: **D1** (deleted after the move) and **Workflows** (replaced by alarms). Not used: R2, KV, Queues, Zero Trust, Email. Nothing here needs a payment card.

## 5. Architecture

### 5.1 Request path

1. The Worker serves static files directly.
2. For `/api/*`, the Worker:
   - calls `Directory.authenticate(tokenHash, path, method)`, which returns `{ userId, budgetId, verifiedAt }` or a refusal;
   - checks CSRF, rate limits and the recent-passkey rule (`needsRecentPasskey`);
   - forwards the request to `BudgetStore(budgetId).api(request, { userId, verifiedAt })` over RPC.
3. Sign-in, security, invites, People and the Plaid webhook are handled by the `Directory`, through the Worker.
4. The Worker never takes a budget id from the request. The store is chosen only from the session's membership.

Each API request costs one Worker request and two Durable Object requests (Directory, then BudgetStore). The Directory's answer for a session is cached in the Worker isolate for 30 seconds. A revoked session is refused by the store too, because the store re-checks the session version (7.1) on writes.

### 5.2 Directory (one object)

Tables (from today's schema, minus `budget_id` scoping where it doesn't apply):

- `user`, with the new columns in 7.1;
- `budget` (`id`, `name`, `created_at`; the budget's money fields live in its store);
- `budget_member`, `passkey`, `auth_session`, `device_link`, `invite`, `recovery_code`, `plaid_link_slot`;
- `connection_route` (Plaid item id as primary key → budget id, connection id);
- `usage_day` (account usage) and `budget_usage_day`;
- `app_state` (cron cursor, alarm health).

RPC methods: `authenticate`, `beginCeremony` / `finishCeremony` (sign-in, setup, invite, recovery, device link), `security*` (passkeys, sessions, device links), `invite*`, `people*`, `reserveSlot` / `useSlot` / `releaseSlot`, `routeFor(itemId)`, `registerRoute`, `noteUsage`, `usageToday`.

At a few thousand users, one object answering every request becomes a bottleneck: the soft limit is about 1,000 requests a second per object. The 30-second cache keeps it far below that for this app. Splitting sessions by token hash is the way out later, and isn't built now.

### 5.3 BudgetStore (one per budget)

- **Data**: every other table in today's schema (connections and encrypted Plaid tokens, raw and staged pages, bank events and transactions, accounts, categories, assignments, targets, rules, payees, overlays, splits, links, budget lines, snapshots, totals, alerts, audit log, settings, health, usage events). Plus the budget's own fields from today's `budget` row (`processed_through`, `summary_*`, `rta`, `data_version`, time zone, start month), now in a one-row `budget` table.
- **API**: the budget's Hono routes (budget, activity, accounts, owed, reports, settings except security, ops export and import, usage). They run inside the store with `env.DB` set to the adapter (5.5).
- **Background work**: a `job` table and the alarm runner (6.1).
- **RPC**: `api`, `startSync(connectionId, trigger)`, `ensureAlarms`, `health`, `exportAll`, `importChunk`, `verifyChunk`, `wipe(token)`.
- **Id**: `idFromName(budgetId)`.

### 5.4 Who calls whom

- Worker → Directory: authentication, everything in 5.2.
- Worker → BudgetStore: API requests, the webhook (after `routeFor`), the daily cron (`ensureAlarms`).
- BudgetStore → Directory: `noteUsage` (batched; 9.2), `usageToday` (for the breaker; cached a minute), `useSlot` and `registerRoute` (6.4).
- Directory → BudgetStore: creating a new budget's store at sign-up, and `wipe` at deletion.
- **No call ever changes both objects in one transaction**, because there is no such transaction. Every cross-object change is written as an idempotent step with a retry (6.4).

### 5.5 The D1-shaped adapter

The app calls D1 about 400 times. Inside a store or the Directory, `env.DB` is an adapter with D1's interface over `ctx.storage.sql`, so most query code keeps working:

- `prepare(sql).bind(...)`: bound values are coerced the way D1 does it (booleans to 0 and 1; `undefined` throws). `ArrayBuffer` and `Uint8Array` are passed as blobs.
- `first / all / run`: run `sql.exec`. The result's `meta` holds:
  - `changes` from `SELECT changes()` and `last_row_id` from `SELECT last_insert_rowid()`, run right after the statement. The cursor's `rowsWritten` also counts index writes, so it can't stand in for `changes`; the sync leases depend on `changes === 1`.
  - `rows_read` and `rows_written` from the cursor.
- `batch(stmts)`: runs inside `ctx.storage.transactionSync(...)`. A statement that throws rolls back the whole batch, as in D1. The fence pattern (`lease_guard`'s `CHECK (ok = 1)` aborting the batch) works unchanged.
- **Errors**: `isFenceAbort()` and any other matched error text accept both D1's wording and the Durable Object's. A test makes each fence fail on both backends.
- **No `await` inside a batch**: batches are fully built before they run, which is already how the code works.
- **Limits** are kept the same as D1's: 100 bound parameters, 2 MB per value, 100 KB per statement.

The existing fence tests, the integration suite and the measure suite run against both D1 and the adapter until D1 is removed (phase 5). After that they run against the adapter only.

### 5.6 What actually changes in the code

An honest count. `env.DB` is used in 17 source files, and these are the parts that need real changes rather than just the adapter:

| Area                                                                     | Change                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http/auth.ts`, `routes/auth.ts`, `routes/security.ts` (29 sites)        | Move into the `Directory`; queries filter by `user_id` (7.1).                                                                                                                                             |
| `routes/api.ts` middleware                                               | Split: identity, membership, CSRF, rate limit and reauth stay in the Worker. ETags, `bumpOnChange` and the read-only breaker run in the store.                                                            |
| `sync/workflow.ts`, `budget/workflow.ts`, `maintenance.ts`, `cron.ts`    | Replaced by the job runner (6.1). The step functions (`beginRun`, `fetchPage`, `applyPage`, `processPending`, `finalizeConnection`, `recompute`, maintenance steps, `dailyScan`) are reused as job steps. |
| `maintenance.ts` watchdog                                                | The batch that prunes `auth_*` and touches `health_status` and `liability_snapshot` is split: the auth prune runs in the Directory, the rest in the store.                                                |
| `sync/breaker.ts`, `ops/usage.ts`                                        | Read account usage from `Directory.usageToday()`, not `env.DB`. `noteUsage` goes to the Directory.                                                                                                        |
| `routes/ops.ts` `/usage`                                                 | Its batch mixes `usage_event` (store) and `usage_day` (directory): store write first, Directory note after.                                                                                               |
| `routes/ops.ts` webhook, `routes/settings.ts` `startSync`, link exchange | Webhook: Worker → `Directory.routeFor` → `BudgetStore.startSync`. Link exchange: 6.4.                                                                                                                     |
| `routes/api.ts` ops token health                                         | Worker asks the Directory for account numbers and the owner's store for its health.                                                                                                                       |
| `apply_counter`, `lease_guard`                                           | Become per-store tables. `bank_event.id` is unique within the store.                                                                                                                                      |
| `measure/*`                                                              | Measure routes run inside a store in dev only.                                                                                                                                                            |
| Tests                                                                    | Seeding through `env.DB` (26 sites) gets store fixtures; `vitest-pool-workers` runs the objects.                                                                                                          |

A lint test fails on `.prepare(` or `.batch(` outside the files allowed to use storage directly. Each allowed file says which object it runs in.

### 5.7 Schema and migrations per object

- `packages/db/budget-migrations/` and `packages/db/directory-migrations/`, each starting with a baseline equal to today's schema after 0009, split between the two. The `budget_id` columns stay in budget tables for now, always equal to the store's id. Removing them would touch every query, so that's a later clean-up.
- Each object runs pending migrations when it starts, inside `blockConcurrencyWhile`, one migration per `transactionSync`, recorded in `_migrations`. Running them twice does nothing.
- **Expand-only**: a migration may add tables, columns and indexes, never drop or rename anything still read by the previous release. After a deploy, objects may run old code for a while. Cloudflare updates a Durable Object's code when it next restarts, and a rollback restores old code but not old schemas. Removals take two releases: stop reading, then drop. `tools/ci/migration-check.mjs` checks both directories and refuses drops of columns that the previous release's code still mentions.
- **A failing migration** leaves the object refusing requests with a clear error rather than serving a half-migrated schema. The deploy smoke test calls `health()` on the Directory and the owner's store, which runs their migrations, so a bad migration fails the deploy before anyone else is affected. With other users, `ensureAlarms` from the daily cron migrates the rest.

### 5.8 Deploys and rollback

- Adding a Durable Object class is a change Cloudflare's rollback can't step back over. So the classes ship in a **deploy of their own that changes no behaviour** (phase 1). After that, normal deploys roll back as today.
- `deploy.yml` stops applying D1 migrations once D1 is gone (phase 5). Its smoke test calls `health()` (5.7).
- The throwaway Worker in phase 0 is a separate Worker in the same account, so the live app's Worker never gains or loses a class for the experiment. The owner approved this.

## 6. Background work on alarms

### 6.1 The job runner

Each store has a `job` table: `id`, `kind`, `connection_id`, `state` (JSON), `run_at`, `attempts`, `last_error`, `created_at`.

The alarm handler:

1. picks the earliest due job;
2. runs **one step** of it;
3. saves its new state (or deletes it when finished);
4. sets the next alarm for the earliest `run_at`.

Each step is sized for about 2–4 ms of CPU. One step per alarm keeps every invocation inside 10 ms and lets user requests in between.

Errors:

- A step that throws increments `attempts` and sets `run_at` with backoff (10 s, 30 s, 2 min, 10 min, 1 h).
- After 6 attempts the job is marked failed and an alert is written. Sync jobs release their lease the way `releaseFailed` does today.
- Errors are recorded as codes, never matched by class across objects.

| Job kind                 | Steps (sizes from phase 0)                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync`                   | begin → fetch one page per step (100 transactions) → apply 25 events per step → process 25 events per step → finalize → release or hand off. Same phases, same tables and same fences as today's Workflow. |
| `recompute`              | 2 months per step until caught up (today: 6 per Workflow step).                                                                                                                                            |
| `maintenance`            | drift check, full recompute (2 months per step), rule 10 identity, usage roll-up, watchdog, staging prune, version bump: today's steps, smaller.                                                           |
| `daily_scan`             | today's `dailyScan`, in steps of 40 Upcoming entries.                                                                                                                                                      |
| `move_in`, `move_verify` | the move (8.3, 8.4).                                                                                                                                                                                       |
| `register_link`          | finishes a new link in the Directory (6.4).                                                                                                                                                                |

### 6.2 Schedules without cron fan-out

Each store keeps its own recurring jobs: the sync backstop every 4 hours, the daily scan at 08:10 UTC, and maintenance at 10:20 UTC. Each finished run schedules the next one. The times are the same as today's crons. Nothing has to loop over every budget.

The one remaining cron trigger runs daily. It refreshes account usage from GraphQL Analytics and calls `ensureAlarms` on up to 50 budgets per run from a cursor, as a safety net for an object whose alarm was lost. With one budget that's one call.

### 6.3 Leases and fences inside one object

- A store runs one alarm at a time, and Cloudflare also stops requests from interleaving with storage writes. But while a step waits on Plaid (`fetch`), other requests and the next alarm can run.
- So the connection lease stays exactly as it is (`sync/lease.ts`, `lease_guard` fences): a step that lost its lease can't apply a page. The 90-minute lease TTL stays.
- Hand-off to a new run when a sync is requested mid-run stays. The new run is a new `sync` job instead of a new Workflow instance.
- The write breaker's "pause until 00:00 UTC" becomes `run_at` = next UTC midnight, with the lease extended as today.

### 6.4 Changes that touch both objects

There is no shared transaction, so each of these is a series of idempotent steps:

**New bank link**

1. `Directory.reserveSlot(userId)` writes a `reserved` slot with a 30-minute expiry, fenced on the cap and the user's allowance (9.1).
2. The user finishes Plaid Link.
3. The store's exchange saves the connection and token, as today, and queues `register_link`.
4. `register_link` calls `Directory.registerRoute(itemId, budgetId, connectionId)` and `useSlot(slotId)`. Both are idempotent, and the job retries until they succeed.

If the item id is already routed to another budget, the Directory refuses. The store then marks the connection `duplicate_item` and an alert says so. This replaces today's global unique index on `(provider, provider_item_id)`.

**Webhook**

- The Worker verifies the signature, calls `Directory.routeFor(itemId)`, then `BudgetStore.startSync`.
- An unknown item is logged and answered 200, because Plaid retries otherwise. The daily `ensureAlarms` also checks each store's items against `connection_route` and re-registers missing ones.

**Sign-up**

1. One Directory transaction creates the user, budget, membership, passkey, session, recovery code and marks the invite used (7.3).
2. The Worker then calls the new store's `health()`, which creates it and runs its migrations.
3. The store is seeded on first request, so a crash between the two steps leaves an empty budget that works.

**Deletion**: section 10.

## 7. Accounts and sign-in

Carried over from v1 after its review, adapted to the Directory.

### 7.1 Identity

- `user` gets these columns:
  - `display_name`
  - `is_admin`
  - `status` (`active`, `disabled`, `deleting`)
  - `last_seen_at`
  - `link_allowance` (default **0**, decided by the owner)
  - `webauthn_handle`
  - `session_version`
- `passkey`, `auth_session` and `device_link` get `user_id`.
- The move (section 8) writes the owner as admin, with link allowance 10 and handle `ledgerline-owner`, on their existing passkeys.
- `identify()` gets the user id from the session. `OWNER_EMAIL` goes away and email is no longer identity; new users get `u:<id>`.
- Disabling a user bumps `session_version`, deletes their sessions and pauses their banks' sync jobs.

### 7.2 Passkeys, challenges, rate limits

- New users get a random WebAuthn user handle and their name as `userName`. `excludeCredentials` lists only that user's passkeys. Sign-in checks that the assertion's `userHandle` matches the passkey's user. This stops a new account's passkey replacing the owner's on a shared device.
- Starting a ceremony writes nothing: the challenge goes in a 5-minute HMAC-signed cookie (HKDF key from `TOKEN_KEYS`, label `ledgerline-challenge`).
- A successful finish stores `challenge_id` on the new session under a unique index, so replaying the same cookie and assertion fails. This doesn't rely on the signature counter, which iCloud passkeys always report as 0.
- The rate-limiting binding (about 20 a minute per IP) covers every sign-in, sign-up and recovery route.

### 7.3 The switch, invites, recovery

- `SIGNUPS` (`off` / `invite` / `open`, default `off`) and `MAX_USERS` (default 1) are Worker variables, so turning on takes a deploy. While `off`, the invite, sign-up and recovery routes return 404 and the web app hides them.
- **Invite**: an admin makes a link in Settings → People. The token is in the URL fragment, single use, valid 7 days, and only its hash is stored. One Directory transaction creates everything (6.4), checked against the invite, the switch and `MAX_USERS` (counting active, disabled and deleting users). The new user lands in first-run setup with the invite's link allowance (default 0).
- **Open sign-up**: the same flow without an invite, only when `SIGNUPS = open`.
- **Recovery codes** are for non-owner users. A code is shown once and stored as a unique hash. Using it deletes all that user's passkeys and sessions and issues a new code. The owner keeps D-27's recovery: a device link from a signed-in device. (Wrangler access to D1 goes away with D1; the runbook gets a Directory recovery step instead.)

### 7.4 Settings → People and diagnostics (admins)

- **People** is shown once `SIGNUPS` isn't `off`. It covers:
  - invites, and users (name, joined, last seen, links used of allowance, today's usage);
  - disable and enable, link allowances, delete;
  - shared counters: Plaid links of the cap, users of `MAX_USERS`, today's usage, total storage.
- **Diagnostics** (always shown to the admin, own budget only): row counts per table, job queue state (pending, failed, next alarm), a fixed list of named health queries, and restore to a point in time (8.6). There's no free-form SQL endpoint. This replaces the D1 console, which goes away.

## 8. Moving all data and deleting D1

The owner's D1 database is 4.2 MB: 718 transactions, 7 banks, 20 raw pages (Nov 2, 2026). The move runs once, at a time the owner picks, and should take a few minutes.

**Hard rule from the owner: no data is lost on any path.** That covers the move, a failed move, going back afterwards, and deleting D1. Every row the owner has, including edits made after the move, must survive. A step that can't guarantee this doesn't run.

### 8.1 Before the move

Phases 1–4 ship with D1 still serving everything. The Directory and the owner's store exist but are empty.

A flag in a new D1 table, `move_state(phase, started_at, markers)`, controls the move. While its phase is `none`, nothing changes.

### 8.2 Freezing every writer

Setting `move_state.phase = 'frozen'` stops every path that writes to D1:

| Writer                                                    | While frozen                                                                                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| API writes                                                | 503 "Moving your budget, a few minutes"                                                                                          |
| Screen reads that recompute (`fresh()`)                   | Skip the recompute and serve the stored summaries                                                                                |
| Sign-in (session and passkey counter writes)              | Refused with the same 503 message; existing sessions keep working for reads                                                      |
| Sync Workflows                                            | The move refuses to start while any lease is held or any Workflow instance is running, and new syncs aren't started while frozen |
| Recompute, maintenance and daily-scan Workflows and crons | Not started while frozen; the move waits for running ones to finish                                                              |
| Plaid webhooks                                            | Answered 200 and recorded in `move_state` as "sync requested" for that item                                                      |
| `/api/usage` telemetry                                    | Dropped                                                                                                                          |

The freeze is set and checked in one D1 batch. Every writer checks `move_state` in the same batch as its write (a `lease_guard`-style fence), so nothing that checked before the freeze can write after it.

### 8.3 Copy

A `move_in` job runs in the new objects and reads D1 through the D1 binding, which is still configured until phase 5.

- **Directory rows** come from `user`, `budget_member`, `passkey`, `auth_session`, `device_link`, plus the new columns from 7.1. A `connection_route` row is added for each of the 7 Plaid items. The Plaid slot count starts at 7 used (`PLAID_LINKS_USED_BEFORE`).
- **Store rows** are copied table by table in foreign-key order (parents first). Chunks are sized by bytes, at most 1 MB per step (`raw_page` rows are up to 200 KB), and at least one row per step.
- **Tables without `budget_id` get special handling:**
  - `apply_counter`: the store's counter becomes D1's current value.
  - `lease_guard`: created fresh.
  - Leases: set to NULL in the copy.
- A running hash per table is updated as each chunk is written: SHA-256 over a canonical encoding, with typed values (integers, reals, text, blobs, NULL) and rows ordered by primary key. It's split across steps, because hashing 4.2 MB takes about 27 ms of CPU.

### 8.4 Verify

`move_verify` steps check that:

- row counts per table match D1's;
- each table's hash matches the same canonical hash computed from D1, in steps;
- a full recompute in the store (2 months per step) gives the same month snapshots and Ready to Assign as the stored ones;
- the rule 10 identity holds.

Any difference stops the move. The freeze is lifted, D1 keeps serving, the new objects are wiped, and the report goes to the owner.

### 8.5 Switch

One D1 batch sets `move_state.phase = 'moved'`, fenced on the markers recorded when the freeze started. The markers are:

- `data_version`, `summary_version`, `processed_through`;
- `apply_counter.seq`;
- every connection's `plaid_cursor` and lease;
- row count and `max(updated_at)` for every table.

If any of them changed, the switch aborts, which means something wrote despite the freeze.

From then on:

- the Worker sends every request to the Directory and stores;
- `move_state = 'moved'` makes the D1 path refuse everything;
- the store queues a sync for every connection, which also covers webhooks recorded during the freeze.

### 8.6 Deleting D1, and the way back

- **The way back copies everything, including changes since the move.** A `move_out` job uses the same copy and verify code in reverse:
  1. Freeze the objects' writers.
  2. Copy the Directory and the store into a **new, empty** D1 database made from the same migrations. This only adds rows, so the append-only triggers (which block updates and deletes) don't get in the way. `apply_counter` is set to the store's value.
  3. Check row counts, canonical hashes and a full recompute.
  4. Switch the Worker back to D1 in one fenced step.

  Nothing the owner did after the move is lost. `move_out` is built and tested in phase 4, both ways on the November fixture and the 3,000-transaction budget, before the owner's real move.

- **Deleting the old D1 database** happens only after the owner has used the app on the new databases for a while and says so. Then:
  - the owner downloads a JSON export, kept by the owner as an extra copy;
  - a `move_out` dry run into a scratch D1 database passes verification and is then deleted, proving the way back still works;
  - a deploy removes the D1 binding (phase 5), and the old `ledgerline` D1 database is deleted.
- **After deletion**, the way back is still `move_out` into a new D1 database, because the data lives in the objects. Cloudflare's 7-day undelete of the old database is an extra safety net, not the plan.
- **Point-in-time recovery**: each object can be restored to any moment in the last 30 days, if phase 0 confirms this on Free. The JSON export works at any time. D-29 (no off-site backup) is unchanged.

## 9. Sharing the free plan

### 9.1 Plaid links (always on)

- `PLAID_LINK_CAP` is 10; set it to 0 for no cap on Plaid Production. `PLAID_LINKS_USED_BEFORE` is 7, as confirmed by the owner.
- A slot is reserved in the Directory **before** Plaid Link opens (6.4), in one transaction checked against the cap and the user's `link_allowance` (default 0).
- Exchange always saves the Item, because once Link finishes the slot is spent. Cancelling releases the slot. Repair never reserves one.
- On Plaid Production, `link_allowance` stays as the per-user limit on paid Items.

### 9.2 Daily limits

- Each object knows its own rows read and written from the cursor. It keeps a running count in its own SQLite (not in memory, which is lost on eviction) and sends it to `Directory.noteUsage` at most once a minute, from the next alarm or request.
- The account-wide breaker (70% pause, 90% read-only) uses GraphQL Analytics for Durable Object rows plus the Directory's recent counts. D1 no longer counts after the move. Phase 0 confirms the GraphQL dataset exists.
- **Multi-user mode only:**
  - per-user shares of 20,000 rows written and 1,000,000 read a day, with admins exempt;
  - new-bank backfills admitted against today's writes, Durable Object requests and duration;
  - quiet budgets (no sign-in for 14 days) get a weekly full recompute instead of daily.

### 9.3 Capacity on Free (estimates; phase 0 and phase 8 measure)

| Limit                             | Per active user per day                                              | Users it allows                               |
| --------------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| Plaid Trial links                 | 1 to 7, once                                                         | 3 left in total: 1 to 3 more people           |
| Durable Object requests (100,000) | ~2 per API call, ~20–60 alarm steps; a new bank's backfill ~300 once | dozens                                        |
| Rows written (100,000)            | a few thousand; ~20,000 the day a bank is added                      | about 10 to 15                                |
| Duration (13,000 GB-s)            | a few hundred GB-s (Plaid waits count)                               | dozens                                        |
| Storage                           | ~9 MB a year                                                         | 1 GB each; 5 GB total: hundreds of user-years |

Workflow steps stop being a limit. On Free, the real limits are Plaid Trial and daily writes.

## 10. Deleting an account

A `delete_account` sequence, driven by the Directory:

1. The user (Settings → Security → Delete account, with a fresh passkey check and typing the budget name) or an admin starts it. `status = 'deleting'` and sessions are deleted.
2. The store removes each Plaid Item (`/item/remove`; the Trial slot doesn't come back, and the screen says so), then wipes itself with `ctx.storage.deleteAll()`.
3. The Directory deletes the user's rows. `plaid_link_slot` rows stay, so the Trial count stays right.

`wipe`, `exportAll` and `importChunk` refuse unless the Directory holds a matching delete or move record for that budget, so a wrong budget id can't erase a database. The last admin can't be deleted from the app. The screen offers the JSON export first.

## 11. Keeping users apart

- The store is chosen only from the session's membership (5.1). A test signs in as user A and tries to reach B's data through every route: putting B's budget id, connection id, Plaid item id and transaction keys in the path and the body.
- Directory queries filter by `user_id`: passkeys (including "keep at least one"), sessions ("sign out everywhere"), device links.
- `wipe`, `exportAll` and `importChunk` are guarded (section 10).
- Webhooks route only through `connection_route`.

## 12. Build phases

Each phase lands on `main` with `pnpm check` passing. Until phase 4's switch, which happens only when the owner says so, the owner's app runs on D1 as today.

0. **Measure on Cloudflare** (throwaway Worker in the owner's account, approved; deployed by a manual GitHub workflow using the existing `CLOUDFLARE_API_TOKEN`, then deleted). Check:
   - CPU from Workers Logs for a store running the real apply (25 events), processing (25), recompute (2 months), Budget and Activity screens on the 3,000-transaction data;
   - whether Durable Object rows share D1's daily pool, and which GraphQL dataset reports them;
   - point-in-time recovery on Free;
   - alarm retry behaviour;
   - that Plaid Sandbox accepts an older cursor (needs Sandbox keys; otherwise Plaid's docs).

   Record the results in `docs/measurements.md`. If a path doesn't fit, stop and report.

1. **Classes, adapter, migrations** (no behaviour change): `Directory`, `BudgetStore`, the adapter, both migration runners and baselines, the expand-only check. _Verify:_ the integration suite and fence tests run against D1 and the adapter in CI; the deploy adds the classes and nothing else.
2. **Job runner**: sync, recompute, maintenance and daily scan as jobs, with today's step functions at the new chunk sizes. _Verify:_ the 3,000-transaction backfill through the job runner in `vitest-pool-workers` gives the same rows as through the Workflow; lease and fence tests on jobs; the measure suite on the adapter stays under 5 ms per step.
3. **Routing and Directory**: Worker → Directory → store routing; Directory routes for sign-in and security, scoped by user (7.1, 7.2); the webhook through `connection_route`; the middleware split; usage through the Directory. All of this runs only after the switch: before it, everything still goes to D1. _Verify:_ e2e suite against a test instance with `move_state = 'moved'` and seeded objects.
4. **The move and the way back** (section 8): freeze fences, `move_in`, `move_verify`, the switch, and `move_out` into a new D1 database. Dry runs both ways on a copy of the November fixture and on a 3,000-transaction budget, with edits made between the two moves. _Verify:_ every row and every edit survives both directions (row counts, hashes, full recompute); a forced mismatch stops the move with nothing changed; a write during the freeze is refused; the switch aborts if a marker changed. **Then, at a time the owner picks, move the owner's data.**
5. **Remove D1 and Workflows** once the owner is happy with the new databases and says so: the JSON export and a passing `move_out` dry run come first (8.6). Then drop the D1 binding, the Workflow classes, the crons and the D1 serving paths, and delete the D1 database. `move_out` and its tests stay in the code. Using it later needs a deploy that binds a new, empty D1 database (runbook step). Update the runbook.
6. **Accounts**: the switch, invites, recovery codes, People and diagnostics (7.3, 7.4). _Verify:_ with `SIGNUPS = off` every new route returns 404; e2e for invite sign-up, reused invite, `MAX_USERS`, recovery.
7. **Plaid slots, fair share, deletion** (9, 10), and the isolation test (11).
8. **Capacity**: seed 10 users with the November fixture, simulate a day, update 9.3.
9. **Docs**:
   - a decision entry (D-37: Durable Objects for everything, D1 and Workflows removed, alarms, identity, recovery codes);
   - updates to `design.md` (Platform and Users rows), `sync-spec.md` (jobs instead of Workflows, chunk sizes, where fences live), `threat-model.md`, `build-plan.md`, `runbooks/setup.md` and `CLAUDE.md` (the production section lists D1 ids).

Rough size: phases 0–5 three to five weeks of sessions, phases 6–8 one to two.

## 13. Open questions

- Phase 0 answers: CPU on Cloudflare, shared row pools, the GraphQL dataset, point-in-time recovery on Free, alarm retries, and Plaid's older cursors.
- The Activity screen measured 4–5 ms with in-process SQLite (phase 0, local). It needs tuning if Cloudflare's numbers are higher.
- Do Plaid Trial terms allow other people's banks at all? (Before turning on.)

## 14. History

- **v1** (one shared D1 database): reviewed twice. Findings kept here:
  - Plaid slots reserved before Link opens;
  - per-user WebAuthn handles;
  - replay protection from a unique challenge id;
  - the rate-limiting binding;
  - recovery codes only for non-owners;
  - fair-share limits only in multi-user mode;
  - the Workflow step limit measured.
- **v2** (a store per budget plus a D1 directory): reviewed once, verdict "Rethink". Findings kept here:
  - in-process SQLite counts as CPU (phase 0 measured it; smaller chunks on alarms fix it);
  - the move must stop every writer, including screen reads, background jobs and webhooks, and must switch only if nothing changed;
  - the adapter needs a real `changes`;
  - error classes don't cross objects;
  - an honest list of code changes;
  - no batch spans two databases;
  - deploys that add a Durable Object class can't be rolled back past;
  - copying needs byte-sized chunks and the budget-less tables;
  - the reverse move is a full copy into a new, empty D1 database, so nothing made after the move is lost (owner's rule: no data lost on any path).

  The v2 review also argued the move only pays off on the paid plan. The owner chose to go ahead knowing that.

- **v3** (this one), Nov 2, 2026. The owner asked for all data in Durable Objects, D1 deleted, and accounts in the same plan.
