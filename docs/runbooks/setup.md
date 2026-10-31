# Setup and first production deploy

Everything below is done by you, by hand, once. The build never deployed anything, linked a real bank or created Cloudflare resources. Do the steps in order: backups and monitoring must be running before the first Production bank link (design: Backups).

You need: a free Cloudflare account, the GitHub repo, the Plaid team on the Trial plan, Node 22, pnpm 10, `age`, and hardware-key 2FA on Cloudflare, GitHub and Plaid.

## 1. Check the Plaid Trial before anything else

On the Plaid Dashboard, confirm three things:

1. The team is on the **Trial** plan.
2. Its lifetime Item count is **0**.
3. It has never had a Production or Limited Production plan.

Removed Items still count toward the 10, so every link matters. Note the Sandbox keys and the Production secret. Production keys go only into the production Worker's secrets (step 5), never into GitHub or `.dev.vars`.

The history window is 180 days (`PLAID_DAYS_REQUESTED` in `packages/bank-provider/src/plaid.ts`). It can't be changed after an Item is created. If you want a different window, change it now, before the first Production link.

If you'll link OAuth institutions such as Chase, register a redirect URI in the Plaid Dashboard (Team settings → API → Allowed redirect URIs), for example `https://ledgerline.<your-subdomain>.workers.dev/`, and set `PLAID_REDIRECT_URI` to the same value in step 5.

## 2. Create the Cloudflare resources (one account, free plan)

```sh
pnpm install
cd apps/worker
pnpm exec wrangler login
pnpm exec wrangler d1 create ledgerline           # copy the database_id
pnpm exec wrangler d1 create ledgerline-staging   # copy the database_id
pnpm exec wrangler r2 bucket create ledgerline-raw
pnpm exec wrangler r2 bucket create ledgerline-raw-staging
pnpm exec wrangler r2 bucket create ledgerline-backups
pnpm exec wrangler r2 bucket lifecycle add ledgerline-backups backups-90d backups/ --expire-days 90
```

Put the two `database_id` values into `apps/worker/wrangler.jsonc`: the top-level `d1_databases` is production, `env.staging.d1_databases` is staging. Commit that change; the ids aren't secrets.

If R2 or Zero Trust asks for a payment method and one is on file, create a **$0 budget alert** under Billing so going over a free allowance can't be billed silently.

## 3. Cloudflare Access (Zero Trust Free)

1. Zero Trust → Settings → Authentication. Add **GitHub** as a login method (it needs a GitHub OAuth app; Cloudflare shows the callback URL). Turn **One-time PIN off**.
2. Access → Applications → Add a **self-hosted** application:
   - Domains: `ledgerline.<your-subdomain>.workers.dev` and `ledgerline-staging.<your-subdomain>.workers.dev`.
   - Session duration: **24 hours**.
   - Policy "Owner": action **Allow**, include your GitHub login (and nothing else).
   - Note the **Application Audience (AUD) tag** and your **team domain** (`https://<team>.cloudflareaccess.com`).
3. On the same application, add a second policy "Plaid webhooks": action **Bypass**, path `/api/webhooks/plaid`. The Worker checks Plaid's signature on that path.
4. Create a **service token** (Access → Service auth). Add a policy "Monitor": action **Service Auth**, include that token. The Worker lets service tokens read `/api/health` only. Note the Client ID and Client Secret.
5. Re-authentication for Connections and Export: add a second self-hosted application for the paths `/settings/connections*`, `/api/settings/connections/*` and `/api/export/*`, with the same Owner policy and a **short session (15 minutes)**.

## 4. Generate keys you keep offline

```sh
openssl rand -base64 32        # TOKEN_KEYS value: 1:<this>   (production)
openssl rand -base64 32        # TOKEN_KEYS value for staging
age-keygen -o ledgerline-backup.key   # keep this file in your password manager, never in GitHub
grep public ledgerline-backup.key     # the age public key (age1...) for BACKUP_AGE_RECIPIENT
```

## 5. Worker secrets

Production (`cd apps/worker`, then for each: `pnpm exec wrangler secret put NAME`):

