# Build plan

Every phase in `docs/design.md` (Risks, open questions and plan → Build plan) broken into steps, each with how it is verified. Work runs in the order the owner set: go/no-go first, then the domain package and the November fixture, then the remaining phases. A phase is done only when its tests pass. Ticked boxes are done and verified; decisions taken along the way are in `docs/decisions.md`.

Legend: `[x]` done and verified · `[ ]` not done · **(manual)** needs the owner (Cloudflare, Access, Plaid Production, GitHub settings).

## 0. Design in the repo

- [x] Export Design tab → `docs/design.md`, Sync spec tab → `docs/sync-spec.md`. *Verify:* byte-for-byte Markdown export from Claude Docs.
- [x] Copy prototype screens and `canvas.json` → `docs/prototype/`, README lists every board. *Verify:* 53 screen files + canvas.json present; README generated from canvas.json board titles.

## 1. Foundations and go/no-go (design Phase 1)

- [x] pnpm monorepo skeleton: `apps/web`, `apps/worker`, `packages/{domain,contracts,db,bank-provider,platform}`, `e2e`; strict TypeScript, ESLint, Prettier. *Verify:* `pnpm -r typecheck`, `pnpm lint` clean.
- [x] Go/no-go harness on local `wrangler dev`: sync Workflow (fetch step + apply step) against a Plaid-shaped mock (no Sandbox keys available; D-4); CPU per step measured with workerd's V8 CPU profiler. *Verify:* `docs/measurements.md` — 500 and 250 per page did not fit; redesigned (R2 raw pages, projection in D1, 100 per page in 50-event steps; D-5–D-7) to ~2 ms fetch and ~5 ms apply; 3,000-transaction backfill ran end to end in 109 steps and 30 Plaid calls.
- [x] Assignment edit in the first budget month with 36 months × 60 categories: CPU, D1 queries, rows written. *Verify:* `docs/measurements.md` — about 20 ms as one recompute, so the recompute is chunked at 6 months (2.3–2.75 ms each, 4 D1 calls, about 50 rows written per first-month edit; D-21, D-22).
- [x] Fence tests in local D1: apply batch rolls back when the lease is released, expired, held by another run, or the connection row is missing; processing batch rolls back when the watermark moved; version fence. *Verify:* integration tests.
- [x] D1 export row-read estimate on the 36-month dataset. *Verify:* about 30,000 rows (< 1% of the daily read limit) in `docs/measurements.md`; the first nightly manifest confirms it.

## 2. Domain core (design Phase 2) — `packages/domain`

