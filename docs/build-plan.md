# Build plan

Every phase in `docs/design.md` (Risks, open questions and plan → Build plan) broken into steps, each with how it is verified. Work runs in the order the owner set: go/no-go first, then the domain package and the November fixture, then the remaining phases. A phase is done only when its tests pass. Ticked boxes are done and verified; decisions taken along the way are in `docs/decisions.md`.

Legend: `[x]` done and verified · `[ ]` not done · **(manual)** needs the owner (Cloudflare, Plaid Production, GitHub settings).

## 0. Design in the repo

- [x] Export Design tab → `docs/design.md`, Sync spec tab → `docs/sync-spec.md`. _Verify:_ byte-for-byte Markdown export from Claude Docs.
- [x] Copy prototype screens and `canvas.json` → `docs/prototype/`, README lists every board. _Verify:_ 53 screen files + canvas.json present; README generated from canvas.json board titles.

## 1. Foundations and go/no-go (design Phase 1)

- [x] pnpm monorepo skeleton: `apps/web`, `apps/worker`, `packages/{domain,contracts,db,bank-provider,platform}`, `e2e`; strict TypeScript, ESLint, Prettier. _Verify:_ `pnpm -r typecheck`, `pnpm lint` clean.
- [x] Go/no-go harness on local `wrangler dev`: sync Workflow (fetch step + apply step) against a Plaid-shaped mock (no Sandbox keys available; D-4); CPU per step measured with workerd's V8 CPU profiler. _Verify:_ `docs/measurements.md` — 500 and 250 per page did not fit; redesigned (R2 raw pages, projection in D1, 100 per page in 50-event steps; D-5–D-7) to ~2 ms fetch and ~5 ms apply; 3,000-transaction backfill ran end to end in 109 steps and 30 Plaid calls.
- [x] Assignment edit in the first budget month with 36 months × 60 categories: CPU, D1 queries, rows written. _Verify:_ `docs/measurements.md` — about 20 ms as one recompute, so the recompute is chunked at 6 months (2.3–2.75 ms each, 4 D1 calls, about 50 rows written per first-month edit; D-21, D-22).
- [x] Fence tests in local D1: apply batch rolls back when the lease is released, expired, held by another run, or the connection row is missing; processing batch rolls back when the watermark moved; version fence. _Verify:_ integration tests.
- [x] D1 export row-read estimate on the 36-month dataset. _Verify:_ about 30,000 rows (< 1% of the daily read limit) in `docs/measurements.md`; the first nightly manifest confirms it.

## 2. Domain core (design Phase 2) — `packages/domain`

