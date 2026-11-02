# Ledgerline: notes for Claude sessions

A single-user, zero-based budgeting app on Cloudflare's free plan. Start with `docs/build-plan.md` (what's done), `docs/decisions.md` (D-1 to D-30: why things differ from the design) and `docs/runbooks/setup.md`. `docs/design.md` and `docs/sync-spec.md` are the source of truth; record any contradiction in `docs/decisions.md`.

## Production

- App: https://ledgerline.ledger-line.workers.dev (Worker `ledgerline`, workers.dev subdomain `ledger-line`)
- Cloudflare account id: `f2d39c71e2c0819833de7942cdcc1222`
- D1: `ledgerline` `52a5b8a6-09b1-4b27-b0bd-ddfaefd943b3`, `ledgerline-staging` `dd5f73ff-487b-4fb3-a975-3c9b4531047e` (staging isn't deployed)
- Sign-in is passkeys (D-27). The owner's passkey and one Charles Schwab bank link exist. Plaid allows 10 links for life: **never link, re-link or remove a bank without asking.**

## Deploying

- When the owner asks to deploy: first check that the `ci` run for that `master` commit passed (GitHub MCP `actions_list`, `list_workflow_runs`; `deploy.yml` doesn't check). If it's still running, wait for it; if it failed, fix it first. Then trigger the GitHub workflow `deploy.yml` on `master` (GitHub MCP `actions_run_trigger`, method `run_workflow`), then check the run's result. It applies D1 migrations, deploys, smoke-tests and rolls back on failure.
- GitHub holds only the `production` environment's `CLOUDFLARE_API_TOKEN`. The Worker keeps its other secrets (`TOKEN_KEYS`, Plaid keys, `SETUP_CODE`, `OPS_TOKEN`) from the first deploy; a deploy never deletes a secret.
- Deploy on merge is off until the repository variable `DEPLOY_ON_MERGE` is `true` (D-30).
- Never print, commit or ask the owner to paste secrets in chat.

## Hard rules from the owner

- $0 forever: Cloudflare free plan only, no services that need a payment card (no R2, no Zero Trust: D-26, D-27), Plaid Trial.
- 10 ms of CPU per request or Workflow step; measure hot paths (`docs/measurements.md`).
- Never mention any other budgeting app by name anywhere: code, comments, docs, UI copy, commit messages.
- Stop and ask only when a choice would change how money is counted (Money rules in `docs/sync-spec.md`; `packages/domain`).
- No off-site backups (D-29). No monitor or nightly Plaid Sandbox job wanted for now.
- The owner works from an iPhone: give short, plain steps with direct links.

## Working in the repo

- pnpm monorepo: `packages/domain` (Money rules, `computeBudget()`), `packages/contracts` (Zod), `apps/worker` (Hono + D1 + Workflows), `apps/web` (React SPA), `e2e` (Playwright).
- Checks before pushing (about 30 s): `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`. For UI changes, run only the e2e tests that cover what you changed, e.g. `cd e2e && pnpm exec playwright test app.spec.ts -g "<test name>"` (the Worker suite: `pnpm --filter @ledgerline/web build` first, then `-c playwright.worker.config.ts`). Don't run the full `pnpm test:e2e`: CI runs it on every push. Chromium is preinstalled; don't run `playwright install`.
- Don't wait for CI after a push; carry on working. Just before your next push, and when you finish a task, check the `ci` run for your previous push (it's usually done by then; GitHub MCP `actions_list`, `list_workflow_runs`). If it failed, fix that first.
- Migrations in `packages/db/migrations` are forward-only once on `master` (`node tools/ci/migration-check.mjs`); add a new numbered file.
- Small commits on `master`, tests passing before each; keep `docs/build-plan.md` current.