- [x] Money: branded integer cents, parse/format, no floats (lint rule). *Verify:* unit + property tests.
- [x] Months and time zone: budget month math in America/Los_Angeles without a date library. *Verify:* property tests (round trips, DST boundaries).
- [x] `computeBudget()`: the only Ready to Assign implementation; carry-forward with Money rules 1–9, 11, 12; snapshot start for incremental recompute. *Verify:* property test per rule; incremental-from-snapshot equals full recompute (property).
- [x] Rule 10 identity checker, asserted in tests and in the daily recompute. *Verify:* property test over random ledgers.
- [x] Rule 13 projected fronts; funding statuses (Overspent, Underfunded, Funded, Overfunded, Low, Covered/Short, Invested, Late/Tracking). *Verify:* unit + property tests.
- [x] Targets: Refill, Set aside, Balance by date, Balance no date; versioned. *Verify:* property tests for each formula and the remainder-to-last-month rule.
- [x] Rules engine (conditions, actions, first match wins, never overwrite user). *Verify:* unit + property tests.
- [x] Pending and re-issue matcher; transfer pairing. *Verify:* unit tests per table row in Matching mechanics.
- [x] Payee normalizer (clean, key, cluster). *Verify:* unit tests with the doc's examples.
- [x] Budget lines: logical transactions + overlay → the lines `computeBudget()` consumes (pending, won't-clear, splits, owed parts, close/cancel, Waiting to match, transfers, history before `budget_from`). *Verify:* unit + property tests.
- [x] **Canonical November fixture** reproducing the prototype's numbers, kept as a permanent regression test. *Verify:* `packages/domain/test/november.test.ts` asserts every listed number.

## 3. Bank layer (design Phase 3)

- [x] D1 schema and forward-only migrations (all layers + Sync spec additions; `bank_event` immutability trigger; `lease_guard`; `v_transaction`). *Verify:* migrations apply to a fresh local D1 and to the previous schema in CI; trigger test.
- [x] Budget-scoped data-access layer (every query requires a budget id checked against membership). *Verify:* integration tests.
- [x] `BankDataProvider` port with the Plaid adapter (plus a Plaid-shaped local mock for development and tests) and CSV history import; sign flip test; 180-day `days_requested` test. *Verify:* unit tests.
- [x] Sync Workflow: lease acquire/renew/fence/release/hand-off, staged fetch with restart, page apply with `apply_seq`, adopt, watermark post-processing, write breaker. *Verify:* integration tests on local D1 + Workflows.
- [x] Plaid webhook verification (ES256 JWT, body hash, 5-minute `iat`), starts a sync only. *Verify:* unit tests with generated keys.
- [x] Cron triggers: 4-hour backstop, stale-pending scan, daily maintenance Workflow. *Verify:* integration tests invoking `scheduled()`.

## 4. API and UI (design Phase 4)

- [x] Hono API with Access JWT verification, CSRF (JSON + custom header + Origin), Zod on every request, security headers. *Verify:* integration tests incl. auth rejection.
- [ ] Budget: month switcher, All / Needs attention, groups, statuses, card rows, Owed to you row, RTA bar, Assign sheet, Category sheet (assign/move/target). *Verify:* component tests + Playwright against `wrangler dev` with the fake provider.
- [ ] Activity: search, All / Needs attention / Not posted yet, categorize in place, select several, split, transaction sheets (pending, posted, income, refund, paid back), match, transfer pick, add expected/upcoming, check-pending. *Verify:* Playwright.
- [ ] Accounts: net worth, cash and cards, registers, Owed to you, repair prompt, health alerts. *Verify:* Playwright.
- [ ] Desktop layout (sidebar, budget table, side panel). *Verify:* Playwright at 1280 × 800.
- [ ] Themes: Light / Dark / Match device from one token set. *Verify:* Playwright screenshots in both themes; contrast check on status colors.
- [ ] States: offline (read-only), daily limit reached, failed sync, over-assigned, new month, first budget. *Verify:* Playwright.

## 5. Settings, onboarding and data

- [ ] First run: welcome, budget start, link banks (Item meter + confirm), make categories. *Verify:* Playwright.
- [ ] Settings: categories and groups (archive/restore), rules (preview, JSON export), payees (merge, rename), connections, import/export, appearance, tracking, note button. *Verify:* Playwright + API tests.
- [x] CSV history import (history only) and full export (JSON + CSV). *Verify:* integration tests.

## 6. Reports, net worth, reimbursements (design Phase 6)

- [x] Reports API (Spending, Invested, Income, Rewards, by category, trend, net worth); UI pending in phase 4 work.
- [ ] Reports: month to date, Spent / Invested / Income / Rewards, spending by category net of paybacks, still owed line, drill-down. *Verify:* domain tests + Playwright.
- [x] Owed to you: mark, match (split across items), close, cancel, unlink, expect-by, overdue. *Verify:* domain property tests (rules 9, 11, 12) and the API integration test; Playwright with the UI.

## 7. Usage tracking

- [x] Server side: `POST /api/usage` (2,000/day cap, dropped from the breaker's 70% tier), notes, daily roll-up into `usage_daily`, 90-day prune, Export usage (JSON), delete on request.
- [ ] Client buffer (30 s flush + `keepalive` on hide), `data-track` ids only, 2,000/day cap, breaker drop at 70%, `usage_event` table, daily roll-up into `usage_daily`, 90-day prune, Export usage (JSON), Note button, off switch with delete. *Verify:* unit + integration tests; a test asserts no amounts/names can be recorded.

## 8. Backups, monitoring, operations (design Phase 5 prerequisites)

- [x] `/api/health` (statuses only), watchdog in `health_status`, Accounts alerts. *Verify:* integration tests.
- [x] GitHub Actions: nightly backup (D1 export → age public key → R2 with manifest), monitor every 6 hours, monthly keepalive. *Verify:* `actionlint`; dry-run scripts tested locally.
- [x] Runbooks: first deploy, Access, Plaid Production link, restore drill. *Verify:* reviewed against the doc.
- [ ] **(manual)** Create Cloudflare resources, Access app and policy, secrets, R2 bucket, first production deploy, confirm Plaid Trial status and 180-day window.

## 9. CI and supply chain

- [x] `ci.yml`: frozen install → lint, typecheck, format → unit → integration (local D1) → build → migration check → bundle budget → Playwright (fake provider). *Verify:* green run on GitHub.
- [x] `security.yml` (CodeQL, Gitleaks, OSV-Scanner, dependency review, zizmor, actionlint), `deploy.yml` (staging → production with approval, rollback), `release.yml`, `nightly.yml`, `monitor.yml`, `keepalive.yml`, Dependabot, CODEOWNERS, PR template; actions pinned to SHAs. *Verify:* `actionlint` clean; CI green.
