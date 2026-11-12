# Architecture, as built

One page on how Ledgerline works today (Nov 12, 2026). It says what is true now; the designs it came from (`docs/design.md`, `docs/sync-spec.md`, `docs/multi-user.md`, `docs/phone-budget.md`, `docs/privacy.md`, `docs/privacy-keys.md`) keep their reasoning and history, and `docs/whats-true-now.md` lists where they were replaced. The Money rules stay in `docs/sync-spec.md` and `packages/domain`. `docs/claims.md` says which privacy claims are true now.

The owner's budget has been **locked** (sealed) since Nov 12, 2026, 22:24:55 UTC: the server holds it only as a signed, sealed log, and every piece of budget work runs on the device. Sign-up is closed, so it is the only budget. The code for a budget that is not locked stays, for the 7-day way back and for tests.

## Pieces

| Piece                    | Where                                                           | What it does                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker `ledgerline`      | `apps/worker/src/index.ts`                                      | Serves the app's files and `/api/*`. Rate-limits sign-in by IP, then hands every API request to the Durable Objects (`store/router.ts`).                         |
| `Directory` (one object) | `apps/worker/src/store/directory.ts`                            | Users, passkeys, sessions, which budget each user has, the budget's name, Plaid link slots and webhook routes, daily usage and the breaker, the one cron.        |
| `BudgetStore` (one each) | `apps/worker/src/store/budget-store.ts`, `apps/worker/src/seal` | For a locked budget: the sealed log, sealed bank runs, snapshots, `bank_link` and the fetch job. The old readable tables stay untouched until phase 6.           |
| The key code             | `packages/seal`, `apps/web/src/keys`                            | Budget key, ways in (passkey and recovery key slots), signing, sealing, the log's rules, snapshots, bank runs (`docs/privacy-keys.md`). One copy for both sides. |
| The engine on the device | `apps/worker/src/local`, `apps/web/src/copy`                    | A copy of the budget's tables in sql.js, in a Web Worker. Runs every edit and every bank filing, and works out every screen with the server's own routes.        |
| The app                  | `apps/web`                                                      | React SPA. Reads screens from the engine; for a locked budget it sends only sealed entries, snapshots and a few account calls.                                   |
| Shared code              | `packages/domain`, `packages/contracts`, `packages/db`          | The Money rules, the API shapes (Zod), the budget and store migrations and the small SQL interface.                                                              |

Data lives only in Durable Objects' SQLite (D-37, D-38). Cloudflare keeps 30 days of point-in-time recovery for each object; there is no other backup (D-29). Free plan only, no payment card (D-26).

## What the server stores for a locked budget

- **The log** (`seal/log-store.ts`, store migration 0005): a genesis entry, then signed entries in order, each sealed with the budget key, padded. A write is whole or not at all, checked by the log's rules and the server's own (`packages/seal`). Public entries (key changes, ways in) stay readable as signed facts with no budget data.
- **Snapshots** (`seal/snapshot-store.ts`, 0008, 0009): sealed chunks, a signed header and each device's check record; the one before the newest checked one stays, with every entry and run since.
- **Bank runs** (`seal/runs.ts`, 0006): each page sealed to the budget's inbox key the moment Plaid answers, then the run signed by the Worker. Plain: counts, sizes, times, cursors.
- **`bank_link`** (0002, 0007): each link's id, Plaid Item id, encrypted token, state and last fetch, under the Worker's stamp (`store/stamp-links.ts`). No bank or account name.
- **Marks** (`store/marks.ts`): "sealed" and "frozen". A sealed budget answers only `/api/log/*`, `seal/sealed-routes.ts` (who is signed in, its bank links by id, repair, Fetch now) and the Plaid webhook; every other route says "Update Ledgerline to continue." The server can't restore a locked budget, and `GET /api/sync` and the export dump are refused.
- **What it can see** (`docs/privacy.md` 4.3): times, sizes and counts of entries and runs, link ids and states, passkeys and devices, and Cloudflare's invocation logs (IP address, location, full address) for 3 days.

## A request

1. The Worker refuses at once, with no Durable Object request: an API call with no session cookie, a closed sign-up, or a request while this isolate knows the app is resting (`store/router.ts`).
2. The `Directory` checks the session, the recent-passkey rule, the breaker (resting at 95% of a daily limit) and the user's fair-use share (`authenticate`). Sign-in and Settings → Sign-in end here.
3. The user's own `BudgetStore` takes it. The budget is chosen only from the session's membership, never from the request. For a locked budget, the routes above; for one that is not, `routes/api.ts`, whose screen routes answer `on_device`.

## The engine on the log