- [x] Money: branded integer cents, parse/format, no floats (lint rule). _Verify:_ unit + property tests.
- [x] Months and time zone: budget month math in America/Los*Angeles without a date library. \_Verify:* property tests (round trips, DST boundaries).
- [x] `computeBudget()`: the only Ready to Assign implementation; carry-forward with Money rules 1–9, 11, 12; snapshot start for incremental recompute. _Verify:_ property test per rule; incremental-from-snapshot equals full recompute (property).
- [x] Rule 10 identity checker, asserted in tests and in the daily recompute. _Verify:_ property test over random ledgers.
- [x] Rule 13 projected fronts; funding statuses (Overspent, Underfunded, Funded, Overfunded, Low, Covered/Short, Invested, Late/Tracking). _Verify:_ unit + property tests.
- [x] Targets: Refill, Set aside, Balance by date, Balance no date; versioned. _Verify:_ property tests for each formula and the remainder-to-last-month rule.
- [x] Rules engine (conditions, actions, first match wins, never overwrite user). _Verify:_ unit + property tests.
- [x] Pending and re-issue matcher; transfer pairing. _Verify:_ unit tests per table row in Matching mechanics.
- [x] Payee normalizer (clean, key, cluster). _Verify:_ unit tests with the doc's examples.
- [x] Budget lines: logical transactions + overlay → the lines `computeBudget()` consumes (pending, won't-clear, splits, owed parts, close/cancel, Waiting to match, transfers, history before `budget_from`). _Verify:_ unit + property tests.
- [x] **Canonical November fixture** reproducing the prototype's numbers, kept as a permanent regression test. _Verify:_ `packages/domain/test/november.test.ts` asserts every listed number.

## 3. Bank layer (design Phase 3)

- [x] D1 schema and forward-only migrations (all layers + Sync spec additions; `bank_event` immutability trigger; `lease_guard`; `v_transaction`). _Verify:_ migrations apply to a fresh local D1 and to the previous schema in CI; trigger test.
- [x] Budget-scoped data-access layer (every query requires a budget id checked against membership). _Verify:_ integration tests.
- [x] `BankDataProvider` port with the Plaid adapter (plus a Plaid-shaped local mock for development and tests) and CSV history import; sign flip test; 180-day `days_requested` test. _Verify:_ unit tests.
- [x] Sync Workflow: lease acquire/renew/fence/release/hand-off, staged fetch with restart, page apply with `apply_seq`, adopt, watermark post-processing, write breaker. _Verify:_ integration tests on local D1 + Workflows.
- [x] Plaid webhook verification (ES256 JWT, body hash, 5-minute `iat`), starts a sync only. _Verify:_ unit tests with generated keys.
- [x] Cron triggers: 4-hour backstop, stale-pending scan, daily maintenance Workflow. _Verify:_ integration tests invoking `scheduled()`.

## 4. API and UI (design Phase 4)

- [x] Hono API with session checks (originally Access JWT verification; passkeys since D-27), CSRF (JSON + custom header + Origin), Zod on every request, security headers. _Verify:_ integration tests incl. auth rejection.
- [x] Budget: month switcher, All / Needs attention, groups, statuses, card rows, Owed to you row, RTA bar, Assign sheet, Category sheet (assign/move/target). _Verify:_ component tests + Playwright against `wrangler dev` with the fake provider.
- [x] Activity: search, All / Needs attention / Not posted yet, categorize in place, select several, split, transaction sheets (pending, posted, income, refund, paid back), match, transfer pick, add expected/upcoming, check-pending. _Verify:_ Playwright.
- [x] Accounts: net worth, cash and cards, registers, Owed to you, repair prompt, health alerts. _Verify:_ Playwright.
- [x] Desktop layout (sidebar, budget table, side panel). _Verify:_ Playwright at 1280 × 800.
- [x] Themes: Light / Dark / Match device from one token set. _Verify:_ Playwright screenshots in both themes; contrast check on status colors.
- [x] States: offline (read-only), daily limit reached, failed sync, over-assigned, new month, first budget. _Verify:_ Playwright.

## 5. Settings, onboarding and data

- [x] First run: welcome, budget start, link banks (Item meter + confirm), make categories. _Verify:_ Playwright.
- [x] Settings: categories and groups (archive/restore), rules (preview, JSON export), payees (merge, rename), connections, import/export, appearance, tracking, note button. _Verify:_ Playwright + API tests.
- [x] CSV history import (history only) and full export (JSON + CSV). _Verify:_ integration tests.

## 6. Reports, net worth, reimbursements (design Phase 6)

- [x] Reports API (Spending, Invested, Income, Rewards, by category, trend, net worth); UI pending in phase 4 work.
- [x] Reports: month to date, Spent / Invested / Income / Rewards, spending by category net of paybacks, still owed line, drill-down. _Verify:_ domain tests + Playwright.
- [x] Owed to you: mark, match (split across items), close, cancel, unlink, expect-by, overdue. _Verify:_ domain property tests (rules 9, 11, 12) and the API integration test; Playwright with the UI.

## 7. Usage tracking

- [x] Server side: `POST /api/usage` (2,000/day cap, dropped from the breaker's 70% tier), notes, daily roll-up into `usage_daily`, 90-day prune, Export usage (JSON), delete on request.
- [x] Client buffer (30 s flush + `keepalive` on hide), `data-track` ids only, 2,000/day cap, breaker drop at 70%, `usage_event` table, daily roll-up into `usage_daily`, 90-day prune, Export usage (JSON), Note button, off switch with delete. _Verify:_ unit + integration tests; a test asserts no amounts/names can be recorded.

## 8. Backups, monitoring, operations (design Phase 5 prerequisites)

- [x] `/api/health` (statuses only), watchdog in `health_status`, Accounts alerts. _Verify:_ integration tests.
- [x] GitHub Actions: nightly backup (D1 export → age public key → Actions artifact with manifest, D-26), monitor every 6 hours, monthly keepalive. _Verify:_ `actionlint`; dry-run scripts tested locally.
- [x] Runbooks: first deploy, passkey setup, Plaid Production link, restore drill. _Verify:_ reviewed against the doc.
- [x] Create the two D1 databases (Nov 1, 2026; ids in `wrangler.jsonc`).
- [ ] **(manual)** Plaid keys, secrets, Cloudflare API tokens, GitHub environments and variables, first deploy (Actions → deploy) and first passkey (docs/runbooks/setup.md).

## 9. CI and supply chain

- [x] `ci.yml`: frozen install → lint, typecheck, format → unit → integration (local D1) → build → migration check → bundle budget → Playwright (fake provider). _Verify:_ green run on GitHub.
- [x] `security.yml` (CodeQL, Gitleaks, OSV-Scanner, dependency review, zizmor, actionlint), `deploy.yml` (production with approval, rollback; no staging, D-36), `release.yml`, `nightly.yml`, `monitor.yml`, `keepalive.yml`, Dependabot, CODEOWNERS, PR template; actions pinned to SHAs. _Verify:_ `actionlint` clean; CI green.

## 10. Durable Objects (decisions.md D-37, `docs/multi-user.md`)

- [x] D1-shaped adapter over Durable Object SQLite, per-object migrations, alarm job runner (sync, recompute, backstop, daily scan, maintenance).
- [x] Directory (sign-in, sessions, routing of Plaid Items) and one BudgetStore per budget; the Worker routes every API request through them.
- [x] Per-user identity: user ids on passkeys and sessions, per-user passkey handles, signed challenge cookies, sign-in rate limit.
- [x] Full backup on Import and export (every row, with per-table fingerprints), restorable into an empty store.
- [x] The owner's data moved (Nov 2, 2026, 8:07 UTC), checked row by row; production runs without D1 and Workflows; move code removed.
- [x] Tests, local dev and e2e on Durable Objects only (D-38): `wrangler.local.jsonc`, the Workflow classes, the D1 `api` path, D1 migrations and the D1 crons removed; one cron left. _Verify:_ `pnpm check` (100 Worker tests through the Directory and BudgetStore); Worker and passkey Playwright suites; `test/exports.test.ts` (workerd refuses non-function exports).
- [x] Step sizes match D-37 (apply and processing 25 events, recompute 2 months, in requests too). _Verify:_ Worker tests; `apps/worker/measure` re-run (`docs/measurements.md`).
- [x] The mock API and the Worker are checked against one list of screens and their schemas (`packages/contracts/src/screens.ts`). _Verify:_ `apps/web/test/mock-contract.test.ts` (every mock scenario), `apps/worker/test/screens.test.ts`.
- [x] Settings split by section: `apps/web/src/screens/settings/` and `apps/worker/src/routes/settings/` (no behaviour change). _Verify:_ `pnpm check`; mock and Worker Playwright suites.
- [x] Delete the empty `ledgerline` D1 database (D-38). _Verify:_ the account lists no D1 databases (Nov 2, 2026).
- [x] Breaker counts Worker requests and rests at 95% (D-40): reading stops too, saved screens stay on view, the Worker refuses by itself for 5 minutes; from 90% screens check every 15 minutes. _Verify:_ `apps/worker/test/breaker.test.ts`, `apps/worker/test/objects/routing.test.ts` (rests at 95%), `apps/web/test/client.test.ts`.
- [ ] Activity screen: check CPU on the real app's analytics; build a stored recent-rows list only if p95 is 8 ms or more.
- [ ] Later, only if wanted: invites, People with a reset link, Plaid link slots per user, account deletion, an isolation test (`docs/multi-user.md` 7.3, 7.4, 9.1, 10, 11).

## Follow-ups (not blocking go-live)

The UI works around these contract gaps (details in `apps/web/CONTRACT_NOTES.md`):

- [ ] Candidate deposits for an unclear transfer in the API (the UI searches other registers today).
- [ ] Endpoints: reopen an owed item, accept a changed amount, edit a manual entry's amount or date, unlink a refund, mark a transfer to an unlinked account by hand, create a payee from a rule.
- [ ] Extra fields: default selection on Assign suggestions, the new-month carry-over summary, recent paybacks, the repeat interval on upcoming rows, per-filter register counts, amounts on Move money options.
- [ ] Desktop: account registers in the side panel, and a per-row category dropdown in Activity.
- [x] Owner decisions D-11 and D-12 (decisions.md): both fixed, with property tests.
- [x] Owner decision D-25 (decisions.md): spending a card credit balance, fixed.

## No payment card (decisions.md D-26, D-27)

- [x] Raw Plaid pages in an append-only D1 table instead of R2 (migration 0002). _Verify:_ sync tests; 3,000-transaction backfill through the Workflow on local `wrangler dev`; CPU re-measured (fetch 1.2–1.4 ms, apply 3.1–3.4 ms).
- [x] Chunk SQL `IN` lists to D1's 100-parameter limit (found by the backfill). _Verify:_ regression test with 150 transactions and 100 payees, failing before the fix.
- [x] Backups as encrypted GitHub Actions artifacts (90 days), reported to the app with the ops token. _Verify:_ zizmor; script syntax; endpoint test.
- [x] Passkey sign-in in the Worker instead of Cloudflare Access (migration 0003): setup code, sessions, 15-minute check for banks/exports/passkeys, device links, ops token. _Verify:_ 11 Worker tests with a software passkey; Playwright with Chromium's virtual authenticator against the real Worker.
- [x] Sign-in, add-device and "Confirm it's you" screens; Settings → Sign-in. _Verify:_ Playwright (passkey, mock and Worker suites).
- [x] Setup from a phone (D-28): secrets in GitHub environments uploaded by each deploy, passphrase token keys, passphrase backups. _Verify:_ token-crypto tests; secrets-file script run with sample values; gpg encrypt/decrypt round trip; zizmor.
- [x] No off-site backup (D-29): backup job, script and endpoint removed; health and monitor no longer need a backup; monitor alert only after the monitor's first check. _Verify:_ Worker tests (ops token, monitor check), web tests.
- [x] A new bank link is saved before its accounts are set up (migration 0005 `setup_done`); a failure in between shows Finish setup on Bank connections and never uses another link; syncs skip unfinished links. _Verify:_ `apps/worker/test/link.test.ts` with Plaid failing once.
- [x] Cut database reads after the account hit the free daily read limit: cheap `/api/badges`, Activity attention skips unused scans, 2-minute freshness. _Verify:_ `apps/worker/test/read-cost.test.ts`.
- [x] Heavy screens read only rows that matter to the budget (migration 0006: date and pending indexes, split views, key lookups, windowed Activity list, one card statement per day). _Verify:_ `read-cost.test.ts` limits per request and pages the whole Activity list.
- [x] Unchanged screens answer 304 (ETags from `data_version` and the sync/recompute counters, migration 0007), the app saves its data on the device (cleared on sign-out), and categorizing adjusts counts locally instead of refetching. _Verify:_ `apps/worker/test/etag.test.ts`; Worker and passkey Playwright tests.
- [x] Stored month totals per account for Accounts and Reports (migration 0008), cleared by every writer of bank rows. _Verify:_ stored totals equal a full recount through syncs (`sync.test.ts`), read limits (`read-cost.test.ts`).
- [x] Quarterly and yearly refill targets are met in their Due month, and a period already under way spreads over the months left (D-31, migration 0009). _Verify:_ `targets-status.test.ts`; Worker Playwright target test.
- [x] Pending: money you add can go straight to Ready to Assign; amounts you added can change; any bank pending row takes your estimate (typed without a sign, cleared to go back to the bank amount). _Verify:_ `apps/worker/test/pending-edits.test.ts`; Worker Playwright pending test.
- [x] Assign lists an overspent category that also has a target once, for the larger of the two amounts (a target's need already funds the month's spending). _Verify:_ `apps/worker/test/pending-edits.test.ts`.
- [x] Low only for monthly spending categories (D-32): yearly funds and goals on plan no longer show in Needs attention. _Verify:_ `targets-status.test.ts`.
- [x] Ready to Assign at $0 shows a quiet "All money assigned" line with no Assign button (phone bar and desktop sidebar). _Verify:_ mock Playwright.
- [x] Rename an account from its register (a card's payment category follows; syncs never change names). _Verify:_ `categories.test.ts`; Worker Playwright rename test.
- [x] Low has its own Budget filter beside Needs attention (which no longer lists Low). _Verify:_ mock and Worker Playwright fix tests.
- [x] Budget order: your groups, then Credit card payments, then Owed to you (phone and desktop). _Verify:_ mock Playwright order test.
- [x] Phone UI review fixes (D-33): Add in the Activity header (no floating button over rows), see-through sheets with swipe-down, one category picker with search everywhere, Home Screen install and safe areas, gray to-do counts, quiet funded rows, deep blue Ready to Assign bar in dark mode, Take back when it's below zero, shorter banners, More row on transactions, stacked rule editor with Save pinned, account ⋯ menu, gear on Budget. _Verify:_ mock and Worker Playwright; `apps/web/test/screens.test.tsx`.
- [x] Fixes from usage data (D-34): Set targets list, saving a target returns to Budget, new kind starts empty, Add category per group and Add and set a target, remove on the category sheet, Assign Clear all / Select all, rage taps say what was hit, shorter setup step 1, Owed and card notes, paycheck money-back row, a warning when 3 or fewer bank links are left. _Verify:_ mock Playwright (targets, target kind, add category, Assign) and Worker Playwright categories test; `apps/web/test/usage.test.ts`.
- [x] Categories move under Budget (D-35): own page with Back to Budget, drag handles always on (touch, mouse and arrow keys), group rename and remove on the group's sheet, gear only on Accounts, old Settings links redirect. _Verify:_ mock Playwright categories tests; Worker Playwright drag test.
- [x] The page never scrolls as a whole on a phone (no rubber-band drag from the tab bar); Budget's hidden status labels no longer made the page taller than the screen. _Verify:_ mock Playwright "No screen is taller than the phone".
- [x] Design review fixes (D-39): row text matches the bar ("left of"), bar contrast, labeled group totals, quiet desktop rows, no red card balances or green to-dos, hidden empty filters, stacked Activity action rows, clearer Owed warning, Reports year and cents, unsqueezed buttons. _Verify:_ `pnpm check`; mock Playwright `app.spec.ts`; Worker Playwright budget, Needs attention, Activity and Accounts tests.

## 11. Whole-app review fixes (Nov 2, 2026)

- [x] Quick fixes: Plaid webhooks pass the CSRF check (they were refused with 403, so a bank needing sign-in was never flagged); the web app's security headers (`apps/web/public/_headers`: CSP, frame-ancestors, HSTS) that the threat model already listed; a Plaid error a retry can't fix ends the sync at once and marks a bank needing sign-in for repair; webhook signing keys cached once per isolate (unknown key ids for 10 minutes); a new budget gets its recurring jobs when it's created; a removed connection's lease can't be renewed; a broken sign-in body is a 400; the local sign-in shortcut is off wherever a setup code exists; the unused freeze switch removed; spec rule 5 notes D-25. _Verify:_ `test/webhook.test.ts` (fails without the CSRF fix), `sync-job.test.ts`, `objects/auth.test.ts`, bank-provider webhook tests; Worker Playwright "security headers" test with no CSP violations.
- [x] Background jobs: adding a job whose fixed id failed for good starts it again (a bad day could stop `recompute`, `register_link:<id>` or `ensure_all` for ever); the daily prune drives from `sync_page` and removes jobs that failed over 30 days ago. A run that fails partway through applying and is applied again from the stored cursor leaves the budget exactly as one clean run (bank history stays append-only by design). _Verify:_ `jobs.test.ts`, `budget-store.test.ts` maintenance test, `sync-job.test.ts` replay test.
- [x] Deploys and safety: a request with no session cookie is refused in the Worker without a Durable Object request; `deploy.yml` deploys only `main`, and only after this commit's `ci` run passed (`tools/ci/wait-for-ci.mjs` waits while it runs); a deploy keeps the Worker's `TOKEN_KEYS` and `TOKEN_KEY_CURRENT` unless `ROTATE_TOKEN_KEYS` is `true` (setup runbook); new migrations must be expand-only (`tools/ci/expand-only.mjs`: no DROP or RENAME unless marked as the second release of a removal). _Verify:_ `objects/routing.test.ts`, `expand-only.test.ts`, `migration-check.mjs`; `worker-secrets.mjs` run with and without an existing key.
- [x] The app on the phone: an open app reloads when the server runs a newer release (`state/version.ts`, the deploy builds the web app with the commit as `APP_VERSION`; at most once per release, never while typing); after a dropped request it checks the network again on its own (5, 15, 30, then 60 seconds, and when shown again); the same change sent twice within 2 seconds (a double tap) is sent once; saved screens that don't fit the phone's storage leave out the largest first; `lenient.ts` removed (the contract's rule schemas parse). CSV import refuses "12,50" and dates that aren't real days; `parseCents` reads "(12.00)". Two equal transfer-like outflows with one matching inflow both ask instead of pairing whichever came first. The web unit tests now run in `pnpm check` and CI (`test:unit` never included them; one had gone stale). _Verify:_ `apps/web/test/{version,client,saved}.test.ts`, `packages/domain/test/money.test.ts`, `rules-matcher.test.ts`; mock and Worker Playwright suites.
- [x] Restore, tests, loading and offline: each piece of a backup restore is written in one transaction (a failed piece adds nothing and can be sent again); the e2e suites wait for saved data and finished animations instead of fixed sleeps; Reports, Settings, Categories and first-run setup load when first opened; offline start (D-42): a service worker keeps the app's files, and the last confirmed session opens the saved screens view-only when the server can't be reached (never after a "signed out" answer). _Verify:_ `backup.test.ts` retry test; `apps/web/test/session.test.tsx`; Worker Playwright "Opens with no signal"; screenshots suite.
