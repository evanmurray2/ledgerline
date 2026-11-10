# Privacy design: a server that can't read a budget

Status: v1, Nov 10, 2026. A proposal: nothing here is built, and nothing is decided. It needs the owner's answers (section 14) before any work starts. `docs/architecture.md` says what runs today.

What the owner asked: to offer Ledgerline to other people as a privacy-focused budget app, with the strongest privacy and security claims that can be made honestly, and to know what has to change and what users would see.

## 0. The short answer

Today the server stores every budget as plain text, so the honest claim is "we don't look". This design changes that to "we can't look":

1. **The budget is encrypted on the device** with a key the server never has. The server stores only sealed data.
2. **All the work on budget data moves to the device**: bank processing, matching, the daily scan. The device already runs the server's routes (D-45, D-46), so this finishes a move that is half done.
3. **Bank data passes through the server and is not kept.** The device, not the server, holds each bank link's access token.
4. **No foreign script runs in the app**, no email address is collected, and logs hold nothing about a person.
5. **The code is public** and each release can be checked against it.

Three limits stay whatever is built (section 4): Plaid sees bank data; a web app runs the code its server sends; and the server sees that an account exists and when it is used. The claims in section 1 are worded around those limits. The only budget with no asterisk at all is one with no bank link.

The price for users: **nobody can reset an account.** A person who loses every passkey and the recovery key loses the budget.

## 1. The claims

### 1.1 What could be said, and what makes each true

| Claim (plain words)                                                                                                                                         | True when                                                         | Proof a stranger can check                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| "Your budget is encrypted on your devices. We can't read it, and neither can anyone who breaks into our servers."                                           | Phases 2–4, and 30 days after the last plain-text row is cleared  | Public code (5.9), outside audit (11)             |
| "We keep no copy of your bank data. It passes through our server on its way from Plaid to your device."                                                     | Phase 5                                                           | Public code, audit                                |
| "We hold no access to your bank. Your device holds the key to each bank link, and it never leaves your devices unsealed except to fetch your transactions." | Phase 5                                                           | Public code, audit                                |
| "No ads, no trackers, no analytics, no outside scripts."                                                                                                    | Phase 1 (Plaid Link leaves the page, 5.7)                         | The Content Security Policy header: `'self'` only |
| "No email address, no name, no phone number."                                                                                                               | Phase 1                                                           | The sign-up screen                                |
| "Delete means gone: the keys are destroyed at once, and the sealed data within 30 days."                                                                    | Phase 1 for the flow, phase 4 for "sealed"                        | Public code                                       |
| "The code is public, and every release is built from it in public."                                                                                         | Phase 6                                                           | The repository, the build log, the attestation    |
| "Entered by hand, a budget is end-to-end encrypted with no exception."                                                                                      | Phase 4, plus accounts without a bank link (`docs/build-plan.md`) | Public code, audit                                |

### 1.2 What must never be said

- **"Zero-knowledge"** or **"end-to-end encrypted"** with no qualifier, for a budget with a bank link. The server relays bank data in transit and learns usage metadata (4.3).
- **"Nobody but you can see your transactions."** Plaid can, and so can the bank.
- **"We can't be forced to hand over data."** We can be forced to hand over sealed data and metadata, and in principle to ship changed code (4.2).
- **"Anonymous."** Cloudflare sees IP addresses, and Plaid knows who the person is.
- "Bank-level", "military-grade", "unhackable": they mean nothing and invite a complaint.

### 1.3 The one-line pitch that survives a hostile reader

> Your budget is encrypted on your devices. We can't read it. Bank data comes through Plaid and passes through our server without being stored. No email, no trackers, public code.

## 2. Who can see what today

