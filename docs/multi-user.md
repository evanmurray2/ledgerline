# Multi-user design: one database per budget

> **Phase 0 result (Nov 2, 2026): no-go on the Free plan.** With SQLite running in-process, the sync steps, budget edits and recompute steps measure about 5–7 ms, with peaks past 10 ms (`docs/measurements.md`, first section). This design waits until the app moves to Workers Paid (30 s of CPU per invocation). An independent review of this draft also found problems to fix before it's built: the move must be write-safe (screen reads, background jobs and webhooks also write); the adapter needs a real `changes` count for leases; error classes don't cross RPC; about 80 call sites need changes, not none; batches must not span the directory and a store; and deploys that add a Durable Object class can't be rolled back past.

Status: v2, Nov 2, 2026. Replaces v1 (one shared D1 database; reviewed, see section 13). The owner asked for everything other people need to be built but switched off, then chose a database per budget so the app can grow past one database's limits.

## 1. Goal

1. Move each budget's data out of the shared D1 database into its **own SQLite database**, held by a Cloudflare Durable Object (one object per budget).
2. Build accounts, invites, sign-up and the rest for other users, **switched off**.

"Off" means that while the instance has one active user, the owner's app behaves as it does today: same screens, same sync timing, same sign-in. New public routes return 404. Fair-share limits are active only in **multi-user mode** (more than one active user).

The owner's data moves in step 1. That move is the riskiest part of this plan and has its own safety steps (section 7).

Non-goals: paying plans, email, a custom domain, native apps, off-site backups (D-29), sharing one budget between two people.

## 2. Why a database per budget

|                          | Shared D1 (v1)                                                        | Database per budget (v2)                                                                      |
| ------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Size limit               | 500 MB (Free) / 10 GB (Paid) for everyone together                    | 1 GB (Free) / 10 GB (Paid) **each**                                                           |
| Writes                   | One database, one writer, for everyone                                | Each budget writes on its own                                                                 |
| Keeping users apart      | `budget_id` on every row and every query; tests try to catch mistakes | A budget's code can only open its own database                                                |
| Deleting an account      | Thousands of deletes, blocked by append-only triggers                 | Delete the object's storage                                                                   |
| Query speed              | A network round trip per query                                        | SQLite in the same process as the code                                                        |
| Inspecting data          | Cloudflare dashboard console and MCP queries                          | Only through the app (8.4)                                                                    |
| Daily row limits on Free | Shared by everyone                                                    | Listed separately from D1's; whether each account gets a separate pool is measured in phase 0 |

## 3. What does not change

- **Money rules.** `packages/domain` and `computeBudget()` are untouched. Nothing here changes how money is counted.
- **The SQL.** Durable Objects run SQLite, as D1 does. The schema and queries move as they are (5.2).
- **The sync guarantees** in `docs/sync-spec.md`. Leases, fences and the watermark keep working inside the budget's database (5.4).
- **The 10 ms CPU rule.** Durable Objects have the same per-invocation CPU limit as Workers on the Free plan.

## 4. Architecture

### 4.1 Cloudflare services at the end

| Service                              | Used for                                                                                                                                  | Free-plan limit that matters                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Workers**                          | The API and the web app's static files; sign-in; routes each request to the right budget                                                  | 100,000 requests a day, 10 ms CPU each                                                          |
| **Durable Objects (SQLite)** _(new)_ | `BudgetStore`: one per budget, holding all of that budget's data                                                                          | 1 GB per object, 5 GB for the account; 5M rows read, 100k written a day; 100,000 requests a day |
| **D1**                               | The **directory**: users, passkeys, sessions, invites, recovery codes, Plaid slots, which budget each bank link belongs to, account usage | 500 MB; same daily row limits                                                                   |
| **Workflows**                        | Bank sync, recompute, daily maintenance, account deletion                                                                                 | 3,000 steps a day                                                                               |
| **Cron Triggers**                    | Sync backstop, daily scan, daily maintenance (3 of 5)                                                                                     |                                                                                                 |
| **Rate Limiting binding** _(new)_    | Sign-in and sign-up attempts                                                                                                              |                                                                                                 |
| **GraphQL Analytics API**            | Account-wide usage for the breaker                                                                                                        |                                                                                                 |

Nothing on this list needs a payment card. Not used: R2, KV, Queues, Zero Trust, Email.

### 4.2 Request path

