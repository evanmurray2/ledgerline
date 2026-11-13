# What we claim

Status: Nov 13, 2026 (claims 4, 7 and 8 brought up to date with the code the same day). Phase 8 of `docs/privacy.md`: each claim of section 1.1, whether it is true today for a
locked budget, its limit, and what backs it. The app no longer shows it (D-108). No outside review has been made;
one comes first only if the owner ever funds one.

**The rule:** this page says what is true today. A pull request that changes who can read what (`docs/privacy.md`
7), or makes a claim true or false, changes this page too, and `docs/privacy-policy.md` with it.

The owner's budget has been locked (sealed) since Nov 12, 2026, 22:24:55 UTC. Sign-up is closed, so it is the only
locked budget.

**Checkable** means a stranger can confirm it: from the public code, the reproducible build
(`docs/runbooks/verify-build.md`) or the build attestation. **Our word** means it rests on the public code being
what the server runs. Nobody outside can inspect a running Worker.

Every claim goes with this limit: _Like every web app, this depends on the code we send your browser. That code is
public. Code sent to one person once leaves no trace anyone else can see_ (`docs/privacy.md` 4.2).

## The claims

### 1. "Your budget is encrypted on your devices with a key we never hold."

- **True now.** The budget key is made on the first device (the owner's by the move, a new budget's at its start,
  D-102); the server stores the sealed log, the snapshots and the key slots, never the key
  (`apps/web/src/keys/budget.ts`, `apps/web/src/keys/new-budget.ts`, `apps/worker/src/local/start-device.ts`,
  `apps/worker/src/seal/log-store.ts`).
- **Limit:** 4.2 above. Cloudflare's 30-day history still holds the copy from before the lock (claim 2).
- **Backed by:** checkable. The app's code is public, the build is reproducible, and `/release.json` gives the
  release's build hash.

### 2. "We keep no readable copy of your budget."

- **Partly true now.** For the live store, true: store migration 0010 drops every old table, the usage events and
  notes from before the move with them, and empties the budget row but for its id (D-106). The Directory holds only
  the default name "My budget". Cloudflare's point-in-time recovery still holds the store's past states for 30 days,
  whatever is dropped: a restore to a time before the migration would bring the old tables back. So for that
  history the claim becomes true 30 days after the migration runs. Whether SQLite keeps freed pages readable inside
  a Durable Object is not checked (`docs/privacy.md` phase 0).
- **Build plan:** "Claims 2 and 3, 30 days after the old tables are dropped".
- **Backed by:** our word.

### 3. "We fetch your bank data from Plaid for you and seal it at once to a key that only your devices hold. We keep no readable copy of it."

- **Partly true now.** Since the move, each page is fetched and sealed in one job step, and no readable page is
  kept in the database or between steps (`apps/worker/src/seal/runs.ts`, `fetch-job.ts`). Bank data from before the
  move (`raw_page`, `bank_event`, `bank_txn`) was in the old tables, now dropped; Cloudflare's 30-day history still
  holds it until 30 days after the drop (claim 2).
- **Limit:** Plaid sees the bank data (4.1). It is in the Worker's memory between Plaid's answer and the seal, where
  Cloudflare could see it too. A changed Worker could alter or keep it (4.4).
- **Backed by:** our word.

### 4. "We do keep the key to your bank link. We use it only to fetch your bank data and to repair or remove the link. It means we could fetch your bank data again."

- **True now.** The token is in `bank_link`, encrypted under `TOKEN_KEYS`. A locked budget's server uses it to fetch
  (`seal/fetch-job.ts`), for repair (Plaid's update mode) and to remove the link at Plaid (`/item/remove`,
  `seal/sealed-routes.ts`; the delete job, `store/account-life.ts`). Removing a bank forgets the token.
- **Limit:** linking and removing in a locked budget are tested with a fake Plaid only, never against Plaid itself.
- **Build plan:** "Banks of a locked budget".
- **Backed by:** our word.

### 5. "The app has no ads, no trackers and no analytics. No outside script runs on any page that holds your budget or your keys. Sign-up has a robot check from Cloudflare, and you link a bank on Plaid's own page."

- **True now**, for every page of the app. The Content Security Policy (`apps/web/public/_headers`) is
  `script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-src 'none'`, with no outside host;
  `apps/web/test/headers.test.ts` fails if it loosens. Banks are linked and repaired on Plaid's hosted page.
- **Limit:** "Record how I use the app" is the app's own recorder, on unless turned off. For a locked budget the
  server answers its calls and keeps nothing (`seal/sealed-routes.ts`). Sign-up is closed. Its robot check
  (Turnstile) runs on its own address, a second Worker that holds nothing (`docs/privacy.md` 5.6, D-113,
  `apps/worker/src/check/`); the app's policy names no outside host for it. That Worker is built but not deployed
  yet.
