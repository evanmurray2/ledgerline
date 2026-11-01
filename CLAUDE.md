# Ledgerline: notes for Claude sessions

A single-user, zero-based budgeting app on Cloudflare's free plan. Start with `docs/build-plan.md` (what's done), `docs/decisions.md` (D-1 to D-30: why things differ from the design) and `docs/runbooks/setup.md`. `docs/design.md` and `docs/sync-spec.md` are the source of truth; record any contradiction in `docs/decisions.md`.

## Production

- App: https://ledgerline.ledger-line.workers.dev (Worker `ledgerline`, workers.dev subdomain `ledger-line`)
- Cloudflare account id: `f2d39c71e2c0819833de7942cdcc1222`
- D1: `ledgerline` `52a5b8a6-09b1-4b27-b0bd-ddfaefd943b3`, `ledgerline-staging` `dd5f73ff-487b-4fb3-a975-3c9b4531047e` (staging isn't deployed)
- Sign-in is passkeys (D-27). The owner's passkey and one Charles Schwab bank link exist. Plaid allows 10 links for life: **never link, re-link or remove a bank without asking.**

## Deploying

- When the owner asks to deploy: trigger the GitHub workflow `deploy.yml` on `master` (GitHub MCP `actions_run_trigger`, method `run_workflow`), then check the run's result. It applies D1 migrations, deploys, smoke-tests and rolls back on failure.
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
- Checks before pushing: `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:integration`, and for UI changes `pnpm --filter @ledgerline/web build && pnpm test:e2e`. Chromium is preinstalled; don't run `playwright install`.
- Migrations in `packages/db/migrations` are forward-only once on `master` (`node tools/ci/migration-check.mjs`); add a new numbered file.
- Small commits on `master`, tests passing before each; keep `docs/build-plan.md` current.
