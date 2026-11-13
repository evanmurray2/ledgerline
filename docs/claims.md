# What we claim

Status: Nov 13, 2026. Phase 8 of `docs/privacy.md`: each claim of section 1.1, whether it is true today for a
locked budget, its limit, and what backs it. The app no longer shows it (D-108). Change it in the same pull request as
the code that changes what is true. No outside review has been made; one comes first only if the
owner ever funds one.

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
  (`seal/fetch-job.ts`) and for repair, Plaid's update mode (`seal/sealed-routes.ts`). Removing a bank is not built,
  so nothing uses it for that yet.
- **Limit:** a new bank can't be linked to a locked budget, and a bank can't be removed from one, yet.
- **Build plan:** "Linking and removing a bank in a locked budget".
- **Backed by:** our word.

### 5. "The app has no ads, no trackers and no analytics. No outside script runs on any page that holds your budget or your keys. Sign-up has a robot check from Cloudflare, and you link a bank on Plaid's own page."

- **True now**, for every page of the app. The Content Security Policy (`apps/web/public/_headers`) is
  `script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-src 'none'`, with no outside host;
  `apps/web/test/headers.test.ts` fails if it loosens. Banks are linked and repaired on Plaid's hosted page.
- **Limit:** "Record how I use the app" is the app's own recorder, on unless turned off. For a locked budget the
  server answers its calls and keeps nothing (`seal/sealed-routes.ts`). Sign-up is closed. Its robot check
  (Turnstile) loads a script from `challenges.cloudflare.com`, which this policy blocks: it needs the second address
  of `docs/privacy.md` 5.6, which is not built. Sign-up stays closed until it is.
- **Backed by:** checkable. Anyone can read the header the app sends (`curl -I` on the app's address).

### 6. "Sign-up asks for a passkey and nothing else: no name, no email address, no phone number."

- **True now** in the code (`apps/web/src/screens/Signup.tsx`, `apps/worker/src/routes/signup.ts`: a random value in
  `user.email`).
- **Limit:** sign-up is closed. The owner's account keeps the email address it had before (`docs/privacy.md` 5.6).
  Plaid's page may ask for a phone number; that is between the person and Plaid.
- **Backed by:** checkable, from the public code. The screen itself can't be seen while sign-up is closed.

### 7. "When you delete your account we delete what we hold and remove your bank links at Plaid. Copies last up to 30 days in Cloudflare's recovery; the sealed parts open only with your own keys."

- **Not true yet.** Delete account is refused while an account has a bank link, because nothing removes an Item at
  Plaid yet (`apps/worker/src/routes/people.ts`), and the admin's account can't be deleted. Without a bank, the store
  wipes itself.
- **Limit:** whether a wiped store stays in point-in-time recovery, and whether deleted rows stay in freed pages, is
  not checked (`docs/privacy.md` 15.4).
- **Build plan:** "Linking and removing a bank in a locked budget"; "Privacy design, phase 0 checks".
- **Backed by:** our word.

### 8. "An account nobody opens for 24 months is deleted the same way. We stop fetching its bank data after 90 days."

- **Not true yet.** Neither the idle job nor A3 (no fetch after 90 idle days) is built. Today nothing is deleted for
  being idle; a budget with no bank rests after 30 idle days.
- **Build plan:** "The idle job".
- **Backed by:** our word.

### 9. "The app's code is public, and every release is built from it in public."

- **True now** (D-96). The repository is public. `ci` builds twice and fails on any changed byte. Each build writes
  `/release.json`; the `deploy` run keeps the file list and attests it.
- **Limit:** it covers the app's files, not the code the Worker runs, and it can't catch files sent to one person
  once. Nobody has yet checked a live release's attestation with `gh attestation verify`, or compared a build made
  on macOS.
- **Build plan:** "Comparable releases, left open after phase 7".
- **Backed by:** checkable: the repository, the build log, the attestation (`docs/runbooks/verify-build.md`).

## Not built yet for a locked budget

Each has a line in `docs/build-plan.md`.

- **Signing in with the recovery key.** The key opens the budget's slot, but it can't yet give back a sign-in.
- **Linking a new bank, and removing a bank** (claims 4 and 7).
- **The idle job** (claim 8).
- **A full backup made on the device.** The server's dump is refused for a locked budget.

## What the server still sees

For a locked budget, the server and whoever runs it still learn (`docs/privacy.md` 4.3):

- that the account exists, its passkeys, devices and their names, and when each last signed in;
- the size and time of each change, and how many there are;
- for each bank link: its Plaid Item id, its token, which bank it is (Plaid's dashboard shows it), when it was linked, its state, when each bank update came, how
  many rows it added, changed and removed, and its size;
- in Cloudflare's invocation logs, for 3 days: each request's IP address, a location for it, the browser, and its
  full address. The owner keeps these logs on for now (D-90); they are turned off before any claim about IP
  addresses is made. The app's own log lines hold only an allowlist of fields: never amounts, names, descriptions
  or tokens (`apps/worker/src/http/context.ts` `log`).

## What we never say

The list in `docs/privacy.md` 1.2 holds: not "we can't read your data", "zero-knowledge", "end-to-end encrypted",
"we keep nothing readable", "only you can see your transactions", "anonymous" or "audited".
