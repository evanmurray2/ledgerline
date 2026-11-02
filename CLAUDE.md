# Ledgerline: notes for Claude sessions

A single-user, zero-based budgeting app on Cloudflare's free plan. Start with `docs/build-plan.md` (what's done), `docs/decisions.md` (D-1 to D-40: why things differ from the design) and `docs/runbooks/setup.md`. `docs/design.md` and `docs/sync-spec.md` are the source of truth; record any contradiction in `docs/decisions.md`.

## Production

- App: https://ledgerline.ledger-line.workers.dev (Worker `ledgerline`, workers.dev subdomain `ledger-line`)
- Cloudflare account id: `f2d39c71e2c0819833de7942cdcc1222`
- Data: SQLite Durable Objects since Nov 2, 2026 (`docs/multi-user.md`): a `Directory` (sign-in) and one `BudgetStore` per budget, with Cloudflare's 30-day point-in-time recovery. D1 and Workflows are gone (D-37, D-38): production, local dev, tests and e2e all use `apps/worker/wrangler.jsonc`, and tests reach a store's database through `apps/worker/test/store-db.ts`. There is no staging (D-36).
- Sign-in is passkeys (D-27). The owner's passkey exists, and 7 of the 10 Plaid links are used (Charles Schwab, Chase, Wells Fargo, Citibank, Bank of America, American Express, SoFi; checked Nov 2, 2026), so 3 are left. Plaid allows 10 links for life: **never link, re-link or remove a bank without asking.**

## Deploying

- When the owner asks to deploy: first check that the `ci` run for that `main` commit passed (GitHub MCP `actions_list`, `list_workflow_runs`; `deploy.yml` also waits for it and refuses a commit whose `ci` failed). If it's still running, wait for it; if it failed, fix it first. Then trigger the GitHub workflow `deploy.yml` on `main` (GitHub MCP `actions_run_trigger`, method `run_workflow`), then check the run's result. It deploys, smoke-tests and rolls back on failure. Each Durable Object runs its own schema migrations when it starts.
- GitHub holds only the `production` environment's `CLOUDFLARE_API_TOKEN`. The Worker keeps its other secrets (`TOKEN_KEYS`, Plaid keys, `SETUP_CODE`, `OPS_TOKEN`) from the first deploy; a deploy never deletes a secret.
- Deploy on merge is off until the repository variable `DEPLOY_ON_MERGE` is `true` (D-30).
- Never print, commit or ask the owner to paste secrets in chat.

## Hard rules from the owner

- $0 forever: Cloudflare free plan only, no services that need a payment card (no R2, no Zero Trust: D-26, D-27), Plaid Trial.
- 10 ms of CPU per request or job step (SQLite runs in-process, so it counts); measure hot paths (`docs/measurements.md`).
- Never mention any other budgeting app by name anywhere: code, comments, docs, UI copy, commit messages.
- Stop and ask only when a choice would change how money is counted (Money rules in `docs/sync-spec.md`; `packages/domain`).
- No off-site backups (D-29). No monitor or nightly Plaid Sandbox job wanted for now.
- The owner works from an iPhone: give short, plain steps with direct links.

## Working in the repo

- pnpm monorepo: `packages/domain` (Money rules, `computeBudget()`), `packages/contracts` (Zod), `apps/worker` (Hono + Durable Objects, alarms for background work), `apps/web` (React SPA), `e2e` (Playwright).
- Checks before pushing: `pnpm check` (about 30 s). It formats, then runs lint, typecheck, unit and integration tests side by side and prints only what fails. For UI changes, run only the e2e tests that cover what you changed, e.g. `cd e2e && pnpm exec playwright test app.spec.ts -g "<test name>"` (the Worker suite: `pnpm --filter @ledgerline/web build` first, then `-c playwright.worker.config.ts`). Don't run the full `pnpm test:e2e`: CI runs it on every push. Chromium is preinstalled; don't run `playwright install`.
- Don't wait for CI after a push; carry on working. Just before your next push, and when you finish a task, check the `ci` run for your previous push (it's usually done by then; GitHub MCP `actions_list`, `list_workflow_runs`). If it failed, fix that first.
- Migrations in `packages/db/budget-migrations` and `packages/db/directory-migrations` are forward-only once on `main` (`node tools/ci/migration-check.mjs`); add a new numbered file, then run `node tools/db/gen-store-migrations.mjs`.
- Small commits on `main`, tests passing before each; keep `docs/build-plan.md` current.