| Name                       | Value                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `PLAID_CLIENT_ID`          | Plaid client id                                                                    |
| `PLAID_SECRET`             | Plaid **Production** secret                                                        |
| `PLAID_WEBHOOK_URL`        | `https://ledgerline.<your-subdomain>.workers.dev/api/webhooks/plaid`               |
| `PLAID_REDIRECT_URI`       | optional, as registered in step 1                                                  |
| `TOKEN_KEYS`               | `1:<base64 key>`                                                                   |
| `TOKEN_KEY_CURRENT`        | `1`                                                                                |
| `ACCESS_TEAM_DOMAIN`       | `https://<team>.cloudflareaccess.com`                                              |
| `ACCESS_AUD`               | the AUD tag                                                                        |
| `ACCESS_SERVICE_CLIENT_ID` | the service token's Client ID                                                      |
| `OWNER_EMAIL`              | the email your GitHub login gives Access (your first sign-in creates the budget)   |
| `CF_ACCOUNT_ID`            | your Cloudflare account id                                                         |
| `CF_ANALYTICS_TOKEN`       | an API token with **Account Analytics: Read** only (for the write circuit breaker) |

Staging: the same names with `--env staging`. Use the **Sandbox** secret, the staging webhook URL and its own `TOKEN_KEYS`. `PLAID_ENV` is a plain variable in `wrangler.jsonc`: `production` at the top level and `sandbox` for staging.

To rotate the token key later, add `2:<new key>` to `TOKEN_KEYS` and set `TOKEN_KEY_CURRENT=2`. Old rows keep decrypting with key 1.

## 6. GitHub

1. Make the repo **public**, as the design decided. Turn on secret scanning with push protection, Dependabot alerts and code scanning.
2. Add a ruleset on the default branch (`master`; rename it to `main` if you prefer, since the workflows accept both): require a PR, require all checks green, linear history, signed commits, no force pushes, and a CODEOWNERS review.
3. Create **environments**, with secrets and variables:

| Environment  | Protection                 | Secrets                                                                                                      | Variables                                       |
| ------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `staging`    | none                       | `CLOUDFLARE_API_TOKEN` (limited to the staging Worker and D1), `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`    | `CLOUDFLARE_ACCOUNT_ID`, `STAGING_URL`          |
| `production` | **required reviewer: you** | `CLOUDFLARE_API_TOKEN` (limited to the production Worker and D1), `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET` | `CLOUDFLARE_ACCOUNT_ID`, `PRODUCTION_URL`       |
| `backup`     | none                       | `CLOUDFLARE_BACKUP_TOKEN` (D1 read/export on production, R2 write on `ledgerline-backups`)                   | `CLOUDFLARE_ACCOUNT_ID`, `BACKUP_AGE_RECIPIENT` |
| `monitor`    | none                       | `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`                                                                   | `PRODUCTION_URL`                                |
| `sandbox`    | none                       | `PLAID_SANDBOX_CLIENT_ID`, `PLAID_SANDBOX_SECRET`                                                            |                                                 |

Check whether Cloudflare lets you limit a D1 permission to one database. If not, give the production token D1 edit on the account and keep the production environment's required reviewer as the guard.

## 7. First production deploy (by hand, once)

```sh
pnpm install --frozen-lockfile
pnpm --filter @ledgerline/web build
cd apps/worker
pnpm exec wrangler d1 migrations apply DB --remote
pnpm exec wrangler deploy
```

Open `https://ledgerline.<your-subdomain>.workers.dev`. Access asks you to sign in with GitHub, and the Worker creates the budget for `OWNER_EMAIL`. Then set the budget start month in first-run setup.

After that, merges to the default branch deploy through `deploy.yml`: staging first, then production after you approve.

## 8. Before linking a real bank

1. Run **nightly** by hand (Actions → nightly → Run workflow). Check that `ledgerline-backups/manifests/latest.json` exists.
2. Run **monitor** by hand and check it's green.
3. Do one restore drill (`docs/runbooks/restore.md`).
4. In Workers Logs (Observability), check CPU time per request and per Workflow step: fetch about 2 ms, apply about 5 ms (`docs/measurements.md`). Check whether the 50-subrequest limit is per invocation or per Workflow instance.
5. Link the first 1–2 Items **from a desktop browser**. Confirm the starting balance the link screen shows, and confirm the 180-day window in the Plaid Dashboard's Item details.
6. Run beside your current budgeting tool for a month and reconcile.

## 9. Local development

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # fill in Sandbox keys and a token key
cd apps/worker && pnpm exec wrangler d1 migrations apply DB --local
pnpm exec wrangler dev
# Load the prototype's November into the local database (DEV_ROUTES=1, FAKE_NOW=2026-11-14T20:00:00Z in .dev.vars):
curl -X POST localhost:8787/__dev/seed-november -H 'content-type: application/json' -H 'x-ledgerline: 1' -d '{}'
```
