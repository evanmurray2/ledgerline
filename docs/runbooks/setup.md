# Setup and first production deploy

Everything below is done by you, by hand, once. The build never deployed anything, linked a real bank or created Cloudflare resources. Nothing here needs a payment card: the app uses only Workers, D1 and Workflows on the free plan, with no R2 and no Zero Trust (decisions.md D-26, D-27). Do the steps in order: backups and monitoring must be running before the first Production bank link (design: Backups).

You need: a free Cloudflare account, the GitHub repo, the Plaid team on the Trial plan, Node 22, pnpm 10, `age`, and 2FA on Cloudflare, GitHub and Plaid (hardware key or passkey).

## 1. Check the Plaid Trial before anything else

On the Plaid Dashboard, confirm three things:

1. The team is on the **Trial** plan.
2. Its lifetime Item count is **0**.
3. It has never had a Production or Limited Production plan.

Removed Items still count toward the 10, so every link matters. Note the Sandbox keys and the Production secret. Production keys go only into the production Worker's secrets (step 4), never into GitHub or `.dev.vars`.

The history window is 180 days (`PLAID_DAYS_REQUESTED` in `packages/bank-provider/src/plaid.ts`). It can't be changed after an Item is created. If you want a different window, change it now, before the first Production link.

If you'll link OAuth institutions such as Chase, register a redirect URI in the Plaid Dashboard (Team settings → API → Allowed redirect URIs), for example `https://ledgerline.<your-subdomain>.workers.dev/`, and set `PLAID_REDIRECT_URI` to the same value in step 4.

## 2. Create the Cloudflare databases (one account, free plan)

**Done on Nov 1, 2026:** `ledgerline` (`52a5b8a6-09b1-4b27-b0bd-ddfaefd943b3`) and `ledgerline-staging` (`dd5f73ff-487b-4fb3-a975-3c9b4531047e`), both in western North America, with their ids in `wrangler.jsonc`. Migrations are applied by the first deploy (step 6). The steps below are for reference.

```sh
pnpm install
cd apps/worker
pnpm exec wrangler login
pnpm exec wrangler d1 create ledgerline           # copy the database_id
pnpm exec wrangler d1 create ledgerline-staging   # copy the database_id
```

Put the two `database_id` values into `apps/worker/wrangler.jsonc`: the top-level `d1_databases` is production, `env.staging.d1_databases` is staging. Commit that change; the ids aren't secrets.

That's all Cloudflare needs. There is no R2 bucket and no Zero Trust application to create.

## 3. Generate secrets

Run each line and keep the output in your password manager:

```sh
openssl rand -base64 32        # TOKEN_KEYS for production:  1:<this>
openssl rand -base64 32        # TOKEN_KEYS for staging:     1:<this>
openssl rand -base64 32        # SETUP_CODE for production (one-time, creates your first passkey)
openssl rand -base64 32        # SETUP_CODE for staging
openssl rand -base64 32        # OPS_TOKEN (shared by the Worker and the GitHub monitor and backup jobs)
age-keygen -o ledgerline-backup.key   # keep this file in your password manager, never in GitHub
grep public ledgerline-backup.key     # the age public key (age1...) for BACKUP_AGE_RECIPIENT
```

## 4. Worker secrets

Production (`cd apps/worker`, then for each: `pnpm exec wrangler secret put NAME`):

| Name                 | Value                                                                              |
| -------------------- | ---------------------------------------------------------------------------------- |
| `PLAID_CLIENT_ID`    | Plaid client id                                                                    |
| `PLAID_SECRET`       | Plaid **Production** secret                                                        |
| `PLAID_WEBHOOK_URL`  | `https://ledgerline.<your-subdomain>.workers.dev/api/webhooks/plaid`               |
| `PLAID_REDIRECT_URI` | optional, as registered in step 1                                                  |
| `TOKEN_KEYS`         | `1:<base64 key>`                                                                   |
| `TOKEN_KEY_CURRENT`  | `1`                                                                                |
| `SETUP_CODE`         | the production setup code from step 3                                              |
| `OPS_TOKEN`          | the ops token from step 3                                                          |
| `CF_ACCOUNT_ID`      | your Cloudflare account id                                                         |
| `CF_ANALYTICS_TOKEN` | an API token with **Account Analytics: Read** only (for the write circuit breaker) |

Staging: the same names with `--env staging`. Use the **Sandbox** secret, the staging webhook URL, its own `TOKEN_KEYS` and `SETUP_CODE`, and the same or a separate `OPS_TOKEN`. `PLAID_ENV` is a plain variable in `wrangler.jsonc`: `production` at the top level and `sandbox` for staging.

To rotate the token key later, add `2:<new key>` to `TOKEN_KEYS` and set `TOKEN_KEY_CURRENT=2`. Old rows keep decrypting with key 1.

## 5. GitHub