| Data                                                         | Where it is today                                               | Who can read it today                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------- |
| Transactions, payees, amounts, categories, notes, balances   | `BudgetStore` SQLite, plain text                                | The operator, Cloudflare, anyone with the account         |
| Raw Plaid pages and the bank log (`raw_page`, `bank_event`)  | `BudgetStore`, plain text, never deleted                        | The same                                                  |
| Plaid access tokens                                          | `connection.access_token_enc`, AES-GCM under `TOKEN_KEYS`       | The Worker (it holds the key), so the operator            |
| Budget name, the user's email, passkey public keys, sessions | `Directory`, plain text (`user.email NOT NULL`)                 | The operator                                              |
| Usage events and notes (`usage_event`, `usage_note`)         | `BudgetStore`, plain text; an export reads them                 | The operator                                              |
| The copy on the device                                       | IndexedDB, AES-GCM, key from the passkey plus a server share    | The user                                                  |
| Request logs                                                 | Workers Logs, 3 days: path, status, CPU; an allowlist of fields | The operator                                              |
| 30 days of every store's past                                | Cloudflare point-in-time recovery                               | The operator, through a restore                           |
| Everything in the page while it is open                      | The browser                                                     | Our code, and Plaid's script (`cdn.plaid.com` in the CSP) |

`docs/threat-model.md` already accepts this for one owner: "a compromise of your Cloudflare account exposes the data and the secrets". That sentence is what has to stop being true.

## 3. Who we defend against

| Who                                                                                                                                              | Today                                             | After this design                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A stranger on the internet                                                                                                                       | Stopped                                           | Stopped                                                                                                                                 |
| Someone who steals the database, a backup or a restore                                                                                           | Reads everything                                  | Gets sealed data and metadata                                                                                                           |
| Someone who takes over the Cloudflare account, read only                                                                                         | Reads everything                                  | Gets sealed data and metadata                                                                                                           |
| The operator being curious, or being served a legal demand for stored data                                                                       | Reads everything                                  | Has only sealed data and metadata to give                                                                                               |
| A stolen Worker secret (`TOKEN_KEYS`, Plaid keys)                                                                                                | Can pull 24 months of bank history for every link | Can pull nothing: the server holds no access tokens                                                                                     |
| Someone who can **change the code the server sends** (a taken-over Cloudflare or GitHub account, a bad dependency, an operator under compulsion) | Reads everything                                  | **Can still read the budgets of people who open the app while the bad code is live** (4.2). Phase 6 makes this visible, not impossible. |
| Plaid                                                                                                                                            | Sees bank data                                    | Sees bank data (4.1)                                                                                                                    |
| Someone with the unlocked device and its passcode                                                                                                | Reads the budget                                  | Reads the budget                                                                                                                        |
| A server that lies: drops, repeats or reorders changes                                                                                           | Not considered                                    | Detected by devices that have seen the budget before (5.3)                                                                              |

## 4. Limits no design here removes

### 4.1 Plaid sees the bank data

Plaid fetches transactions from the bank and keeps them under its own policy. Its API gives data only to a server that holds our Plaid secret, so that data must pass through our Worker. There is no way to have Plaid encrypt to the user's device. The claim is therefore about what we **store**, and the privacy policy names Plaid and links its policy and its page where a person can see and remove connections.

A budget with no bank link has none of this. That is why "accounts without a bank link" (`docs/build-plan.md`) matters for privacy, not only for sign-up: it is the only fully end-to-end mode. It waits on the owner's Money-rules answers about starting balances.

### 4.2 A web app runs whatever its server sends

The keys live in the browser, and the browser runs the JavaScript the Worker serves on each visit. Whoever controls that JavaScript can read the keys. A service worker can't prevent this: the browser replaces a service worker with whatever new one the server sends. No web-only design closes this gap. What can be done:

- make every release public and checkable (5.9), so a bad release leaves evidence;
- make it hard to ship code without the owner seeing it (5.10);
- or ship an app from an app store, where the code is signed and can't change per visit. That costs a yearly developer fee, which breaks the $0 rule (section 14, question 5).

So the claim "we can't read it" means: the server as built can't, stored data can't be read later, and reading it would take shipping changed code in public view.

### 4.3 The server still learns some things

