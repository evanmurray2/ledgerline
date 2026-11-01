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
- [x] Months and time zone: budget month math in America/Los_Angeles without a date library. _Verify:_ property tests (round trips, DST boundaries).
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
- [x] `security.yml` (CodeQL, Gitleaks, OSV-Scanner, dependency review, zizmor, actionlint), `deploy.yml` (staging → production with approval, rollback), `release.yml`, `nightly.yml`, `monitor.yml`, `keepalive.yml`, Dependabot, CODEOWNERS, PR template; actions pinned to SHAs. _Verify:_ `actionlint` clean; CI green.

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
- [x] Setup from a phone (D-28): secrets in GitHub environments uploaded by each deploy, passphrase token keys, passphrase backups, optional staging. _Verify:_ token-crypto tests; secrets-file script run with sample values; gpg encrypt/decrypt round trip; zizmor.
- [x] No off-site backup (D-29): backup job, script and endpoint removed; health and monitor no longer need a backup; monitor alert only after the monitor's first check. _Verify:_ Worker tests (ops token, monitor check), web tests.
- [x] A new bank link is saved before its accounts are set up (migration 0005 `setup_done`); a failure in between shows Finish setup on Bank connections and never uses another link; syncs skip unfinished links. _Verify:_ `apps/worker/test/link.test.ts` with Plaid failing once.
- [x] Cut database reads after the account hit the free daily read limit: cheap `/api/badges`, Activity attention skips unused scans, 2-minute freshness. _Verify:_ `apps/worker/test/read-cost.test.ts`.
- [x] Heavy screens read only rows that matter to the budget (migration 0006: date and pending indexes, split views, key lookups, windowed Activity list, one card statement per day). _Verify:_ `read-cost.test.ts` limits per request and pages the whole Activity list.
- [x] Unchanged screens answer 304 (ETags from `data_version` and the sync/recompute counters, migration 0007), the app saves its data on the device (cleared on sign-out), and categorizing adjusts counts locally instead of refetching. _Verify:_ `apps/worker/test/etag.test.ts`; Worker and passkey Playwright tests.
- [x] Stored month totals per account for Accounts and Reports (migration 0008), cleared by every writer of bank rows. _Verify:_ stored totals equal a full recount through syncs (`sync.test.ts`), read limits (`read-cost.test.ts`).
