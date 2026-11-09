# Ledgerline: notes for Claude sessions

A single-user, zero-based budgeting app on Cloudflare's free plan. Start with `docs/architecture.md` (the system as built, one page), `docs/build-plan.md` (open work), `docs/decisions.md` and `docs/decisions/` (D-1 on: why things differ from the design) and `docs/runbooks/setup.md`. `docs/design.md` and `docs/sync-spec.md` are the source of truth for the Money rules and the product; start with `docs/whats-true-now.md`, which says what the later decisions replaced. Record any new contradiction as a decision (see Several sessions at once) and add a line to that file.

## Production

- App: https://ledgerline.ledger-line.workers.dev (Worker `ledgerline`, workers.dev subdomain `ledger-line`)
- Cloudflare account id: `f2d39c71e2c0819833de7942cdcc1222`
- Data: SQLite Durable Objects since Nov 2, 2026 (`docs/multi-user.md`): a `Directory` (sign-in) and one `BudgetStore` per budget, with Cloudflare's 30-day point-in-time recovery. D1 and Workflows are gone (D-37, D-38): production, local dev, tests and e2e all use `apps/worker/wrangler.jsonc`, and tests reach a store's database through `apps/worker/test/store-db.ts`. There is no staging (D-36). Since D-45/D-46 the server keeps nothing derived: the app syncs the budget (`GET /api/sync`) into an engine on the device (`apps/worker/src/local`, run in a Web Worker on sql.js) that answers every screen with the server's own routes; `apps/worker/test/engine.test.ts` checks they match (`docs/phone-budget.md`).
- Sign-in is passkeys (D-27). The owner's passkey exists, and 7 of the 10 Plaid links are used (Charles Schwab, Chase, Wells Fargo, Citibank, Bank of America, American Express, SoFi; checked Nov 2, 2026), so 3 are left. Plaid allows 10 links for life: **never link, re-link or remove a bank without asking.**

## Deploying

- Every merge to `main` deploys by itself: the repository variable `DEPLOY_ON_MERGE` is `true` (D-30), and `deploy.yml` waits for that commit's `ci`, deploys, smoke-tests and rolls back the code on failure. Deploys queue one at a time. After merging, watch the `deploy` run for your merge commit (`tools/ci/watch-runs.mjs`, below); if it failed, tell the owner and fix it first.
- There is no manual deploy (D-49): `deploy.yml` has no Run workflow button, and only a merge to `main` deploys. Never deploy any other way (no `wrangler deploy`, `wrangler rollback` or Cloudflare API or MCP calls that change the Worker) unless the owner first reverses D-49; to redeploy, merge a change. Each Durable Object runs its own schema migrations when it starts.
- GitHub holds only the `production` environment's `CLOUDFLARE_API_TOKEN`. The Worker keeps its other secrets (`TOKEN_KEYS`, Plaid keys, `SETUP_CODE`, `OPS_TOKEN`) from the first deploy; a deploy never deletes a secret.
- A rollback undoes code, not migrations: those reach the owner's real budget on merge and are forward-only.
- Never print, commit or ask the owner to paste secrets in chat.

## Hard rules from the owner

- $0 forever: Cloudflare free plan only, no services that need a payment card (no R2, no Zero Trust: D-26, D-27), Plaid Trial.
- 10 ms of CPU per request or job step (SQLite runs in-process, so it counts); measure hot paths (`docs/measurements.md`).
- Never mention any other budgeting app by name anywhere: code, comments, docs, UI copy, commit messages.
- Stop and ask only when a choice would change how money is counted (Money rules in `docs/sync-spec.md`; `packages/domain`).
- No off-site backups (D-29). No monitor or nightly Plaid Sandbox job wanted for now (their workflows were removed, D-49).
- The owner works from an iPhone: give short, plain steps with direct links.
- Write to the owner in ASD-STE100 Simplified Technical English, or at least follow its principles: short sentences (at most 20 words for an instruction, 25 for a description), one instruction per sentence, active voice, one meaning per word, common words plus the project's own technical names. This is for what you write to the owner (chat replies, PR descriptions); code and docs keep their own style.

## Working in the repo