- That an account exists, when it was made, how many passkeys and devices it has.
- When the app is used, from which IP address (Cloudflare sees it; we don't store it), and roughly how much changes (sealed entries are padded to size steps, 5.2).
- How many bank links a budget has, their Plaid Item ids, and when Plaid says each has news.
- Bank data in the Worker's memory for the moment it is relayed (5.5).

### 4.4 The device

Someone with the unlocked device and its passcode reads the budget, as today (`docs/phone-budget.md` 13.6). A jailbroken device, a malicious browser extension on a computer, and the iOS keyboard's learning are outside what the app controls.

## 5. Design

### 5.1 Shape

```
            Plaid ──(bank data, TLS)──▶ Worker ──(relayed, not stored)──▶ device
                                          │                                  │
                                          │                      engine: all budget work
                                          │                      (routes, matching, scans)
                                          ▼                                  │
   Directory: accounts, passkeys, sessions,                                  │
   key slots (sealed), Item ids, usage counts     ◀──(sealed entries)────────┘
   BudgetStore: a sealed log + a sealed snapshot
```

The server keeps doing four things: sign-in, storing and ordering sealed entries, relaying Plaid calls, and counting usage for the free plan's limits. It stops doing everything that reads a budget.

### 5.2 Keys

All cryptography uses WebCrypto (AES-256-GCM, HKDF-SHA-256, X25519, SHA-256), which Safari and Workers both have. No hand-written primitives.

- **Budget key.** 256 random bits made on the device when the budget is made. It never leaves a device unsealed. HKDF derives one key per use from it: log entries, snapshots, bank tokens, the settings blob.
- **Key slots.** The budget key is stored on the server only wrapped, once per way in:
  - **one slot per passkey**, wrapped under HKDF of that passkey's PRF output (the WebAuthn `prf` extension the copy already uses, `apps/web/src/copy/vault.ts`). The PRF salt is per passkey and public. The PRF output is already stripped before the sign-in answer is posted (`docs/phone-budget.md` 13.2).
  - **one recovery slot**, wrapped under a key from the recovery key (5.8).
- **A passkey with no PRF can't open a budget.** Today such a passkey opens the budget in memory (D-57 item 4); after this it can sign in but has no key. Registration requires PRF. iCloud passkeys on iOS 18 and later have it; older systems don't.
- **The copy on the device stays as built**: its own data key, wrapped under the passkey's PRF output and the per-device server share, so "Sign out other devices" still turns a copy off. The budget key is kept inside that vault.
- **Adding a device.** A passkey synced by iCloud Keychain gives the same PRF output on every Apple device, so its slot just works. For a new passkey, the 10-minute link made on a signed-in device (D-27) carries a one-time secret in the part of the link after `#`, which browsers never send to a server; the old device uploads the budget key wrapped under that secret, and the new device unwraps it and writes its own slot.
- **Inbox key pair.** An X25519 pair per budget; the private half is sealed under the budget key. The server uses the public half for the one thing that can arrive while no device is open: a new bank link's access token (5.5).
- **Later, not now:** a post-quantum hybrid for the inbox key pair. Everything else is symmetric and already safe against that.

Associated data on every sealed value names the budget, the kind of value and its position, so the server can't swap one sealed value for another.

### 5.3 What the server stores: a sealed log

`BudgetStore` keeps two things per budget and no budget tables:

- **`sealed_log`**: one row per change set, with a number that only grows. The body is the list of row changes that one edit or one bank step made to the synced tables, sealed under the log key. Its associated data holds the budget id, the entry's number, the hash of the entry before it, and the format. Bodies are padded to size steps (256 bytes, 1 KB, 4 KB, 16 KB, 64 KB) so their length says little.
- **`sealed_snapshot`**: the whole copy, sealed, in chunks, as of some entry number. A device writes a new one from time to time, so a new device downloads a snapshot and a short tail instead of the whole log. Entries older than the snapshot are deleted after 30 days.

Entries hold **results** (rows), not operations. A device applying an entry writes rows; it doesn't re-run logic, so two app versions can't work out different numbers from the same entry. Each entry carries the schema version; a device older than that version says "Update Ledgerline" and stops.

**Writes are compare-and-swap.** A device sends `{ base: N, entries }`. The server appends only if the log's last number is `N`; otherwise it answers with the entries after `N`. The device then undoes its local change (a SQLite savepoint), applies the newer entries, runs the same edit again and resends. This keeps one order of changes for every device, which is what the server's single writer gives today. The offline queue works the same way as now (`OFFLINE_EDITS`): a queued edit is run again on top of what arrived.

**A lying server.** Every entry is authenticated with a key the server lacks, so it can't forge or alter one. Each entry names the hash of the one before it, and each device remembers the last number and hash it saw. A server that drops, repeats or reorders entries is caught by any device that has seen the budget before. It is not caught by a brand-new device shown an older but consistent past; setting up a device therefore shows "Last change: {date}, from {device}" to confirm.

**Restores.** Today a restore is the operator rolling a store back (`docs/runbooks/restore.md`, D-77). To a device, that now looks like a lying server. The device, which holds a full copy, becomes the way to recover: "The server's copy is older than this device's. Send this device's copy / Use the server's." The full backup file (5.8) restores the same way, which also closes the open item "Full backup can't be restored".

### 5.4 All budget work moves to the device

The engine (`apps/worker/src/local`) already runs `budgetApi`, the server's routes and SQL, on sql.js. What it doesn't run yet is everything that happens on alarms. That moves too:

| Work                                                                                                                | Today                                      | After                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| Edits (`routes/*.ts`)                                                                                               | Checked and stored by the server           | Run in the engine; the result goes into the sealed log                 |
| Bank sync: fetch, apply, process (`sync/steps.ts`, `process.ts`, `pending-match.ts`, `pairing.ts`, `file-fresh.ts`) | `BudgetStore` alarm jobs, 25 events a step | The engine, when the app is open, on pages relayed by the Worker (5.5) |
| Daily scan, maintenance (`daily-scan.ts`, `maintenance.ts`)                                                         | Alarms at 5:00 and 2:20                    | The engine, on the first open of the day                               |
| The bank log (`bank_event`, `bank_page`)                                                                            | Server only, append-only by trigger        | In the copy, with the same triggers                                    |
| Raw Plaid pages (`raw_page`)                                                                                        | Server only, kept forever                  | Section 14, question 4: keep in the copy, or stop keeping them         |
| Screens                                                                                                             | The engine                                 | The engine (no change)                                                 |
| Health and alerts                                                                                                   | Server writes them                         | The engine writes them                                                 |

The sync guarantees in `docs/sync-spec.md` (the cursor never moves backwards; retries add nothing) hold because the cursor and the lease live in the budget itself and every write is compare-and-swap: of two devices processing the same page, the second finds the cursor already moved and does nothing.

**The Money rules don't change.** The same code runs on the same rows. What changes is where and when it runs, so this must be proven, not assumed: phase 3 runs the device's processing beside the server's on the owner's real budget and compares every row before the server's is switched off.

The 10 ms CPU rule stops applying to this work; the device has no such limit. Step sizes can grow.

### 5.5 Bank data: relayed, not stored

- **The device holds the access token.** It is kept in the budget, sealed. The server's `connection.access_token_enc` and the `TOKEN_KEYS` secret go away.
- **Fetching.** The device sends `{ token, cursor }` to `POST /api/bank/fetch`. The Worker adds the Plaid client id and secret, calls `/transactions/sync` (and `/accounts/get`, liabilities), and streams Plaid's answer back without parsing or storing it. `packages/bank-provider/src/plaid.ts` already reads the cursor out of a page without parsing it. Nothing from the body is logged.
- **Webhooks.** Plaid's webhook still reaches the Worker and is still verified. The Directory records only "this Item has news"; the device asks on open and on its 2-minute check.
- **Linking.** After Link finishes (5.7), the Worker exchanges the public token, seals the access token to the budget's inbox key, and forgets it. The device collects it. A token no device collects in 24 hours is removed at Plaid and dropped.
- **Repair and removal.** The device sends the token with the request; the Worker calls Plaid and forgets it.

What this buys over today: a thief who takes the database and every Worker secret can pull no bank data, because nothing on the server can ask Plaid for any. Only people who use the app while an attacker controls the running Worker are exposed.

What it costs: nothing is fetched while the app is closed (section 7), and an account whose owner disappears leaves a live Item at Plaid that the server can't remove (section 14, question 3).

**Considered and not chosen:** the server keeps the token, fetches in the background, and seals each page to the inbox key. Opening the app would be faster. But the server would keep standing access to every user's bank history, which is the larger part of the risk.

### 5.6 Identity and metadata

- **No email.** `user.email` is `NOT NULL UNIQUE` today. New accounts get a random handle there (the column stays; migrations are expand-only). The passkey's own handle already exists (`docs/open-signup.md` 6). Notices that would need an email, such as a security notice, show in the app at sign-in.
- **Budget name and bank names** move into the sealed budget. The Directory keeps ids only.
- **Usage events and notes** (`usage_event`, `usage_note`) stay on the device, sealed with the budget. A person can export their own. The operator gets none from other people.
- **Logs.** Paths become generic (`/api/log`, `/api/bank/fetch`), so a path no longer holds a transaction id. Check what Cloudflare's invocation logs record besides path and status, and turn them off if it is more than that. The app never stores an IP address; the sign-in rate limiter uses it in passing.
- **Turnstile** at sign-up is Cloudflare's, the same company that already hosts the app.

### 5.7 No foreign script in the app

Today the CSP allows `https://cdn.plaid.com` as a script source, and Plaid Link's script runs in the same page as the keys (`docs/phone-budget.md` 13.5 reloads the page after Link for this reason). With the budget key in the page, that is no longer acceptable.

Use Plaid's hosted Link: the app opens a page on Plaid's own site, the person links the bank there, and Plaid tells our server when it is done. The CSP becomes `script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'` with no `frame-src`. To check in phase 0: that hosted Link is offered on our Plaid plan and works from the Home Screen app.

Also: drop `'unsafe-inline'` from `style-src`, add Trusted Types where the browser has them, and keep the CSP test that fails when any source loosens.

### 5.8 Recovery, backup, deleting

- **Recovery key.** 256 random bits, shown once at sign-up as words or letter groups, with "write this down". HKDF splits it in two: one half proves to the server that the person may add a passkey (the server stores only its hash, as with today's recovery code, `docs/open-signup.md` 4); the other half unwraps the recovery slot. It replaces the recovery code. Settings can make a new one, which replaces the slot.
- **No reset, by anyone.** The owner's runbook recovery (`docs/runbooks/setup.md`) can give back a sign-in, but not a budget. The owner needs a recovery key too.
- **Full backup.** Made on the device. The person picks: sealed with a passphrase (the default), or plain, with a warning. `GET /api/export/dump` goes away. Restoring is 5.3.
- **Deleting an account.** The device sends each bank token so the Worker can remove the Item at Plaid; the Directory deletes the key slots first, then the store wipes itself (`docs/open-signup.md` 12 keeps its order). Cloudflare's point-in-time recovery keeps the sealed bytes for up to 30 days; with the slots gone and the budget key never on the server, they can't be opened.
- **Idle accounts.** Today nothing is deleted for being idle. A privacy claim is stronger with a limit (section 14, question 6).

### 5.9 Public, checkable releases

- The repository becomes public. Before that: read the history for anything that shouldn't be public (ids in `CLAUDE.md` and the runbooks are not secrets, but check).
- The web build is made reproducible: the same commit gives the same files, byte for byte.
- The deploy workflow publishes the list of file hashes for each release with a build attestation (free for public repositories), and Settings → About shows the release's commit and hash.
- Anyone can then compare what the site serves with what the public build made. This detects a changed release after the fact. It doesn't stop a server from sending one person different code once (4.2), and the doc and the policy say so.

### 5.10 Who can ship code

After this design, the code path is the whole attack surface. Today every Claude session merges its own PRs and each merge deploys (`CLAUDE.md`). For a product with other people's budgets:

- A change under the key and sealing code, the CSP (`apps/web/public/_headers`), `sw.js`, the build, or `.github/workflows` needs the owner's review before merging. `.github/CODEOWNERS` already names the owner; branch protection would enforce it for those paths.
- No new runtime dependency in the key and sealing code without the owner's review.
- Hardware-key or passkey two-step sign-in on Cloudflare, GitHub and Plaid (`docs/threat-model.md` already says so), and a Cloudflare API token that can deploy the Worker and nothing else.

### 5.11 What stays the same

Passkey sign-in, sessions, the 15-minute recent-passkey rule, CSRF checks, rate limits, the breaker and fair-use shares (they count requests and rows, not content), the one cron, deploys by merge, and every Money rule.

## 6. What changes in the code

| Area                                                | Change                                                                                                                                                                                                             | Size   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `apps/web/src/copy`                                 | Budget key, slots, recovery key, device-add secret, sealing and opening entries, hash chain, compare-and-swap with redo, snapshot upload                                                                           | Large  |
| `apps/worker/src/local`                             | Run the job runner, bank steps, daily scan and maintenance; hold the bank log tables; capture each edit's row changes                                                                                              | Large  |
| `apps/worker/src/routes`, `sync`, `ledger`, `views` | No logic change. They run only on the device; later they move out of `apps/worker` into a shared package                                                                                                           | Medium |
| `apps/worker/src/store/budget-store.ts`             | Becomes the sealed log and snapshot store; jobs, dump and heavy-read code go                                                                                                                                       | Large  |
| `apps/worker/src/store/directory.ts`                | Key slots, inbox public key, "Item has news" flags; no email; delete order                                                                                                                                         | Medium |
| `packages/bank-provider`                            | Relay calls that take the token from the request; hosted Link                                                                                                                                                      | Medium |
| `packages/platform/src/token-crypto.ts`             | Removed after the owner's tokens move to the device                                                                                                                                                                | Small  |
| Migrations                                          | New: `sealed_log`, `sealed_snapshot`, key slots. Old budget tables are emptied, never dropped (expand-only). **Forward-only, on the owner's real budget.**                                                         | Medium |
| Tests                                               | `engine.test.ts` loses its server side and becomes the main suite; new: two-device races, redo after a refused write, a lying server, key slots, recovery; the e2e Worker suite needs a device for every bank step | Large  |
| `apps/web/public/_headers`, `sw.js`                 | CSP `'self'` only; reproducible build                                                                                                                                                                              | Small  |
| Docs                                                | `architecture.md`, `threat-model.md`, `sync-spec.md` notes, runbooks, a decision per phase                                                                                                                         | Medium |

This is the largest change since the budget moved to the phone. It removes more server code than it adds.

## 7. What the user sees

| Where                         | Today                                               | After                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-up                       | Passkey, then a recovery code                       | Passkey, then a **recovery key** with a plain warning: "If you lose your passkeys and this key, your budget is gone. We can't reset it." A confirm step asks for part of the key back. |
| Sign-up                       | (an email, if open sign-up asked for one)           | No email, no name                                                                                                                                                                      |
| Opening the app               | Bank rows are already in, fetched in the background | "Getting your bank's latest" for a moment on open; rows arrive while the app is open, not while it is closed                                                                           |
| After days away               | Up to date at once                                  | A longer catch-up on the first open; the daily scan runs then                                                                                                                          |
| Linking a bank                | Plaid Link opens inside the app                     | The app hands off to Plaid's page and comes back                                                                                                                                       |
| A new device                  | Sign in; the budget downloads                       | The same with an iCloud passkey. With a separate passkey: the link from a signed-in device, as today, or the recovery key                                                              |
| An old browser or system      | Works, with the copy in memory                      | "This device can't open an encrypted budget" (no PRF)                                                                                                                                  |
| Two devices at once           | Both edit; the server orders them                   | The same; a refused write redoes itself unseen                                                                                                                                         |
| Settings → Backup             | Full backup downloads from the server               | Made on the device; passphrase by default; "Restore from a backup" exists                                                                                                              |
| Settings → Sign-in            | Passkeys, devices, recovery code                    | Adds "Recovery key: make a new one"                                                                                                                                                    |
| Settings → About              | Version                                             | Version, release commit and hash, a link to the public build                                                                                                                           |
| Settings → Privacy (new)      | Nothing                                             | What is sealed, what the server knows (4.3), who else handles data (Cloudflare, Plaid), delete account                                                                                 |
| Delete account                | Refused with linked banks                           | Works; removes the banks at Plaid; says what is kept 30 days and that it can't be opened                                                                                               |
| A restore                     | The operator restores for you                       | The device offers to send its copy; the operator can't see or fix a budget                                                                                                             |
| Support                       | The operator can look                               | The operator can't look. Help is by description, or a backup the person chooses to send                                                                                                |
| A lying or rolled-back server | Not shown                                           | "The server's copy doesn't match this device's" with the two choices                                                                                                                   |

All new text follows `docs/copy.md`.

## 8. Moving the owner's budget

The owner's budget is real and the migration is forward-only, so this needs the owner's yes before it merges (`CLAUDE.md`).

1. Take a full backup. Check PRF on every device the owner uses.
2. The device downloads everything, including the bank log, and checks counts and hashes against the server (the dump's verify code exists, `apps/worker/src/store/dump.ts`).
3. Phase 3's side-by-side run has matched for two weeks.
4. The device makes the budget key, the slots and the recovery key, and uploads the first sealed snapshot. The server marks the budget sealed and refuses the old plain-text routes.
5. The device collects the 7 Plaid access tokens. **No bank is linked, re-linked or removed**: the tokens move; the Items stay.
6. A later release empties the old tables. Point-in-time recovery still holds plain text for 30 days after that. Until then, a restore to before step 4 is the way back.
7. `TOKEN_KEYS` is deleted from the Worker by the owner, after step 6.

Claims about "can't read" start 30 days after step 6, not before.

## 9. The free plan

- Server CPU per request falls: appending a sealed row and relaying a stream are both small. Measure both (`docs/measurements.md`); relaying must stay stream-only to hold the 10 ms rule.
- Durable Object rows fall: one row per edit, not one per changed row plus `change_log`.
- Worker requests rise a little: each Plaid page is one relayed request while the app is open, where today it is an alarm.
- Device work rises: processing a bank page, sealing, a snapshot. Measure on the owner's iPhone in phase 0: opening a sealed snapshot of today's budget, and processing 100 bank rows.
- The breaker and shares keep working; they need counts, not content.

## 10. Phases

Each phase ships alone and leaves the app working. A decision file records each (`docs/decisions/`).

| Phase | What                                                                                                                             | Claims it unlocks                                                 | Risk to the owner's budget      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------- |
| 0     | The owner's answers (14). Measure: PRF on each device, sealed snapshot time, hosted Link, relay CPU, copy size with the bank log | None                                                              | None                            |
| 1     | Hosted Link and a `'self'`-only CSP; no email; log check; delete account with banks; Settings → Privacy; a privacy policy        | No trackers or outside scripts; no email; delete                  | Low                             |
| 2     | Budget key, key slots, recovery key, device-add secret. Keys exist; nothing is sealed yet                                        | None                                                              | Low                             |
| 3     | Bank processing, daily scan and maintenance run in the engine **beside** the server's, and every row is compared                 | None                                                              | None (the server still decides) |
| 4     | The sealed log: the device writes, the server stores sealed entries; the owner's budget moves (8)                                | "We can't read your budget", 30 days after the tables are emptied | **High: forward-only**          |
| 5     | The relay: tokens on the device; `TOKEN_KEYS` goes                                                                               | No stored bank data; no bank access                               | Medium                          |
| 6     | Public repository, reproducible build, attestation, About screen, review rule for the key code                                   | Public, checkable code                                            | None                            |
| 7     | An outside review of the key design and the code; fix what it finds; then publish the claims                                     | All of section 1.1, in public                                     | None                            |

Phases 1 and 6 need no other phase and can go first. Open sign-up still waits for Plaid Production (D-78); nothing here changes that.

## 11. Outside the code

- **A privacy policy and terms** written from section 2 and 4.3: what is stored, what is sealed, who else handles data (Cloudflare, Plaid), how long, how to delete, and the "no reset" rule.
- **A lawyer**, before sign-up opens. Questions to bring: whether US rules for companies handling consumer financial data apply to this app; state privacy laws; GDPR if anyone in Europe can sign up; breach notice duties with no email address on file.
- **Plaid Production** has its own security and privacy review, and requires a privacy policy and the person's consent screen.
- **An outside audit** of the key design and its code. Without one, "we can't read it" is our word. Audits cost money once (section 14, question 5).
- **A security contact**: a `security.txt` and a short disclosure policy in the repository.
- **A page that says what we can hand over** if asked by a court: sealed data, account dates, usage counts, Item ids.

## 12. What this design doesn't do

- It doesn't hide bank data from Plaid or from the Worker's memory during a relay.
- It doesn't stop changed code from reading a budget (4.2).
- It doesn't hide IP addresses, times of use or sizes from Cloudflare.
- It doesn't let two people share one budget. That would need each person's public key and a way to check it, which is its own design.
- It doesn't protect a budget on an unlocked or compromised device.
- It doesn't let anyone recover a budget whose keys are lost.

## 13. Risks

| Risk                                                                               | What limits it                                                                                                 |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| The device's processing differs from the server's and money is counted differently | Phase 3 compares every row on the real budget before the switch; `engine.test.ts`; same code, same SQL         |
| A person loses the passkeys and the recovery key                                   | iCloud passkeys sync; the confirm step at sign-up; a reminder until a backup or second passkey exists          |
| A bug in sealing loses data                                                        | The copy on the device is whole; the server never deletes an entry a snapshot doesn't cover; full backup first |
| Two devices fight over writes                                                      | Compare-and-swap with redo; tests with two engines                                                             |
| The copy grows with the bank log and opens slowly                                  | Measured in phase 0; question 4                                                                                |
| An Item is left at Plaid when an account is abandoned                              | Question 3                                                                                                     |
| A sealed format or key mistake found after launch                                  | Every sealed value carries a format number; an outside review before the claims are published                  |
| The owner's own budget during the move                                             | Section 8; point-in-time recovery for 30 days after                                                            |

## 14. Questions for the owner

1. **No reset.** Is "lose the passkeys and the recovery key, lose the budget" acceptable for the product, and for your own budget?
2. **Bank rows only while the app is open.** Accept the catch-up on open (5.5), or keep background fetching and give up the "no bank access" claim?
3. **Abandoned accounts with bank links.** The server can't remove an Item without the device's token. Options: (a) accept it and remove what Plaid's support will remove; (b) the server keeps a sealed copy of each token that it can open, used only for removal, and the "no bank access" claim becomes "no bank access in use". Recommended: (a), and ask Plaid what it offers.
4. **Raw Plaid pages.** Keep them in the copy on the device (bigger, slower to open), or stop keeping them and keep only the bank log? This touches `docs/sync-spec.md`, not how money is counted.
5. **The $0 rule.** Two things that make the claims stronger cost money: an outside audit (once) and an app-store app (yearly). Both stay out unless you say otherwise.
6. **Idle accounts.** Delete an account not opened for some long time (for example 24 months) after in-app warnings, or keep everything forever as today?
7. **Review before merge** for the key code and the shipping path (5.10). This changes the "merge your own PR" rule in `CLAUDE.md` for those paths.
8. **Public repository.** Yes or no, and when.
9. **Order.** Phases 1 and 6 first (small, visible), or straight to 2–5?

## 15. Review

Not yet reviewed.
