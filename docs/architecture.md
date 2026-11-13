# Architecture, as built

One page on how Ledgerline works today (Nov 13, 2026). It says what is true now; the designs it came from (`docs/design.md`, `docs/sync-spec.md`, `docs/multi-user.md`, `docs/phone-budget.md`, `docs/privacy.md`, `docs/privacy-keys.md`) keep their reasoning and history, and `docs/whats-true-now.md` lists where they were replaced. The Money rules stay in `docs/sync-spec.md` and `packages/domain`. `docs/claims.md` says which privacy claims are true now.

Every budget is **locked** (sealed) (D-102): the server holds it only as a signed, sealed log, and every piece of budget work runs on the device. The owner's budget has been locked since Nov 12, 2026, 22:24:55 UTC; sign-up is closed, so it is the only budget. A new budget is made on its first device, locked from its first moment. The server has no code that reads or changes a budget's tables, and has none of those tables: store migration 0010 dropped them (D-106). Cloudflare's 30-day point-in-time recovery still holds the store's past states, the old tables among them, until 30 days after that migration ran.

## Pieces

| Piece                    | Where                                                           | What it does                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker `ledgerline`      | `apps/worker/src/index.ts`                                      | Serves the app's files and `/api/*`. Rate-limits sign-in by IP, then hands every API request to the Durable Objects (`store/router.ts`).                         |
| `Directory` (one object) | `apps/worker/src/store/directory.ts`                            | Users, passkeys, sessions, which budget each user has, the budget's name, Plaid link slots and webhook routes, daily usage and the breaker, the one cron.        |
| `BudgetStore` (one each) | `apps/worker/src/store/budget-store.ts`, `apps/worker/src/seal` | The sealed log, sealed bank runs, snapshots, `bank_link` and the fetch job; a new budget's start. Nothing readable of the budget (D-106).                        |
| The key code             | `packages/seal`, `apps/web/src/keys`                            | Budget key, ways in (passkey and recovery key slots), signing, sealing, the log's rules, snapshots, bank runs (`docs/privacy-keys.md`). One copy for both sides. |
| The engine on the device | `apps/worker/src/local`, `apps/web/src/copy`                    | A copy of the budget's tables in sql.js, in a Web Worker. Runs every edit and every bank filing, and works out every screen with the server's own routes.        |
| The app                  | `apps/web`                                                      | React SPA. Reads screens from the engine; it sends only sealed entries, snapshots and a few account calls.                                                       |
| Shared code              | `packages/domain`, `packages/contracts`, `packages/db`          | The Money rules, the API shapes (Zod), the budget and store migrations and the small SQL interface.                                                              |

Data lives only in Durable Objects' SQLite (D-37, D-38). Cloudflare keeps 30 days of point-in-time recovery for each object; there is no other backup (D-29). Free plan only, no payment card (D-26).

## What the server stores for a locked budget

- **The log** (`seal/log-store.ts`, store migration 0005): a genesis entry, then signed entries in order, each sealed with the budget key, padded. A write is whole or not at all, checked by the log's rules and the server's own (`packages/seal`). Public entries (key changes, ways in) stay readable as signed facts with no budget data.
- **Snapshots** (`seal/snapshot-store.ts`, 0008, 0009): sealed chunks, a signed header and each device's check record; the one before the newest checked one stays, with every entry and run since.
- **Bank runs** (`seal/runs.ts`, 0006): each page sealed to the budget's inbox key the moment Plaid answers, then the run signed by the Worker. Plain: counts, sizes, times, cursors.
- **`bank_link`** (0002, 0007): each link's id, Plaid Item id, encrypted token, state and last fetch, under the Worker's stamp (`linkMac`, written when the link is made). No bank or account name.
- **The mark** (`store/marks.ts`): "sealed". A sealed budget answers only `/api/log/*`, `seal/sealed-routes.ts` (who is signed in, its bank links by id, link, repair, remove, Fetch now; the bank routes only once the budget is sealed) and the Plaid webhook; every other path says "Update Ledgerline to continue." A budget not sealed yet has only its session (which tells the device to make it) and `/api/start/*`. The server can't restore a budget.
- **What it can see** (`docs/privacy.md` 4.3): times, sizes and counts of entries and runs, link ids and states, passkeys and devices, and the app's own log lines for 3 days. Cloudflare's invocation logs (IP address, location, full address) are off (D-112).

## A request

1. The Worker refuses at once, with no Durable Object request: an API call with no session cookie, a closed sign-up, or a request while this isolate knows the app is resting (`store/router.ts`).
2. The `Directory` checks the session, the recent-passkey rule, the breaker (resting at 95% of a daily limit) and the user's fair-use share (`authenticate`). Sign-in and Settings → Sign-in end here.
3. The user's own `BudgetStore` takes it. The budget is chosen only from the session's membership, never from the request. It answers the routes above, and nothing else.

## The engine on the log