1. Make the repo **public**, as the design decided, or keep it private: both work on the free plan. In a public repo anyone signed in to GitHub can download the backup artifacts; they are age-encrypted, so only your private key opens them. Turn on secret scanning with push protection, Dependabot alerts and code scanning.
2. Add a ruleset on the default branch (`master`; rename it to `main` if you prefer, since the workflows accept both): require a PR, require all checks green, linear history, signed commits, no force pushes, and a CODEOWNERS review.
3. Create **environments**, with secrets and variables:

| Environment  | Protection                 | Secrets                                                                    | Variables                                                         |
| ------------ | -------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `staging`    | none                       | `CLOUDFLARE_API_TOKEN` (Workers and D1 edit), `OPS_TOKEN`                  | `CLOUDFLARE_ACCOUNT_ID`, `STAGING_URL`                            |
| `production` | **required reviewer: you** | `CLOUDFLARE_API_TOKEN` (Workers and D1 edit), `OPS_TOKEN`                  | `CLOUDFLARE_ACCOUNT_ID`, `PRODUCTION_URL`                         |
| `backup`     | none                       | `CLOUDFLARE_BACKUP_TOKEN` (D1 read, for `wrangler d1 export`), `OPS_TOKEN` | `CLOUDFLARE_ACCOUNT_ID`, `BACKUP_AGE_RECIPIENT`, `PRODUCTION_URL` |
| `monitor`    | none                       | `OPS_TOKEN`                                                                | `PRODUCTION_URL`                                                  |
| `sandbox`    | none                       | `PLAID_SANDBOX_CLIENT_ID`, `PLAID_SANDBOX_SECRET`                          |                                                                   |

Create the Cloudflare API tokens under My Profile → API Tokens, with the narrowest permissions Cloudflare offers. If it can't limit D1 to one database, keep the production environment's required reviewer as the guard.

## 6. First production deploy (by hand, once)

Workflows that touch Cloudflare stay off until you set repository variables: `DEPLOY_ENABLED=true` (deploy), `BACKUP_AGE_RECIPIENT` (nightly backup), `PRODUCTION_URL` (monitor), `SANDBOX_E2E=true` (nightly Plaid Sandbox run).

```sh
pnpm install --frozen-lockfile
pnpm --filter @ledgerline/web build
cd apps/worker
pnpm exec wrangler d1 migrations apply DB --remote
pnpm exec wrangler deploy
```

Open `https://ledgerline.<your-subdomain>.workers.dev` **on your phone or computer**. It shows "Set up sign-in": enter the production `SETUP_CODE` and create a passkey (Face ID, Touch ID, Windows Hello or a security key). That creates your budget; then set the budget start month in first-run setup.

Add your other devices from Settings → Sign-in → **Add a device**: it makes a single-use link valid for 10 minutes. Open it on the other device and create a passkey there. Passkeys synced by iCloud Keychain or Google Password Manager also work on your other devices without a link.

The setup code stops working once a passkey exists. You can delete the `SETUP_CODE` secret then, or keep it for recovery (below).

After that, merges to the default branch deploy through `deploy.yml`: staging first, then production after you approve.

**Lost every passkey?** Delete them and use the setup code again:

```sh
cd apps/worker
pnpm exec wrangler d1 execute DB --remote --command "DELETE FROM passkey; DELETE FROM auth_session;"
pnpm exec wrangler secret put SETUP_CODE   # a new one if the old one may be known
```

## 7. Before linking a real bank

1. Run **nightly** by hand (Actions → nightly → Run workflow). Check that the run has a `backup` artifact and that its last step reported the backup.
2. Run **monitor** by hand and check it's green (it fails if the app has no backup from the last 36 hours).
3. Do one restore drill (`docs/runbooks/restore.md`).
4. In Workers Logs (Observability), check CPU time per request and per Workflow step: fetch about 3.5 ms, apply about 5.5 ms (`docs/measurements.md`). Check whether the 50-subrequest limit is per invocation or per Workflow instance.
5. Link the first 1–2 Items **from a desktop browser**. Linking needs a passkey check within the last 15 minutes; the app asks for one. Confirm the starting balance the link screen shows, and confirm the 180-day window in the Plaid Dashboard's Item details.
6. Run beside your current budgeting tool for a month and reconcile.

## 8. Local development

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # fill in Sandbox keys and a token key
cd apps/worker && pnpm exec wrangler d1 migrations apply DB --local
pnpm exec wrangler dev
# Load the prototype's November into the local database (DEV_ROUTES=1, FAKE_NOW=2026-11-14T20:00:00Z in .dev.vars):
curl -X POST localhost:8787/__dev/seed-november -H 'content-type: application/json' -H 'x-ledgerline: 1' -d '{}'
```

`DEV_AUTH_EMAIL` in `.dev.vars` signs you in without a passkey locally; it is refused when `PLAID_ENV=production`. To try passkey sign-in locally, remove it, set `SETUP_CODE`, and open `http://localhost:8787` (not `127.0.0.1`: passkeys need a host name).
