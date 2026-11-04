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
- [x] GitHub Actions: nightly backup (D1 export → age public key → Actions artifact with manifest, D-26), monitor every 6 hours, monthly keepalive. _Verify:_ `actionlint`; dry-run scripts tested locally. (Backup removed in D-29; monitor and keepalive removed in D-49.)
- [x] Runbooks: first deploy, passkey setup, Plaid Production link, restore drill. _Verify:_ reviewed against the doc.
- [x] Create the two D1 databases (Nov 1, 2026; ids in `wrangler.jsonc`).
- [ ] **(manual)** Plaid keys, secrets, Cloudflare API tokens, GitHub environments and variables, first deploy (a merge to `main`) and first passkey (docs/runbooks/setup.md).

## 9. CI and supply chain

- [x] `ci.yml`: frozen install → lint, typecheck, format → unit → integration (local D1) → build → migration check → bundle budget → Playwright (fake provider). _Verify:_ green run on GitHub.
- [x] `security.yml` (CodeQL, Gitleaks, OSV-Scanner, dependency review, zizmor, actionlint), `deploy.yml` (production, rollback; no staging, D-36; merges to `main` only, no manual trigger, D-49), Dependabot, CODEOWNERS, PR template; actions pinned to SHAs. _Verify:_ `actionlint` clean; CI green. (`release.yml`, `nightly.yml`, `monitor.yml` and `keepalive.yml` removed, D-49.)
- [x] CodeQL's two open alerts fixed: the usage session id falls back to `crypto.getRandomValues` (never `Math.random`), and `centsToInput` strips every `$`. _Verify:_ CodeQL code-scanning suite finds none locally.

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
- [x] Recovering from a day over the free limit (Nov 3, 2026): the Directory and each BudgetStore retry a failed start on the next call instead of refusing until evicted, and the deploy smoke test keeps a release when the only failure is Cloudflare's daily limit (the old release needed the deleted D1 database, so rolling back to it could never help).
- [x] Refresh on Accounts (design.md, When data updates; it was in the design but never built): pull down on a phone, or tap the sync icon next to the gear; Refresh on desktop. Syncs every set-up bank from what Plaid has already collected; skips banks needing repair and banks synced or tried in the last minute. _Verify:_ `apps/worker/test/link.test.ts`, e2e `Accounts: Refresh syncs every bank`.
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
- [x] Refunds of split purchases (D-43): a linked refund gives back the funded part of every line of the purchase; a split refund keeps its link; the daily scan rebuilds refund lines saved without it. _Verify:_ `money-rules.property.test.ts` (the $100 split example fails before the fix; the card-debt invariant now includes split purchases and split refunds).
- [x] Exports on Import and export download through the app (Nov 3, 2026): a plain link saved the server's "Confirm it's you" refusal as the file once the 15-minute passkey check had passed, and never asked for the passkey. Now the refusal opens Confirm it's you and the file is saved only when the export is allowed; downloads are freed a minute later for Safari on iPhone. _Verify:_ `apps/web/test/client.test.ts` (download), Worker Playwright "Exports: Usage and notes downloads as a JSON file" and the full backup test.

## 12. Desktop design review fixes (Nov 3, 2026)

- [x] One desktop header and content width on every screen; Assigned typed straight into the Budget table, whole rows clickable with hover, group totals, and a narrow layout when a side panel opens; the More menu instead of wrapped header links; one Assign button (the sidebar card); up and down through categories in the panel; `[` `]` and `/` shortcuts; quieter Needs attention amounts; badge counts on every filter; switches in Settings; compact Owed to you buttons; desktop wording and 13 px details (D-44). _Verify:_ `e2e/tests/app.spec.ts` ("Desktop: type into Assigned…" and "Desktop: the category panel steps…").

## 13. Budget on the phone (D-45, D-46, `docs/phone-budget.md`)

Built all at once on the owner's word (D-46): no settings and no shadow comparison.