- pnpm monorepo: `packages/domain` (Money rules, `computeBudget()`), `packages/contracts` (Zod), `apps/worker` (Hono + Durable Objects, alarms for background work), `apps/web` (React SPA), `e2e` (Playwright).
- UI: use the tokens and shared parts in `docs/design-system.md`; no typed-in colors, text sizes, corners or shadows. Write UI text to `docs/copy.md` (rules and terms).
- Checks before pushing: `pnpm check` (about 30 s). It formats, then runs lint, typecheck, unit and integration tests side by side and prints only what fails. For UI changes, run only the e2e tests that cover what you changed, e.g. `cd e2e && pnpm exec playwright test app.spec.ts -g "<test name>"` (the Worker suite: `pnpm --filter @ledgerline/web build` first, then `-c playwright.worker.config.ts`). Don't run the full `pnpm test:e2e`: CI runs it on every push. Chromium is preinstalled; don't run `playwright install`.
- Don't sit waiting for CI after a push; carry on working and check the PR's `ci` run before your next push and before merging (GitHub MCP `actions_list`, `list_workflow_runs`). If it failed, fix that first.
- Watch CI and deploys; never guess. Don't use `sleep`, timed check-ins (`send_later`) or a fixed number of minutes to decide that CI has passed or a deploy is done. Start a background watcher that polls the real runs and reports the moment each one finishes: `node tools/ci/watch-runs.mjs <sha> ci` for a PR's latest commit, `node tools/ci/watch-runs.mjs <sha> ci deploy` for a merge commit (Bash with `run_in_background`; it exits 0 when all passed or were skipped, 1 on a failure, cancel or timeout; when a newer merge cancelled the commit's `ci`, it follows the newest commit on `main`, whose deploy ships both). Subscribing to the PR (`subscribe_pr_activity`) also wakes you on its CI, but nothing wakes you for `deploy` on `main`, so always watch that one after a merge. Start it right after every push to a PR, not only before merging: it also exits 1 when the PR has a merge conflict with `main` (GitHub runs no CI then, and nothing else wakes you) or when no run starts within 10 minutes. Tell the owner only what the watcher reported.
- Migrations in `packages/db/budget-migrations` and `packages/db/directory-migrations` are forward-only once on `main` (`node tools/ci/migration-check.mjs`); add a new numbered file, then run `node tools/db/gen-store-migrations.mjs`.
- `docs/build-plan.md` lists open work only, one line per item: add a line for work you leave, delete the line in the PR that finishes it. Don't log finished work there (the PR description does that). `docs/build-history.md` is frozen.
- Large files (over about 600 lines): when a task already changes one, split off the part you're working on into its own file, by feature (a sheet, a group of routes). Make the split its own commit with no change in behavior. Don't split files you aren't otherwise touching.

## Several sessions at once

The owner runs several Claude sessions side by side, each with its own container and branch.

- Never push to `main`. Work on your session's branch, with small commits and tests passing before each, and open a PR into `main` when the task is done (or sooner, as a draft).
- Merge your own PR, without asking, once all of these hold (no rebase onto the latest `main` needed, D-51):
  1. GitHub shows no merge conflict with `main`,
  2. `pnpm check` passes locally,
  3. every `ci` job (`checks`, `e2e (mock)`, `e2e (worker)`) passed on the PR's latest commit, and
  4. it doesn't need an answer from the owner (Money rules, Plaid links, secrets).
     Then squash-merge with GitHub MCP `merge_pull_request` (`merge_method: squash`, `sha` set to the commit CI passed on). After the merge, start any further work fresh from `origin/main` on the same branch name.
- The safety check is the `ci` run on `main` after each merge: `deploy.yml` only deploys a commit whose `ci` passed. After merging, check `ci` and `deploy` for your merge commit. If `ci` on `main` failed, fix it first, even if your PR alone was green. A deploy shown as skipped is fine: a newer merge cancelled its `ci`, and the newer deploy ships it.
- To catch up with `main` (a conflict, a PR that adds a migration, or a fix that needs the other side), use GitHub MCP `update_pull_request_branch`: it merges `main` into the PR, no force-push. If GitHub refuses because of a conflict, `git fetch origin main && git merge origin/main`, resolve, test and push. Never rebase or force-push another session's branch.
- Decisions: one file per decision, `docs/decisions/D-<n>-<slug>.md` (D-1 to D-50 stay in the table in `docs/decisions.md`). Write `D-67` while working; just before merging, `git fetch origin main && node tools/docs/next-decision.mjs` gives the next free number. Rename the file and every reference to it.
- Migration file numbers belong to whoever merges first; a PR adding one must be caught up with `main` first, and renumbered if its number was taken.
- `docs/build-plan.md` and `docs/whats-true-now.md` merge with `merge=union` (`.gitattributes`), so a local merge keeps both sides' lines; check for an item listed twice. GitHub's own merge ignores this. Keep both one line per entry. In any other shared-doc conflict, keep both sides' entries.
- Merging is deploying. Ask the owner before merging a PR that adds a migration (`packages/db/*-migrations`).
- An owner's "yes" (to a Plaid link, a Money-rules choice, a deploy) applies only in the session where they said it.