1. The Worker checks the session against the directory (D1), finds the user's budget in `budget_member`, and gets that budget's `BudgetStore`.
2. It forwards the request with the verified user id. The budget's API routes run **inside** the `BudgetStore`, with the same Hono routes as today.
3. Sign-in, security, invites, People, health and the Plaid webhook stay in the Worker and use the directory.

The `BudgetStore` accepts only requests from the Worker. The verified user id is passed as a call argument, not a header a browser could set.

### 4.3 Which data goes where

- **Directory (D1)**: `user`, `budget` (id, name, `store_version`), `budget_member`, `passkey`, `auth_session`, `device_link`, `invite`, `recovery_code`, `plaid_link_slot`, `connection_route` (Plaid item id → budget id, for webhooks), `usage_day`, `budget_usage_day`, `app_state` (cron cursors).
- **BudgetStore (one per budget)**: everything else (connections and their encrypted tokens, bank pages and events, transactions, accounts, categories, assignments, targets, rules, payees, overlays, budget lines, snapshots and totals, alerts, audit log, settings, usage events), plus the budget's own row fields (`processed_through`, `rta`, summary fields).
- Global counters disappear: `apply_counter` and `lease_guard` become per-store tables, and `bank_event.id` only needs to be unique within its own budget.

## 5. The BudgetStore

### 5.1 Shape

```ts
export class BudgetStore extends DurableObject<Env> {
  // Runs pending schema migrations once, before any request (blockConcurrencyWhile).
  // fetch(): the budget's Hono API, given { userId, request } by the Worker.
  // RPC methods for Workflows and cron: syncFetch, syncApply, processPending, recompute,
  //   dailyScan, maintenanceStep, exportAll, importAll, verify, wipe.
}
```

The object id is `idFromName(budgetId)`.

### 5.2 A D1-shaped adapter

The code calls D1 about 400 times in 27 files (`prepare/bind/first/all/run/batch`, plus `Scoped`). Instead of rewriting every call, the store exposes a small adapter with the same interface over `ctx.storage.sql`:

- `prepare(sql).bind(...).first/all/run` → `sql.exec(...)`, returning `{ results, meta: { rows_read, rows_written, changes, last_row_id } }` from the cursor's `rowsRead` and `rowsWritten`.
- `batch(stmts)` → `ctx.storage.transactionSync(() => …)`. A statement that throws rolls back the whole batch, as D1 does. The fence pattern (`lease_guard`'s `CHECK (ok = 1)` aborting the batch) therefore works unchanged.
- Same limits as D1: 100 bound parameters, 2 MB per row, 100 KB per statement.

Code that runs inside the store gets `env.DB` = the adapter, so routes, `Scoped`, the ledger, the sync steps and recompute keep their current code. The adapter has its own tests: the existing fence tests run against both D1 and the adapter.

Differences the adapter must handle, each with a test:

- `sql.exec` is synchronous. The adapter wraps results in resolved promises, so `await` still works.
- **No `await` inside `transactionSync`.** Batches are built first and then executed, which is already how the code works.
- Errors look different. `isFenceAbort()` matches both D1's and the store's message for a failed `CHECK`.
- SQLite version and pragmas may differ slightly. The full integration suite runs against both backends in CI until the D1 path is removed.

### 5.3 Schema migrations per store

- `packages/db/store-migrations/` holds the budget-side schema: `0001_baseline.sql` is today's budget tables after 0009, without the directory tables and without `budget_id` columns.
- Keeping `budget_id`: **yes, for now.** Removing it would touch every query. The column stays, always set to the store's budget id, and `Scoped` keeps binding it. It costs a few bytes per row. Removing it is a later clean-up, not part of this plan.
- The store runs its pending migrations in `blockConcurrencyWhile` before serving, recorded in a `_migrations` table. They stay forward-only, checked by the same `migration-check` script.
- A deploy changes migrations for every store, but each store applies them on its next request. The Worker's deploy smoke test calls the owner's store, so a failing migration fails the deploy and the existing rollback runs.

### 5.4 Sync, leases and fences

- Workflows stay. Each step calls an RPC method on the budget's store: fetch from Plaid, stage the page, apply, process, recompute. The Workflow keeps orchestrating, and the store does the database work.
- A store handles one request at a time, so a single batch can't interleave with another. Leases still matter, though: a Workflow step that lost its lease must not apply a page after another run took over. The lease and fence logic stays as it is, inside the store.
- Plaid calls happen inside the store (`fetch` from a Durable Object counts against the 50 external subrequests per invocation, the same as today's steps).
- A later option, not in this plan: replace Workflows with Durable Object alarms. That would remove the 3,000 steps a day limit, the binding constraint on Free. It rewrites the sync orchestration, so it would be a separate decision after this move.

### 5.5 Cron

The cron reads budget ids from the directory, at most 25 per run from a cursor in `app_state`. For each one it starts the per-budget Workflow, or calls the store for the daily scan. With one budget this is one call at the same times as today.

## 6. Keeping users apart

Most of v1's isolation work isn't needed: a request for budget A can only reach A's store, because the Worker picks the store from the user's own membership row.

What still needs care:

- **The Worker's routing**: the store is chosen only from `budget_member` for the verified user, never from a request parameter. A test signs in as user A and tries to reach B's store through every route, by putting B's budget id, connection id and Plaid item id in the path and the body.
- **The directory routes** (security, invites, People): every query filters by `user_id`. This covers v1's A6: passkey list and delete, "keep at least one passkey", sign out everywhere, device links.
- **Webhooks**: the Plaid item id is looked up in `connection_route` to find the budget. That table is written only when a link is saved.
- **`connectionToken`** lives in the store, so it can only see its own connections (v1's A7 goes away).
- **Foreign ids in request bodies** (v1's A8) can only name rows in the same store. A bad id fails with not found instead of leaking another budget's names.

## 7. Moving the owner's data

The owner's budget is 4.2 MB (718 transactions, 7 banks, Nov 2, 2026).

### 7.1 Steps

1. **Ship the store and adapter with the D1 path still live.** `budget.store_version` in the directory says where a budget's data lives: `d1` (default) or `store`. Every budget request goes to D1 while it's `d1`, so this deploy changes nothing for the owner.
2. **Copy.** An admin-only action (Settings → People → Storage, or an ops route) starts a `MoveBudgetWorkflow`. It sets the budget read-only (writes get a 503 "Moving your budget, a minute or so"), pauses syncs for that budget by holding all its leases, and copies table by table in chunks of 500 rows into the store with `importAll`. Writes to the store count against the daily limits, about 20,000 rows for the owner.
3. **Verify** inside the store: row counts per table equal D1's; a hash of each table's rows equals D1's; a full recompute from scratch in the store equals the stored month summaries and Ready to Assign; the rule 10 identity holds. Any difference stops the move. The budget stays on `d1`, writes come back on, and the store is wiped.
4. **Switch**: set `store_version = 'store'` and release the read-only state and leases in one directory batch. From now on every request goes to the store.
5. **Keep the D1 copy** for 30 days, untouched. A reverse action (`MoveBudgetWorkflow` the other way, same code) can move the budget back with every change made since the switch. After 30 days, and only when the owner agrees, a forward migration drops the budget tables from D1.

The owner is told before step 2 and picks the time. The whole move should take a few minutes.

### 7.2 Backups and recovery

- D1 Time Travel (7 days on Free) keeps covering the directory.
- Durable Objects with SQLite have point-in-time recovery (`getBookmarkForTime`, `onNextSessionRestoreBookmark`): up to 30 days per object. Phase 0 checks that this works on the Free plan. If it does, an admin-only "Restore this budget to a time" action is built for it, which is better than today's 7 days.
- The JSON export keeps working (it runs in the store).
- D-29 (no off-site backup) is unchanged.

## 8. Accounts, sign-in and the switch

These are carried over from v1 after its review. Changes for v2 are noted.

### 8.1 Identity and passkeys

- The directory schema adds to `user`: `display_name`, `is_admin`, `status` (`active` / `disabled` / `deleting`), `last_seen_at`, `link_allowance` (default **0**, decided by the owner), `webauthn_handle`. `passkey`, `auth_session`, `device_link` get `user_id`. The owner's rows are backfilled: admin, link allowance 10, handle `ledgerline-owner`.
- `identify()` returns the user id from the session; `OWNER_EMAIL` goes away. Email is no longer identity; new users get `u:<id>` in the existing `NOT NULL UNIQUE` column.
- Each new user gets a random WebAuthn user handle and their name as `userName`. `excludeCredentials` lists only their passkeys. Sign-in checks that the assertion's `userHandle` matches the passkey's user. This stops a new account's passkey from replacing the owner's on a shared device.
- Disabling a user deletes their sessions and stops their banks syncing.

### 8.2 Challenges and rate limits

- Starting a ceremony writes nothing: the challenge goes in a 5-minute HMAC-signed cookie (HKDF key from `TOKEN_KEYS`, label `ledgerline-challenge`).
- Single use comes from the session row: a successful finish stores `challenge_id` under a unique index. It doesn't rely on the signature counter (iCloud passkeys always report 0).
- The Workers rate-limiting binding (about 20 a minute per IP) covers every `/api/auth/*` and sign-up route, with no D1 fallback.

### 8.3 The switch, invites and recovery

- `SIGNUPS` (`off` / `invite` / `open`, default `off`) and `MAX_USERS` (default `1`) are Worker variables, so turning on takes a deploy. While off, invite, sign-up and recovery routes return 404 and the web app hides them.
- **Invite link** (token in the URL fragment, single use, 7 days, hash stored): one directory batch creates the user, budget, membership, passkey, session and recovery code, fenced on the invite, the switch and `MAX_USERS` (counting active, disabled and deleting users). Then the new budget's store is created and runs its migrations. The new user lands in first-run setup with the invite's link allowance (default 0).
- **Open sign-up**: the same flow without an invite, only when `SIGNUPS = open`.
- **Recovery codes** are for non-owner users only: shown once and stored as a unique hash. Using one deletes all that user's passkeys and sessions and issues a new code. The owner keeps D-27's recovery. Admins can also make a device link for a user.

### 8.4 Settings → People (admins)

- Shown once `SIGNUPS` isn't `off`: invites, users (name, joined, last seen, links used, today's writes and steps), disable and enable, link allowances, delete, and the shared counters (Plaid links of the cap, users of `MAX_USERS`, today's usage, total store storage).
- **Storage** (always shown to the admin): where each budget lives (`d1` / `store`), its size, the move action (7.1), and on Free, restore to a time (7.2).
- **Diagnostics** (admin, for their own budget only): table row counts and a fixed list of named health queries. There is no free-form SQL endpoint: that would be an injection and data-access risk. This replaces the D1 console for checking the owner's data from a phone or a Claude session.

## 9. Sharing the free plan

### 9.1 Plaid links (active always)

As in v1 after its review:

- `PLAID_LINK_CAP` (10; set to 0 for no cap on Plaid Production) and `PLAID_LINKS_USED_BEFORE` (7, owner-confirmed).
- A `reserved` slot is taken in the directory, in a fenced batch, **before** Link opens. Exchange always saves the Item and marks the slot used. Cancelling releases it. Repair never reserves a slot.
- `link_allowance` (default 0) limits each user. On Plaid Production it remains the per-user control over how many paid Items each person can add.

### 9.2 Daily limits (multi-user mode only)

- Each store knows its own rows read and written from `meta`. It keeps a running total in memory and adds it to `budget_usage_day` in the directory at most once a minute.
- Per-user shares (`USER_WRITE_SHARE` 20,000, `USER_READ_SHARE` 1,000,000; admins exempt): past either, that user's writes get a 503 and their syncs pause until midnight UTC.
- New-bank backfills are admitted against today's writes and Workflow steps (estimated 7 writes and 50 steps per 1,000 transactions) and queued past the 70% line.
- The account-wide breaker (70% pause, 90% read-only) reads D1 and Durable Object usage from GraphQL Analytics and checks the right one for each limit. This depends on phase 0's finding about shared pools.
- Quiet budgets (no sign-in for 14 days, not the admin's) get a weekly full recompute instead of daily, and webhooks for them wait for the next backstop.

### 9.3 Capacity on Free

Phase 0 and phase 8 measure these; until then they are estimates.

| Limit                                              | Per active user, per day                        | Users it allows                                                |
| -------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| Plaid Trial links                                  | 1 to 7, once                                    | 3 left in total: 1 to 3 more people                            |
| Workflow steps (3,000)                             | ~10 maintenance + ~12 per sync                  | about 5 to 10                                                  |
| Rows written (100,000)                             | a few thousand; ~20,000 the day a bank is added | about 10 to 15 if shared with D1, more if separate             |
| Requests (100,000 Worker + 100,000 Durable Object) | a few hundred to a few thousand                 | 30+                                                            |
| Storage                                            | ~9 MB a year                                    | 1 GB each: about 100 years; 5 GB total: hundreds of user-years |

On Free, other users still means a handful, because of Plaid Trial and Workflow steps. The move removes the size and shared-writer limits for the paid plan.

## 10. Deleting an account

A `DeleteAccountWorkflow`:

1. Removes each Plaid Item (`/item/remove`; this doesn't give the Trial slot back, and the confirm screen says so).
2. Calls the store's `wipe()` (`ctx.storage.deleteAll()`), which deletes the budget's whole database at once. The append-only triggers don't apply because nothing is deleted row by row.
3. Deletes the directory rows (membership, passkeys, sessions, recovery code, `connection_route`, user, budget). `plaid_link_slot` rows stay.

It starts after a fresh passkey check and typing the budget name, and offers the JSON export first. The last admin can't be deleted from the app.

## 11. Build phases

Each phase lands on `main` with `pnpm check` passing. The owner's app is unchanged after every phase until phase 4's switch, which happens only when the owner says so.

0. **Measure first** (no app change): deploy a throwaway Durable Object class behind an ops-only route; write and read 10,000 rows; check in GraphQL Analytics and the dashboard whether that usage counts against D1's daily limits; time a request that goes Worker → store → SQLite and back against the 10 ms CPU rule; check point-in-time recovery on Free. Remove the class. Record in `docs/measurements.md`. _If_ the store hop doesn't fit 10 ms for the heavy screens, stop and report before phase 1.
1. **Adapter and store skeleton**: `BudgetStore`, the D1-shaped adapter, the per-store migration runner, `0001_baseline.sql`. _Verify:_ the integration suite runs against both D1 and the store backend in CI; fence tests pass on both.
2. **Routing**: `store_version` in the directory; the Worker forwards budget routes to the store when `store`; Workflows and cron call store RPC methods. _Verify:_ e2e suite passes with the test budget on `store`; the owner's budget is still on `d1` in production.
3. **Directory split**: directory tables and `connection_route`; the webhook looks up the budget; usage and the breaker read both sources. _Verify:_ a webhook for a store budget starts its sync; the breaker test with store usage.
4. **Move tool**: `MoveBudgetWorkflow` both ways, verify step, read-only state, Storage screen. _Verify:_ moving the November fixture and a 3,000-transaction budget both ways gives identical hashes and recomputes; a forced mismatch stops the move. **Then, with the owner's go-ahead, move the owner's budget.**
5. **Remove the D1 budget path** after 30 days and the owner's OK: forward migration dropping budget tables from D1; the integration suite runs on the store only.
6. **Identity and passkeys** (8.1, 8.2). _Verify:_ owner sign-in unchanged; replayed challenge fails; another user's handle fails.
7. **Switch, invites, recovery, People, diagnostics** (8.3, 8.4) and the routing isolation test (6). _Verify:_ with `SIGNUPS = off` all new routes return 404; e2e for invite sign-up, reused invite, `MAX_USERS`, recovery.
8. **Plaid slots, fair share, deletion** (9, 10), then a capacity run: seed 10 users with the November fixture, simulate a day, update 9.3.
9. **Docs**: D-37 (per-budget databases, directory, adapter, identity, recovery codes; supersedes `design.md` rows on D1 and Users), `sync-spec.md` (where fences live; step limit verified), `threat-model.md`, `build-plan.md`, `runbooks/setup.md`.

Rough size: phases 0–5 about two to three weeks of sessions, phases 6–8 about one to two.

## 12. Open questions

- Does Durable Object row usage share the D1 daily pool on Free? (Phase 0; decides 9.2 and 9.3.)
- Does the store hop fit 10 ms of CPU on the heaviest screen? (Phase 0; the plan stops there if not.)
- Is point-in-time recovery available on Free? (Phase 0; decides the restore action.)
- Replace Workflows with alarms later? (5.4; a separate decision.)
- Do Plaid Trial terms allow other people's banks at all? (Before turning on.)

## 13. History

- **v1** (one shared D1 database) was reviewed twice on Nov 2, 2026. The review's findings still shape v2: Plaid slots reserved before Link, per-user passkey handles, replay protection from a unique challenge id, the rate-limiting binding, recovery codes only for non-owners, everything gated so the owner's app doesn't change, and a measured step limit. Findings v2 makes moot: append-only triggers blocking deletion, the global apply counter, `bank_event` scans across budgets, isolation of foreign ids and of `connectionToken`.
- **v2**: database per budget, chosen by the owner on Nov 2, 2026 after seeing the trade-offs. The owner's data was 4.2 MB, so size was not the reason; growth past one database was.