- [x] Server: `change_log` written by triggers on every synced table (migration 0003), `GET /api/sync` (full download in key order, then changes), sync epoch in the Directory (migration 0006) changed by every restore, `POST /api/settings/restore`. _Verify:_ `test/engine.test.ts` (triggers on every table, server answers without Ready to Assign); `measure/phone.measure.ts` (pages 3.6 ms median, 7.8 ms max).
- [x] The server keeps nothing derived (`budget/derived.ts`): no budget lines, month snapshots, totals or Ready to Assign; screen reads answer 404 `on_device`; archiving takes the phone's amount with its change number. _Verify:_ `test/engine.test.ts`.
- [x] The phone's engine (`apps/worker/src/local`) runs the server's own routes on sql.js in a Web Worker. _Verify:_ `test/engine.test.ts`: 11 screens equal to the server's after a full download and after changes; Worker e2e (24) with every screen from the engine.
- [x] Devices: `device` table, server share, Turn off in Settings → Sign-in, Sign out other devices turns their copies off; `not_member` answer. _Verify:_ `test/objects/routing.test.ts`.
- [x] Settings → Sign-in shows only real other devices: this phone is listed as "This phone" with no Turn off, "Sign out other devices" appears only when another sign-in or another phone's copy exists and says what it will end, and a new passkey sign-in on a browser replaces that browser's earlier session (unlocking the copy signs in each time). _Verify:_ `test/objects/auth-users.test.ts`.
- [x] Settings → Sign-in lists every sign-in by device and browser ("iPhone · Safari", from the User-Agent; only the name is sent), this one marked "This device", each other one with Sign out (`POST /api/settings/security/sign-out-session`). "Sign out other devices" shows only for two or more other sign-ins or another phone's copy. _Verify:_ `test/objects/auth-users.test.ts`, `test/agent.test.ts`.
- [x] Encrypted copy on an iPhone or iPad, in Safari or the Home Screen app (D-48): passkey PRF + server share, AES-GCM, offline unlock for 7 days, lock after 10 minutes, wipe on sign-out, revoke or not a member; plain saved screens off and deleted. _Verify:_ passkey e2e (copy is ciphertext, opens with no signal, replaced after Turn off).
- [x] Offline edits for a short list (categorize, a transaction's details, assign, targets), sent later with edit ids and edit times; moved transaction keys followed; those controls stay on offline and the banner counts what's waiting. _Verify:_ Worker e2e "A change made with no signal…" (shown at once, 1 waiting, on the server once back online).
- [x] CSP: WebAssembly for SQLite, workers from this site, Plaid API hosts only. _Verify:_ `apps/web/test/headers.test.ts`; Worker e2e security headers.
- [x] Bank pending rows without the provider's link are claimed by their posted rows in either order, hidden once claimed, and won't clear never hides a posted charge (D-47). _Verify:_ `packages/domain/test/bank-pending.test.ts` (cases from the owner's Atmos Summit rows), `apps/worker/test/pending-match.test.ts` (every order through the sync pipeline).
- [ ] A way to match a pending row to a posted row by hand, and a screen for `ambiguous_match` and `vanished_pending` alerts (the alert table is not shown anywhere yet).
- [x] Unlocking with no signal opens the budget (it showed "Couldn't reach Ledgerline": the copy's saved session wasn't watched). _Verify:_ passkey e2e checks the budget opens after an offline unlock (fails before the fix).
- [x] Faster screens after a sync: the phone rebuilds only the changed transactions' lines and recomputes from the earliest month touched, instead of everything from the budget start. _Verify:_ `test/engine.test.ts` (splits, a new pending row, moved money and an undone split, compared with the server).
- [x] A copy the phone can't decrypt starts over instead of failing ("The operation failed for an operation-specific reason" on the owner's iPhone): online, the old device is turned off and a new copy downloads; offline, the message says which step failed and to go online. Unlocking only uses a sign-in whose PRF salt matches the copy's. _Verify:_ `apps/web/test/vault.test.ts` (named steps, salt check). Root cause on the iPhone still to confirm.
- [x] Drop `budget_line`, `month_snapshot`, `account_month_total` and `month_total_done` on the server (migration 0006, Nov 3, 2026). The phone's copy skips that migration and creates the four tables itself (`PHONE_TABLES`); a restore skips their rows in older backups. _Verify:_ `store.test.ts`, `backup.test.ts`, `engine.test.ts`; `e2e (worker)`.
- [ ] On the owner's iPhone after deploy: PRF in the Home Screen app with the existing passkey, first download time, Face ID unlock with no signal.
- [ ] The mock API (`apps/web/src/mock`) still has its own engine for the mock tests; replace it with a sample sync dataset fed to the real engine.

## 14. Passkey check and pull to sync (Nov 3, 2026)

- [x] Confirm it's you carries on by itself: a request refused for want of the 15-minute passkey check waits while the dialog asks for the passkey, then is sent again (`api/client.ts` `setPasskeyCheck`), so linking a bank, exports and passkey changes no longer have to be done twice. Requests refused together share one check; Not now gives up as before. _Verify:_ `apps/web/test/client.test.ts` (passkey check, download).
- [x] Syncing banks now (pull to sync, the sync button, Try again, Finish setup) no longer needs the passkey check: it only fetches what Plaid already has (D-27 lists linking, repairing, exports and passkeys). _Verify:_ `apps/worker/test/objects/auth.test.ts`.
- [x] Pull to sync follows the finger without re-rendering the screen (transforms on the list and indicator, a rubber-band pull, about 110 px of finger to trigger). After letting go the indicator stays up saying Syncing banks… and the list is checked every 2.5 s until each bank that started has synced or failed (at most 45 s), then shows Up to date; the old toast said to wait a minute or two and nothing moved for 30 s. _Verify:_ e2e `Accounts: Refresh syncs every bank`.

## 15. Fixes (Nov 3, 2026)

- [x] Activity → Check these: OK on a bank transaction that cleared at a new amount now clears it. It used to send "keep waiting", which only applies to an entry you added, so the server refused it and the row stayed. OK now marks the alert reviewed (`POST /api/transactions/:key/review`, which also records it in the audit log), and the mock API refuses "keep waiting" on bank rows as the server does. _Verify:_ `apps/worker/test/api.november.test.ts` "Check these: OK…", `e2e/tests/worker.spec.ts` "OK on a bank row…".
- [x] Pending rows left beside their cleared rows (D-50): a date, phone number or reference code in the pending description no longer stops a posted row from claiming it; only store numbers on both sides must agree. The next sync heals earlier misses. _Verify:_ `packages/domain/test/bank-pending.test.ts` (store numbers), `apps/worker/test/pending-match.test.ts` (heal).
- [x] Scheduled jobs trimmed (Nov 3, 2026): the daily scan no longer queues a recompute job on the server, where it found nothing to do since D-45 (it still does where totals are worked out, as in the tests), and migration 0005 adds a partial index on orphaned overlay rows so the vanished-pending check reads only those instead of every categorized transaction each day. _Verify:_ `apps/worker/test/store.test.ts` (migrations list); `EXPLAIN QUERY PLAN` of the check shows `SEARCH o USING INDEX txn_overlay_orphaned`.
- [x] Reports → a category now shows its transactions: Activity's search matches category names (split lines included) as well as payees and amounts. Reports opened Activity searching for the category's name, which only matched payees, so the list was empty. _Verify:_ `apps/worker/test/api.november.test.ts` (Reports → Activity), and `engine.test.ts` checks the phone's answer to a category search.
- [x] Sessions watch CI and deploys instead of guessing with timers: `tools/ci/watch-runs.mjs <sha> ci [deploy]` polls the commit's Actions runs and exits as soon as each has finished, with its result (`CLAUDE.md`). _Verify:_ run against a merge commit whose `ci` and `deploy` passed, it prints both and exits 0.
- [x] Desktop budget shows spending at a glance (Nov 3, 2026): each category row has the phone's bar under its name, the status word is coloured with its icon (it was grey text), Spent reads dark with "N% used" beneath it while $0.00 fades back, group rows stand apart, and the Assigned field has a light fill so the column you type in differs from Spent. _Verify:_ e2e `Budget shows Ready to Assign and the November groups` (desktop).
- [x] No more "Can't read from request stream after response has been sent" in the Worker's log: a Durable Object answering a POST without reading its body (`/api/auth/login/options`, sign-out and device link refused before signing in) left the body streaming in after the answer. The Directory and each BudgetStore now read whatever body the answer left unread before returning it (`store/body.ts`). _Verify:_ `apps/worker/test/body.test.ts`; passkey e2e output has none (it had about 8 per run).

## 16. Merging without rebasing (D-51, Nov 3, 2026)

- [x] Sessions merge once their PR's `ci` passed and GitHub shows no conflict; the `ci` run on `main` gates every deploy, and sessions catch up with "Update branch" instead of rebasing (`CLAUDE.md`). _Verify:_ the next merges go in without a rebase.
- [x] New decisions are one file each in `docs/decisions/`, numbered just before merging (`tools/docs/next-decision.mjs`); `docs/build-plan.md` merges with `merge=union`. _Verify:_ `node tools/docs/next-decision.mjs` prints D-52 after this merge.
- [x] A deploy whose `ci` a newer merge cancelled is skipped, not failed (`tools/ci/wait-for-ci.mjs`, `deploy.yml`). _Verify:_ the gate run against stubbed GitHub responses (passed → deploy, cancelled and superseded → skip, cancelled while latest or failed → fail); then the next pair of quick merges.

## 17. One sign-in list (D-52, Nov 3, 2026)

- [x] "Phones with a copy" and its Turn off are gone from Settings → Sign-in. A phone with a saved copy is listed with the sign-ins ("Locked · last opened …", "budget saved on it"); signing it out, or Sign out other devices, turns its copy off, and the phone deletes it when it next opens online (`/api/auth/copy-status`), before showing anything. Sign out of this device deletes the phone's copies first. _Verify:_ `test/objects/routing.test.ts`; passkey e2e.
- [x] Reopening a phone with a saved copy downloads only what changed since the last sync, not every transaction. _Verify:_ passkey e2e checks the sync after a lock starts from `since > 0`.
- [x] Find why the owner's device downloads the whole budget on every open (about 2,300 rows) instead of only changes. The loading screen now says why it's downloading everything, and the server logs the same reason (`sync_full`, `why`). _Verify:_ passkey e2e checks a reopen sends no `why` and a fresh copy sends `first`.
- [x] Computers keep the encrypted copy too (D-53): the device that downloaded everything on every open was a computer (`sync_full` logged `why: memory`); it now reopens downloading only what changed. _Verify:_ passkey e2e, run on a desktop browser, checks a reopen syncs from `since > 0`.
- [ ] Find why the owner's iPhone downloads the whole budget on every open (about 2,300 rows) instead of only changes. The loading screen now says why it's downloading everything, and the server logs the same reason (`sync_full`, `why`). _Verify:_ passkey e2e checks a reopen sends no `why` and a fresh copy sends `first`.

## 18. Cleanup (Nov 3, 2026)

- [x] Removed the old workerd measuring tools (`tools/measure`, the `/__measure` routes, `MEASURE`); measuring runs `apps/worker/measure` on node:sqlite. The November seed moved out of the measure folder. CLAUDE.md asks sessions to split large files as they touch them. _Verify:_ `pnpm check`.
- [x] The code runs one way: the `derived` switch and `LOCAL_ENGINE` are gone. Routes, the sync job, the daily scan, maintenance and the November seed only store what was entered; the phone's engine works out lines, months and Ready to Assign after every sync and every offline edit. A `recompute` job left in a store finishes at once. Worker tests read screens through the engine (`test/phone.ts`) and check the engine against a fresh copy (`engine.test.ts`), offline edits included. The server's recompute measurement went with it. _Verify:_ `pnpm check`; `e2e (worker)`.
- [x] No D1 API left: the app's SQL goes through its own small interface over SQLite (`packages/db/src/sql.ts`: `Db`, `Stmt`, `Result`), with one shared statement and batch implementation and three thin adapters (a Durable Object's SQLite, sql.js on the phone, node:sqlite for measuring). Gone: the `D1Database` types, D1's error prefixes and parameter checks, `raw()`, unused result fields, the node adapter's copy of the D1 client's JSON round trip, and D1 rows in the usage query. _Verify:_ `pnpm check`; measure suite; `e2e (worker)`.
- [x] No ETags: screens are read from the phone's copy, so the server's conditional GETs only covered the connections list, and on the phone every screen paid an extra query for a tag nothing checked. The data version stays (`http/version.ts`): the phone's stored month totals are stamped with it. _Verify:_ `pnpm check`; `e2e (worker)`.
- [x] The CI watcher (`tools/ci/watch-runs.mjs`) reports a PR's merge conflict with `main` (GitHub runs no CI then) and a run that never starts, instead of waiting; `CLAUDE.md` says to start it after every push. _Verify:_ run against a commit with no runs: it exits 1 with "no ci run started".
- [x] A refresh, or the phone restarting the app, no longer locks: within 10 minutes of the last activity the copy reopens without Face ID, using its data key held in IndexedDB (non-extractable; deleted on lock, sign-out and wipe). _Verify:_ passkey e2e reloads an open copy and checks there's no lock screen and no new sign-in.
- [x] Activity hides a filter chip with nothing in it (Needs attention at 0, Not posted yet with no pending or upcoming rows) unless it's the one showing, and hides the chip row when neither is left, as Budget already did. `ActivityView.notPostedCount` carries the count. On a phone, Set targets moved from the bottom of the Budget into the ⋯ menu at the top, next to Edit categories. _Verify:_ `screens.test.tsx`; `app.spec.ts` "Categories open from Budget".
- [x] `docs/design.md` and `docs/sync-spec.md` open with "What's true now": what later decisions replaced (Durable Objects, alarm jobs, the phone working out the budget, passkeys, no R2 or backups, no staging, deploys on merge), and each replaced section starts with a **Now** note naming the decision. The Money rules are unchanged. CLAUDE.md points sessions there first. _Verify:_ `pnpm check` (format).
- [x] Signing in right after a release asked for Face ID twice (sign in, then Unlock): the app reloaded for the new release before the copy opened, losing the key the sign-in's Face ID had just returned. It now waits until the copy is open (its key is then held for a refresh), so the reload reopens it without Face ID. _Verify:_ `apps/web/test/version.test.ts`.
- [x] The filter chip rows (Activity, an account's register) no longer show a scroll bar: the chips' 44 px touch targets stuck out of the row, so it scrolled up and down. The row (`.chip-row`) now has room for them and hides its sideways scroll bar; it still swipes when the chips don't fit. _Verify:_ `app.spec.ts` "the filter chips row has no scroll bar".
- [x] A failed e2e run in CI leaves a report to read: each suite (mock, Worker, passkey) writes an HTML report with the error, a screenshot and a trace (`e2e/report.ts`), and the Worker's own log lines show in the CI log. `ci.yml` uploads `e2e/playwright-report` and `e2e/test-results` as the `playwright-report-<suite>` artifact; before, the folder was never written, so nothing was uploaded. Prompted by a one-off passkey e2e failure on `main` (Nov 3) that left nothing to go on. _Verify:_ a deliberately failing test run with `CI=1` writes `playwright-report/mock/index.html` and a screenshot.

## 19. Design consistency (D-54, `docs/design-review.md`, Nov 3, 2026)

- [x] Set targets is a page like Categories (`/targets`, Back to the Budget's month); a category's target opens as a sheet over it, in the side panel on a computer. Old `/budget/targets` links redirect. `screens/Targets.tsx` split out of `BudgetSheets.tsx`. _Verify:_ `app.spec.ts` "Set targets: a page like Categories…" and "old links…".
- [x] One header action style (`HeaderAction`): Add on Activity, Refresh on Accounts (no longer a bare icon on a phone), New rule on Rules. _Verify:_ `app.spec.ts` "Accounts: Refresh syncs every bank…".
- [x] The rest of the review (D-55), the same on a phone and a computer. Shared pieces in `components/` (`ui.tsx` split into `buttons.tsx` and `headers.tsx`): `PhoneHeader` and `BackHeader` at 56 px with chips in the header, one `OverflowMenu` (Register's own menu is gone), pills in three tones (`SoftButton`/`SoftLink`), `TextButton`, `DangerLink` + `ConfirmInline`, `Banner` with an icon and a link, `EmptyNote`, `SearchField`, `ScreenBody`, `MonthSwitcher` (Budget and Reports), `SheetTitle` with an amount, `Frame`, one Rename payee sheet. Removing a category, group, rule, target or passkey, deleting a transaction and signing out a device all ask first (signing out this device says it deletes the saved budget). Sheets keep their main button in the footer. Register's chips moved into its header with count badges. Late is the same orange everywhere and "sign in again" the same yellow. Copy: Sync, Add rule/group/line/condition, Done. Needs category rows show + and green for money in (display only). Large files split by feature (`Budget*.tsx`, `Txn*.tsx`, `Activity*.tsx`, `Account*.tsx`). _Verify:_ `pnpm check`; the whole mock e2e suite (227 passed) and the Worker e2e suite (32 passed) locally; `app.spec.ts` "Rename payee: the same sheet…".
- [x] The passkey e2e no longer fails now and then on its first screen (twice on `main`, Nov 3). Its first failure report showed the server had answered "setup open", but the screen showed "Sign in": when the app learns it's signed out it drops what it holds in memory, and that also dropped the sign-in screen's own check if it was in flight or just answered. That check now stays. A timing probe stuck on "Sign in" in 6 of 123 page loads before the fix and 0 of 82 after. _Verify:_ `e2e/tests/passkey.spec.ts`. A unit test covers it: `apps/web/test/session.test.tsx` "signed out".
- [ ] Payees and categories, suggest then OK (`docs/payees.md`, agreed Nov 4): 1. suggested category with OK and OK all; 2. remove rules (the owner has none); 3. Payees page without history-only payees, rename = merge with Undo, offline rename by payee id; 4. "New" payees and the suggested Join.
