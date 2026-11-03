# Setup and first production deploy

Everything below is done by you, once, and works from an iPhone in Safari (no command line; decisions.md D-28). Nothing needs a payment card: the app uses only Workers and SQLite Durable Objects on the free plan, with no R2 and no Zero Trust (D-26, D-27, D-37). There is no off-site backup (D-29): recovery uses Cloudflare's 30-day point-in-time recovery on each Durable Object and the full backup you can download from Settings → Import and export.

On GitHub's mobile site some settings pages are easier with **aA → Request Desktop Website**. Turn on 2FA (passkey or security key) for Cloudflare, GitHub and Plaid first.

## 1. Plaid (dashboard.plaid.com)

1. Check the team is on the **Trial** plan, its lifetime Item count is **0**, and it never had a Production plan. Removed Items still count toward the 10.
2. Developers → Keys: copy the **client_id** and the **Production secret**.
3. Optional: if you'll link OAuth banks such as Chase, add `https://ledgerline.<your-subdomain>.workers.dev/` under Team settings → API → Allowed redirect URIs, and save the same value as the GitHub secret `PLAID_REDIRECT_URI` in step 4.

The history window is 180 days and can't change after the first link (`PLAID_DAYS_REQUESTED` in `packages/bank-provider/src/plaid.ts`).

## 2. Make three long random secrets

In the **Passwords** app, tap **+** and use the suggested strong password; then add a second suggested password after it, so each secret is about 40 characters. Save three entries:

| Entry        | Used for                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------ |
| `TOKEN_KEYS` | encrypts your bank access tokens. **Never lose or change it**, or every bank must re-link. |
| `SETUP_CODE` | creates your first passkey, once                                                           |
| `OPS_TOKEN`  | lets GitHub's monitor and the deploy check read the app's health                           |

## 3. Cloudflare (dash.cloudflare.com)

1. **Workers & Pages**: note your **Account ID** and your **workers.dev subdomain** (set one if asked). Your app's address will be `https://ledgerline.<subdomain>.workers.dev`.
2. **My Profile → API Tokens → Create Token**, twice:
   - "Deploy": template **Edit Cloudflare Workers**. Account Resources: your account.
   - "Analytics": Custom token with only **Account → Account Analytics → Read**.

## 4. GitHub (github.com/evanmurray2/ledgerline → Settings)

1. **Environments → New environment** `production`. Tick **Required reviewers** and add yourself. Then **Add environment secret** for each:
   - `CLOUDFLARE_API_TOKEN`: the Deploy token
   - `PLAID_CLIENT_ID`, `PLAID_SECRET` (Production secret), and `PLAID_REDIRECT_URI` if you set one
   - `TOKEN_KEYS`, `SETUP_CODE`, `OPS_TOKEN`
   - `CF_ANALYTICS_TOKEN`: the Analytics token
2. **Secrets and variables → Actions → Variables → New repository variable**, three times:
   - `CLOUDFLARE_ACCOUNT_ID`: your Account ID
   - `PRODUCTION_URL`: `https://ledgerline.<subdomain>.workers.dev`

## 5. Deploy

1. Add the repository variable `DEPLOY_ON_MERGE` = `true`, then merge a PR into `main`. There is no Run workflow button: only a merge deploys (D-49).
2. If you added a required reviewer, GitHub asks you to approve the production deployment (a notification in the GitHub app, or on the run page): **Review deployments → production → Approve and deploy**.
3. Wait for the green check (a few minutes). It applies the database migrations, deploys the app with your secrets, and checks it.

## Redeploying later

GitHub only needs the `production` environment with the secret `CLOUDFLARE_API_TOKEN` (the Deploy token). Under the environment's **Deployment branches and tags**, choose **Selected branches** and add `main`. The Worker keeps every secret it already has; add others to the environment only to change them.

- **Every merge to `main` deploys** while the repository variable `DEPLOY_ON_MERGE` is `true`. Set it to `false` to pause deploys. To redeploy (for example after changing a secret), merge a change. Add yourself under **Required reviewers** if you want each merge to wait for your tap.

The account id and app address default to this account's (`f2d39c71e2c0819833de7942cdcc1222`, `https://ledgerline.ledger-line.workers.dev`); the variables `CLOUDFLARE_ACCOUNT_ID` and `PRODUCTION_URL` override them.

## 6. Create your passkey (right away)

1. Open your app's address in Safari. It shows **Set up sign-in**.
2. Paste `SETUP_CODE`, tap **Create passkey**, and confirm with Face ID. The passkey is saved in iCloud Keychain, so your other Apple devices can sign in too.
3. Pick the month your budget starts.

The setup code stops working once a passkey exists. For a non-Apple device, use Settings → Sign-in → **Add a device** (a link that works once, for 10 minutes).

## 7. Before linking a real bank

1. Link your first bank: **Settings → Bank connections**. Each link uses 1 of your 10, for good. Confirm the starting balance it shows.
2. In Cloudflare: **Workers & Pages → ledgerline → Logs**. After that first sync, check CPU time per step: fetch about 3.5 ms, apply about 5.5 ms (`docs/measurements.md`).
3. Run it beside your current budgeting tool for a month and reconcile.
4. Now and then, download Settings → Import and export → JSON export and keep it in Files or iCloud (`docs/runbooks/restore.md`).

## Optional extras

- **Branch protection** (Settings → Rules → New ruleset on `main`): require a PR, passing checks, linear history, no force pushes.

## Recovery

- **Lost every passkey?** In the Cloudflare dashboard, open [Durable Objects](https://dash.cloudflare.com/?to=/:account/workers/durable-objects), then the `Directory` object of the `ledgerline` Worker, and run `DELETE FROM passkey; DELETE FROM auth_session;` in its data browser (not tried yet from a phone; if it isn't there, ask a Claude session for a one-off fix). Then use the setup code again. If the old code may be known, change `SETUP_CODE` in the `production` environment and merge a change to redeploy first.
- **Rotating `TOKEN_KEYS`**: set it to `1:<old>,2:<new>` and add the secret `TOKEN_KEY_CURRENT` = `2` in the `production` environment, set the repository variable `ROTATE_TOKEN_KEYS` to `true`, then merge a change to deploy. Old rows keep decrypting with key 1. Set `ROTATE_TOKEN_KEYS` back to `false` afterwards: without it, a deploy never replaces the Worker's `TOKEN_KEYS`, so a wrong value in GitHub can't make the saved bank logins unreadable.

## Local development (computer)

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # fill in Sandbox keys and a token key
cd apps/worker && pnpm dev   # wrangler dev: the same config as production; each Durable Object migrates itself
# Load the prototype's November into your local budget (PLAID_ENV=sandbox, DEV_AUTH_EMAIL, DEV_ROUTES=1 and
# FAKE_NOW=2026-11-14T20:00:00Z in .dev.vars):
curl -X POST localhost:8787/__dev/seed-november -H 'content-type: application/json' -H 'x-ledgerline: 1' -d '{}'
```

`DEV_AUTH_EMAIL` in `.dev.vars` signs you in without a passkey locally; it is refused when `PLAID_ENV=production`. To try passkey sign-in locally, remove it, set `SETUP_CODE`, and open `http://localhost:8787` (not `127.0.0.1`).