- **Opening.** The passkey's PRF secret opens the budget key from its slot in the log's public entries (`copy/sealed.ts`); the derived keys go to the engine's thread. A device that kept its place in the log reads on from there; a new one opens the newest checked snapshot and reads on (`local/device-snapshot.ts`).
- **Edits.** The engine runs the server's own edit routes on the copy (`apps/worker/test/twin.test.ts` proves each gives the server's rows), records the rows it changed, and sends them as one signed, sealed entry (`local/device-log.ts`, `local/log-session.ts`): a base plus a queue, with an entry id so a resend lands once. When the log moved on, the queue comes out, the newer entries go in, and the queue runs again. Edits the engine can't make yet are refused with "This can’t be changed here yet." (`api/client.ts`).
- **Bank filing.** The device opens up to 16 runs, files them with the server's former steps (`local/file-run.ts`, `local/sealed-filing.ts`: apply, process, heal and the end of the update), and sends one bank entry with their receipts; edits wait behind unfiled runs. Two devices that file the same run end equal.
- **Snapshots.** At most every 6 hours while the app is in view, the device writes a snapshot or checks the newest one by rebuilding from the one before plus the entries since (`copy/copy.ts`).
- **Same code.** `LocalEngine` keeps the tables the server never had (budget lines, month snapshots, month totals); `engine.test.ts` checks a copy shows the same screens as a fresh one. The copy runs the budget migrations itself (`migrateLocal`).
- **Saved copy.** Encrypted with a key from the passkey (PRF) and a per-device share the server keeps (`copy/vault.ts`), as one blob in IndexedDB. A device remembers each budget it knew as locked, outside the copy too, and refuses a server that answers as if it were not.

## Background work

- **The fetch job** (`seal/fetch-job.ts`): one job per link, one link at a time. Begin, then each page fetched and sealed in one step, then the bank's balances and card statements, then sign and complete. It starts from the bank's webhook, from Fetch now, and from a 4-hour backstop, which also runs the snapshot delete rule. It pauses at 70% of a daily limit. A bad stamp stops it and is logged. A sealed budget runs no other job; any other job found there is dropped unrun.
- **The cron** (10:20 UTC) wakes the Directory, which refreshes usage and checks every budget's jobs.
- **A budget that is not locked** keeps the old jobs on its alarm (`store/jobs.ts`): bank sync, the backstop, the daily scan at 5:00 AM and maintenance at 2:20 AM in its time zone. For a locked budget, no device runs the daily scan or the nightly maintenance yet (a scan entry kind exists in `local/device-log.ts`, nothing sends one).

## The move and the way back

The move (`docs/privacy.md` section 8, D-95; no shadow run) is `seal/cutover.ts` and `cutover-routes.ts` on the server and `local/cutover-device.ts` with `apps/web/src/keys/move.ts` on the phone, started from Settings → Privacy. The device proves the passkey and the typed recovery key open the new key; the server freezes the budget and hashes every table; the phone compares its copy; then the first entry and snapshot are stored, each link starts at its cutover cursor, the old jobs go, and the budget is marked sealed. The routes answer only for the budget the Worker's `CUTOVER` variable names. For 7 days a way back (a fresh passkey prompt) clears the mark and sets each link back to its cutover cursor, and the old code runs on the old tables; edits since the move are lost. During those 7 days no bank is linked or removed. Then the old tables are emptied (phase 6, not built).

## Limits that shape the code

- 10 ms of CPU per request or job step, SQLite included (`docs/measurements.md`).
- Free daily limits on Durable Object requests and rows. The breaker refuses writes at 90% and rests at 95%.
- Plaid allows 10 links for life; 3 are left. Only admins link banks (D-75), and not yet into a locked budget.

## Deploys and the reproducible build

- Every merge to `main` deploys after its `ci` passes (a set of files that already passed as a pull request isn't tested again, and a docs-only merge doesn't deploy: D-84); there is no staging and no manual deploy (D-30, D-36, D-49). A failed smoke test rolls the code back; migrations are forward-only and expand-only.
- Each object migrates itself when it starts. Store migrations run on the server only; budget migrations also on every copy. No budget migration ships while the old tables wait for phase 6.
- The web build is reproducible (D-96): the same commit gives the same files, and `ci` builds twice to check it. Each build writes `/release.json` (the commit, a hash of every file, and one build hash); the deploy keeps that list with its run and attests it; Settings → About shows the commit and the build hash. `docs/runbooks/verify-build.md` has the steps to check a release. It covers the app's files, not the Worker.
- Recovery: the server can't restore a locked budget. Its devices hold it; a full backup made on the device is being built. The runbook restore (`docs/runbooks/restore.md`, D-77) applies only to a budget that is not locked.

## Multi-user

Open sign-up, recovery codes, fair-use shares and Settings → Users are built and switched off (D-75, `docs/open-signup.md`). No new multi-user work until Plaid Production is an option (D-78).