- **Backed by:** checkable. Anyone can read the header the app sends (`curl -I` on the app's address).

### 6. "Sign-up asks for a passkey and nothing else: no name, no email address, no phone number."

- **True now** in the code (`apps/web/src/screens/Signup.tsx`, `apps/worker/src/routes/signup.ts`: a random value in
  `user.email`).
- **Limit:** sign-up is closed. The owner's account keeps the email address it had before (`docs/privacy.md` 5.6).
  Plaid's page may ask for a phone number; that is between the person and Plaid.
- **Backed by:** checkable, from the public code. The screen itself can't be seen while sign-up is closed.

### 7. "When you delete your account we delete what we hold and remove your bank links at Plaid. Copies last up to 30 days in Cloudflare's recovery; the sealed parts open only with your own keys."

- **Partly true now.** The delete job removes each bank at Plaid first, then wipes the store
  (`apps/worker/src/store/account-life.ts`). On Plaid Trial (Production with no `OTHER_USERS_BANKS`) only the admin
  links banks, and the admin's account can't be deleted, so Delete account is refused while an account has a bank
  link (`apps/worker/src/routes/people.ts`). Without a bank, the store wipes itself.
- **Limit:** whether a wiped store stays in point-in-time recovery, and whether deleted rows stay in freed pages, is
  not checked (`docs/privacy.md` 15.4).
- **Build plan:** "Privacy design, phase 0 checks".
- **Backed by:** our word.

### 8. "An account nobody opens for 24 months is deleted the same way. We stop fetching its bank data after 90 days."

- **True now.** The Directory's daily job marks an account nobody opened for 24 months and starts its deletion 30
  days later, as Delete account does; a request in between clears the mark. It never touches an admin's account, and
  starts at most 3 deletions a day (`apps/worker/src/store/idle-accounts.ts`). A budget nobody opened for 90 days
  queues no bank fetch until someone does (A3, `apps/worker/src/seal/fetch-job.ts`).
- **Limit:** an account with a bank link on Plaid Trial can't be deleted (claim 7), so the 24-month rule stops there
  too.
- **Backed by:** our word.

### 9. "The app's code is public, and every release is built from it in public."

- **True now** (D-96). The repository is public. `ci` builds twice and fails on any changed byte. Each build writes
  `/release.json`; the `deploy` run keeps the file list and attests it.
- **Checked on Nov 13, 2026**, for the release of commit `4cd9d1b`: a Linux build of that commit gave the build
  hash in `/release.json`; each of the 39 files the site serves had the hash in the list; the `deploy` run attested
  the list (its attestation names that digest, `deploy.yml` on `main` and the commit).
- **Limit:** it covers the app's files, not the code the Worker runs, and it can't catch files sent to one person
  once. `gh attestation verify` was not run against Sigstore's trust root (that check's network was blocked), and
  no build made on macOS was compared.
- **Build plan:** "Comparable releases, left open after phase 7".
- **Backed by:** checkable: the repository, the build log, the attestation (`docs/runbooks/verify-build.md`).

## Built for a locked budget since the move

- **Signing in with the recovery key** (`apps/worker/src/routes/recovery-key.ts`). The owner's budget was locked
  before this was set, so the owner turns it on once in Settings → Sign-in → Recovery key.
- **Linking a new bank, and removing a bank** (claim 4), tested with a fake Plaid only.
- **The idle job** (claim 8).
- **A full backup made on the device**, sealed with the recovery key (`apps/web/src/keys/backup.ts`). The server's
  dump is still refused for a locked budget.

## What the server still sees

For a locked budget, the server and whoever runs it still learn (`docs/privacy.md` 4.3):

- that the account exists, its passkeys, devices and their names, and when each last signed in;
- the size and time of each change, and how many there are;
- when each device checked its numbers against the other devices', at which change and for which month, with a
  value it can't read (D-116);
- for each bank link: its Plaid Item id, its token, which bank it is (Plaid's dashboard shows it), when it was linked, its state, when each bank update came, how
  many rows it added, changed and removed, and its size;
- the app's own log lines, for 3 days. They hold only an allowlist of fields: never amounts, names, descriptions,
  tokens or IP addresses (`apps/worker/src/http/context.ts` `log`). Cloudflare's invocation logs, which held each
  request's IP address, a location for it, the browser and its full address, are off since Nov 13, 2026 (D-112).
  Cloudflare still sees each request's IP address as it passes through (the sign-in rate limit counts by it), and
  logs from before that day age out after 3 days.

## What we never say

The list in `docs/privacy.md` 1.2 holds: not "we can't read your data", "zero-knowledge", "end-to-end encrypted",
"we keep nothing readable", "only you can see your transactions", "anonymous" or "audited".