- **Opening.** The passkey's PRF secret opens the budget key from its slot in the log's public entries (`copy/sealed.ts`); the derived keys go to the engine's thread. A device that kept its place in the log reads on from there; a new one opens the newest checked snapshot and reads on (`local/device-snapshot.ts`).
- **Edits.** The engine runs the budget's edit routes (`apps/worker/src/routes`) on the copy (`apps/worker/test/twin.test.ts` proves an edit gives the same rows on two devices, and its recorded rows on a third), records the rows it changed, and sends them as one signed, sealed entry (`local/device-log.ts`, `local/log-session.ts`): a base plus a queue, with an entry id so a resend lands once. When the log moved on, the queue comes out, the newer entries go in, and the queue runs again. Before the copy is open, an edit is refused with "This can’t be changed here yet." (`api/client.ts`).
- **Bank filing.** The device opens up to 16 runs, files them with the steps the server once ran (`local/file-run.ts`, `local/sealed-filing.ts`: apply, process, heal and the end of the update), and sends one bank entry with their receipts; edits wait behind unfiled runs. Two devices that file the same run end equal.
- **Snapshots.** At most every 6 hours while the app is in view, the device writes a snapshot or checks the newest one by rebuilding from the one before plus the entries since (`copy/copy.ts`).
- **Same code.** `LocalEngine` keeps the tables the server never had (budget lines, month snapshots, month totals); `engine.test.ts` checks a copy that rebuilt only what changed shows the screens of one worked out from scratch. The copy runs the budget migrations itself (`migrateLocal`).
- **Saved copy.** Encrypted with a key from the passkey (PRF) and a per-device share the server keeps (`copy/vault.ts`), as one blob in IndexedDB. The app refuses a server that answers as if a budget were not locked (`copy/sealed-session.ts`).

## Background work

- **The fetch job** (`seal/fetch-job.ts`): one job per link, one link at a time. Begin, then each page fetched and sealed in one step, the last one with the bank's balances and card statements (D-110), then sign and complete. It starts from the bank's webhook, from Fetch now, and from a 4-hour backstop, which also runs the snapshot delete rule. It pauses at 70% of a daily limit. A bad stamp stops it and is logged. Besides it a store runs only the Item routes; a job of any other kind found there (the old purge and link check among them, D-106) is dropped unrun.
- **The cron** (10:20 UTC) wakes the Directory, which refreshes usage and checks every budget's jobs.
- **No daily scan or nightly maintenance** runs on the server. For a locked budget, no device runs them yet either (a scan entry kind exists in `local/device-log.ts`, nothing sends one).

## A new budget

A new account's budget is made on its first device (D-102): the lock screen (`apps/web/src/screens/Setup.tsx`) has the passkey make the budget key, its recovery key and the log's first entry (`apps/web/src/keys/budget.ts` `createBudget`, `keys/new-budget.ts`); the person writes the recovery key down and types it back, and a fresh passkey sign-in proves the passkey opens the key. The device then makes a copy holding only the budget's own row, seals its first snapshot, and sends both (`apps/worker/src/local/start-device.ts`); the server stores them as any entry and snapshot, under the Worker's stamps, and marks the budget sealed (`seal/start.ts`, `/api/start/*`). A budget that holds data of its own is refused. First-run setup then runs as edits on the device.

The owner's budget was moved to its log on Nov 12, 2026 by a cutover (`docs/privacy.md` section 8, D-100); the cutover and its way back were removed with D-102. Its readable copy was dropped by store migration 0010 (D-106); the purge job and its check that came before are gone.

## Limits that shape the code

- 10 ms of CPU per request or job step, SQLite included (`docs/measurements.md`).
- Free daily limits on Durable Object requests and rows. The breaker refuses writes at 90% and rests at 95%.
- Plaid allows 10 links for life; 3 are left. Only admins link banks (D-75).

## Deploys and the reproducible build

- Every merge to `main` deploys after its `ci` passes (a set of files that already passed as a pull request isn't tested again, and a docs-only merge doesn't deploy: D-84); there is no staging and no manual deploy (D-30, D-36, D-49). A failed smoke test rolls the code back; migrations are forward-only and expand-only.
- Each object migrates itself when it starts. Store migrations run on the server only. Budget migrations run on every copy; a store ran them up to 0012 and runs no later one (D-106, `tools/db/store-last-budget.mjs`).
- The web build is reproducible (D-96): the same commit gives the same files, and `ci` builds twice to check it. Each build writes `/release.json` (the commit, a hash of every file, and one build hash); the deploy keeps that list with its run and attests it; Settings → About shows the commit and the build hash. `docs/runbooks/verify-build.md` has the steps to check a release. It covers the app's files, not the Worker.
- Recovery: the server can't restore a budget. Its devices hold it, and the full backup is made on a device (`docs/runbooks/restore.md`).

## Multi-user

Open sign-up, fair-use shares and Settings → Users are built and switched off (D-75, `docs/open-signup.md`); a new account locks its budget on its device, and its recovery key replaces the recovery codes (D-102). No new multi-user work until Plaid Production is an option (D-78).
