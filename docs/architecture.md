# Architecture, as built

One page on how Ledgerline works today (Nov 9, 2026). It says what is true now; the designs it came from (`docs/design.md`, `docs/sync-spec.md`, `docs/multi-user.md`, `docs/phone-budget.md`) keep their reasoning and history, and `docs/whats-true-now.md` lists where they were replaced. The Money rules stay in `docs/sync-spec.md` and `packages/domain`.

## Pieces

| Piece                    | Where                                                  | What it does                                                                                                                                           |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker `ledgerline`      | `apps/worker/src/index.ts`                             | Serves the app's files and `/api/*`. Rate-limits sign-in by IP, then hands every API request to the Durable Objects (`store/router.ts`).               |
| `Directory` (one object) | `apps/worker/src/store/directory.ts`                   | Users, passkeys, sessions, which budget each user has, Plaid link slots and webhook routes, the sync epoch, daily usage and the breaker, the one cron. |
| `BudgetStore` (one each) | `apps/worker/src/store/budget-store.ts`                | One budget's SQLite: what was entered and imported, the bank log, the change log. Runs its own jobs on alarms. Keeps nothing derived.                  |
| The engine on the device | `apps/worker/src/local`, `apps/web/src/copy`           | A copy of the budget's tables in sql.js, in a Web Worker. Works out every screen with the server's own routes and `computeBudget()`.                   |
| The app                  | `apps/web`                                             | React SPA. Reads screens from the engine; sends changes to the Worker.                                                                                 |
| Shared code              | `packages/domain`, `packages/contracts`, `packages/db` | The Money rules, the API shapes (Zod), the migrations and the small SQL interface.                                                                     |

Data lives only in Durable Objects' SQLite (D-37, D-38). Cloudflare keeps 30 days of point-in-time recovery for each object; there is no other backup (D-29). Free plan only, no payment card (D-26).

## A request

1. The Worker refuses at once, with no Durable Object request: an API call with no session cookie, a closed sign-up, or a request while this isolate knows the app is resting (`store/router.ts`).
2. The `Directory` checks the session, the recent-passkey rule, the breaker (resting at 95% of a daily limit) and the user's fair-use share (`authenticate`). Sign-in and Settings → Sign-in end here.
3. The user's own `BudgetStore` runs the route (`routes/api.ts`). The budget is chosen only from the session's membership, never from the request.
4. GET routes for screens answer `on_device` on the server (`serverReadsOnly`). Only the session, the sync, bank connections, exports, the restore record and health are read from the server.
5. A change is checked, stored, logged in `change_log` by triggers, and answered `{ ok: true }`. When the app sends `x-sync-since`, the answer also carries up to 50 changes since that number, so the copy catches up without a second request (`routes/sync.ts` `syncInAnswer`).

Each write checks today's usage, kept up to 30 seconds in the store (`USAGE_FOR_WRITE`); it is refused at 90% of a daily limit (D-40).

## Sync to the device

- **The change log.** SQLite triggers on every synced table (`src/sync-tables.ts`) upsert one `change_log` row per changed row, with a number that only grows. Every writer is covered, jobs included.
- **`GET /api/sync?since=N`.** `since=0` is a full download, table by table; otherwise the rows changed after `N`, in order. Pages hold 200 rows. The device works numbers out only when a page says nothing more is coming.
- **The epoch.** The Directory holds each budget's sync epoch. A restore changes it, and a device holding another epoch throws its copy away and downloads again. A format change (`SYNC_FORMAT`) does the same.
- **When.** On open, on return to the app, on pull-to-refresh, every 2 minutes while open, and from each edit's answer.

## The engine and the copy

- **Same code.** `LocalEngine` runs `budgetApi`, the server's own Hono routes and SQL, against the copy, and keeps the tables the server dropped (budget lines, month snapshots, month totals). `apps/worker/test/engine.test.ts` checks a copy kept up to date by the change log shows the same screens as a fresh download; `engine-routes.test.ts` runs every screen route on a copy.
- **Rebuilding.** After a sync the engine rebuilds only the lines of changed transactions and recomputes from the earliest month touched; a new day, an account, the budget's start or time zone, or a new `DERIVE_VERSION` rebuilds everything.
- **Migrations.** The copy runs the server's budget migrations itself (`migrateLocal`), skipping `SERVER_ONLY`. `tools/ci/migration-check.mjs` applies each one in sql.js too, and `engine-upgrade.test.ts` upgrades copies left at older schemas.
- **Time.** Today and the current month come from the server's clock and the budget's time zone, never the device's.
- **Saved copy.** Encrypted with a key from the passkey (WebAuthn PRF) and a per-device share the server keeps (`copy/vault.ts`), as one blob in IndexedDB. It is saved after changes, and at least once an hour while open. Signing out a device in Settings → Sign-in turns its copy off.
- **Offline edits.** A short list (`copy.ts` `OFFLINE_EDITS`) is applied to the copy and queued; the queue is sent with edit ids, so a resend applies once. A refused edit drops the copy, which downloads again.

## Background work

Each `BudgetStore` runs jobs on its own alarm (`store/jobs.ts`): bank sync in steps of 100 rows, a 4-hour backstop, the daily scan at 5:00 AM and maintenance at 2:20 AM in the budget's time zone. A failed step backs off, up to 6 tries. The one cron (10:20 UTC) wakes the Directory, which refreshes usage and checks every budget's jobs. Idle budgets with no banks stop their jobs until used again.

## Limits that shape the code

- 10 ms of CPU per request or job step, SQLite included (`docs/measurements.md`).
- Free daily limits on Durable Object requests and rows. The breaker refuses writes at 90% and rests at 95%.
- Plaid allows 10 links for life; 3 are left. Only admins link banks (D-75).

## Deploys and recovery

- Every merge to `main` deploys after its `ci` passes (a set of files that already passed as a pull request isn't tested again, and a docs-only merge doesn't deploy: D-84); there is no staging and no manual deploy (D-30, D-36, D-49). A failed smoke test rolls the code back; migrations are forward-only and expand-only.
- Each object migrates itself when it starts.
- Recovery is a runbook step (`docs/runbooks/restore.md`, D-77): a point-in-time restore, and its undo, which the Directory keeps.

## Multi-user

Open sign-up, recovery codes, fair-use shares and Settings → Users are built and switched off (D-75, `docs/open-signup.md`). No new multi-user work until Plaid Production is an option (D-78).
