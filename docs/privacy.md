# Privacy design: a server that holds no key to a budget

Status: v4, Nov 10, 2026. A proposal: nothing here is built. The owner's answers of Nov 10 (D-85) are now part of the design instead of a list of questions, so this version describes one design, not a choice of shapes. v1 and v4 each got two adversarial reviews; section 15 lists what they found. `docs/architecture.md` says what runs today. The next step is phase 0 (section 10).

What the owner asked: to offer Ledgerline to other people as a privacy-focused budget app, with the strongest privacy and security claims that can be made honestly, and to know what has to change and what users would see.

## 0. The short answer

Today the server stores every budget as plain text, so the honest claim is "we don't look". This design changes that to "we hold no key":

1. **The budget is encrypted on the device** with a key the server never has. The server stores only sealed data.
2. **All work on budget data moves to the device**: every edit, bank processing, matching, the daily scan. The device already works out every screen (D-45, D-46), but most edits and all bank work still run on the server, so this is a large move.
3. **The server still fetches bank data from Plaid in the background, as today, but seals each page at once** with a key only the person's devices can open, and keeps nothing readable. It keeps the key to each bank link, so it can fetch, repair and remove a link.
4. **No outside script runs where the keys are**, no email address is collected, and logs hold nothing about a person.
5. **The code is public** and each release can be compared with it.

Four limits stay whatever is built (section 4): Plaid sees bank data; a web app runs the code its server sends; the server sees that an account exists and when it is used; and the server can lie about bank data and the time. The claims in section 1 are worded around those limits.

What it costs (all accepted by the owner, D-85):

- **Nobody can reset an account, and nothing can be restored.** A person who loses every passkey and the recovery key loses the budget.
- **An account not opened for 24 months is deleted.**
- **No Money rule changes.** The rules that count by when a bank row arrived (D-67, D-68) keep the server's arrival times.

## 1. The claims

### 1.1 What can be said, and what backs each

"Checkable" means a stranger can confirm it. "Our word" means it rests on the public code being what runs: nobody outside can inspect a running Worker, and no outside audit is paid for (the $0 rule).

| Claim (plain words)                                                                                                                                                                           | True from                                        | Backed by                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| "Your budget is encrypted on your devices with a key we never hold. What we store can't be read by us, or by anyone who copies it."                                                           | 30 days after the old tables are empty (phase 6) | The app's public code (checkable, 5.9)                    |
| "We keep no readable copy of your bank data. We fetch it from Plaid for you and seal it at once; only your devices can open it."                                                              | The same                                         | Our word                                                  |
| "We use the key to your bank link only to fetch your bank data, and to repair or remove the link."                                                                                            | Phase 5                                          | Our word                                                  |
| "No ads, no trackers, no analytics. No outside script runs on any page that holds your budget or your keys."                                                                                  | Phase 1                                          | Checkable: the Content Security Policy header             |
| "No email address and no phone number."                                                                                                                                                       | Phase 1                                          | Checkable: the sign-up screen                             |
| "When you delete your account we delete everything we hold and remove your bank links at Plaid. Sealed remains last up to 30 days in Cloudflare's recovery and open only with your own keys." | Phase 5                                          | Our word                                                  |
| "An account nobody opens for 24 months is deleted the same way."                                                                                                                              | Phase 5                                          | Our word                                                  |
| "The app's code is public, and every release is built from it in public."                                                                                                                     | Phase 7                                          | Checkable: the repository, the build log, the attestation |

Each claim is published next to the limit that goes with it: "Like every web app, this depends on the code we send your browser. That code is public (4.2)."

### 1.2 What must never be said

- **"We can't read your data"** or **"nobody who breaks in can read it"**, flat. Someone who can change the code the server sends or runs can (4.2). Say "we hold no key" and "stored data can't be read".
- **"Zero-knowledge"** or **"end-to-end encrypted"**, for any budget. The server handles bank data in passing, learns metadata, and sends the code.
- **"We have no access to your bank"** or **"we don't store your bank key"**. The server stores the key to each bank link and can ask Plaid for that link's data.
- **"We keep no copy of your bank data."** We keep a sealed copy. Say "no readable copy".
- **"Nobody but you can see your transactions."** Plaid can, and so can the bank.
- **"Deleted at once", "gone for ever".** Cloudflare's recovery keeps sealed bytes 30 days, and Plaid keeps its own records under its own policy.
- **"We can't be forced to hand anything over."** We can be made to hand over sealed data and metadata, to fetch a person's bank data from Plaid, and in principle to ship changed code.
- **"Anonymous."** Cloudflare sees IP addresses, and Plaid knows who the person is.
- "Audited", "bank-level", "military-grade", "unhackable".

### 1.3 The pitch that survives a hostile reader

> Your budget is encrypted on your devices with a key we never hold. Bank data comes through Plaid; we seal it the moment it arrives and keep nothing readable. No email, no trackers, public code.

## 2. Who can see what today

| Data                                                                                  | Where it is today                                                | Who can read it today                                       |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| Transactions, payees, amounts, categories, notes, balances                            | `BudgetStore` SQLite, plain text                                 | The operator, Cloudflare, anyone with the account           |
| Raw Plaid pages and the bank log (`raw_page`, `bank_event`)                           | `BudgetStore`, plain text; triggers refuse every delete          | The same                                                    |
| Plaid access tokens                                                                   | `connection.access_token_enc`, AES-GCM under `TOKEN_KEYS`        | The Worker holds the key, so the operator                   |
| Budget name, the person's name, a random handle in `user.email` (the owner's is real) | `Directory`, plain text                                          | The operator                                                |
| Passkey names, device names, each session's user agent, last-seen times               | `Directory`, plain text                                          | The operator                                                |
| Usage events and notes (`usage_event`, `usage_note`)                                  | `BudgetStore`, plain text; an export reads them                  | The operator                                                |
| The copy on the device                                                                | IndexedDB, AES-GCM, key from the passkey plus a server share     | The person                                                  |
| Request logs                                                                          | Workers Logs, 3 days; `invocation_logs` is on (`wrangler.jsonc`) | The operator. What Cloudflare adds per request is unchecked |
| 30 days of every store's past                                                         | Cloudflare point-in-time recovery                                | The operator, through a restore                             |
| Everything in the page while it is open                                               | The browser                                                      | Our code, and Plaid's script (`cdn.plaid.com` in the CSP)   |

`docs/threat-model.md` accepts this for one owner: "a compromise of your Cloudflare account exposes the data and the secrets". That sentence has to stop being true for stored budgets.

## 3. Who we defend against

| Who                                                                                                                                                      | Today                                        | After this design                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stranger on the internet                                                                                                                               | Stopped                                      | Stopped                                                                                                                                                                                              |
| Someone who copies the database, a backup or a restore                                                                                                   | Reads everything                             | Gets sealed data and metadata                                                                                                                                                                        |
| The operator being curious, or a legal demand for **stored** data                                                                                        | Reads everything                             | Sealed data and metadata only                                                                                                                                                                        |
| Someone with the database **and** the Worker's secrets                                                                                                   | Reads everything, and can ask Plaid for more | Can't read the stored budget. **Can ask Plaid for each link's bank data** (180 days at link, and what is new), and can forge bank pages (5.5)                                                        |
| Someone who can **write** to the database but not change code                                                                                            | Can change a budget                          | Can't forge a budget entry (5.3) or a bank page (5.5); can hold back or delete data, which devices notice                                                                                            |
| Someone who can **change the code the server sends or runs** (a taken-over Cloudflare or GitHub account, a bad dependency, an operator under compulsion) | Reads everything                             | **Reads the budgets of people who use the app while the bad code is live, and all bank data fetched meanwhile.** Phase 7 makes an untargeted change visible afterwards; it does not prevent it (4.2) |
| A server that lies about bank data or the time                                                                                                           | Not considered                               | Not prevented (4.4)                                                                                                                                                                                  |
| A server that hides, repeats or forks changes                                                                                                            | Not considered                               | Rollback of what a device has seen is detected; a fork is detected when devices compare (5.3)                                                                                                        |
| Plaid                                                                                                                                                    | Sees bank data                               | Sees bank data (4.1)                                                                                                                                                                                 |
| Someone with the unlocked device and its passcode                                                                                                        | Reads the budget                             | Reads the budget                                                                                                                                                                                     |

## 4. Limits no design here removes

### 4.1 Plaid sees the bank data

Plaid fetches transactions from the bank and keeps them under its own policy. Its API answers only a server that holds our Plaid secret, so the data must pass through our Worker; Plaid can't encrypt to a person's device. The claims are therefore about what we **store**. The privacy policy names Plaid and links its policy and its page where a person can see and remove connections.

A budget with no bank link has none of this. "Accounts without a bank link" (`docs/build-plan.md`) would be the most private mode; it needs the owner's Money-rules answers about starting balances and is not part of this design.

### 4.2 A web app runs whatever its server sends

The keys live in the browser, and the browser runs the JavaScript the Worker serves on each visit. Whoever controls that JavaScript can read the keys. A service worker can't prevent it: the browser replaces a service worker with whatever new one the server sends. A changed Worker can also keep the bank data it fetches before sealing it. No web-only design closes this. What can be done:

- make every release public and comparable (5.9), so an untargeted bad release leaves evidence. Code sent once to one person leaves none;
- make it hard to ship code without the owner seeing it (5.10);
- or ship an app from an app store, where the code is signed and can't change per visit. That has a yearly fee and breaks the $0 rule.

### 4.3 What the server and the operator still learn

- That an account exists, when it was made, how many passkeys and devices it has, each passkey's maker id, and each session's user agent.
- When the app is used and from which IP address (Cloudflare sees it; the app stores none).
- How many changes are made and when, and their rough size. Padding (5.3) blurs size, not count or timing; a bank run looks different from a typed edit.
- For each bank link: the Plaid Item id, the access token, **which bank it is** (Plaid's dashboard shows the operator every Item's bank), when it was linked, when Plaid says it has news or needs repair, when each page arrived, and each page's size, which hints at how many transactions it holds.
- Bank data, in the Worker's memory, between Plaid's answer and the seal.

The page "what we can hand over" (section 11) lists exactly this, and says plainly that the server could be made to fetch a person's bank data from Plaid.

### 4.4 The server can lie about bank data and the time

Plaid doesn't sign its answers for the device. A Worker running changed code could add, alter or drop bank rows and balances before sealing them, and the device would file them as true. The server also states when each page arrived, and supplies "today" (`apps/worker/src/local/engine.ts`), which decides the current month. The device refuses a server time far from its own clock, and that is all it can do. This is the same trust as 4.2.

### 4.5 The device

Someone with the unlocked device and its passcode reads the budget, as today (`docs/phone-budget.md` 13.6). A jailbroken device, a malicious browser extension on a computer, a shared or exported passkey, and the iOS keyboard's learning are outside what the app controls.

## 5. Design

### 5.1 Shape

```
   Plaid ──(bank data, TLS)──▶ Worker: fetch step ──seal + sign──▶ sealed inbox ──▶ device
                                  (bank keys, cursors)                                 │
                                                                           engine: all budget work
                                                                           (edits, matching, scans)
   Directory: accounts, passkeys, sessions,                                            │
   key slots (wrapped), usage counts            ◀──────(sealed, signed entries)────────┘
   BudgetStore: a sealed log, sealed snapshots, the sealed inbox, bank links
```

The server keeps doing five things: sign-in; fetching from Plaid and sealing; storing and ordering sealed entries; counting usage for the free plan's limits; deleting accounts. It stops doing everything that reads a budget.

### 5.2 Keys

Building blocks: AES-256-GCM, HKDF-SHA-256, SHA-256, Ed25519 and X25519 from WebCrypto, which Safari 17 and Workers have. Sealing to a public key (the bank inbox, adding a device) uses HPKE (RFC 9180) through one reviewed library, checked against the RFC's test vectors; it is the only dependency in the key code, on the device and in the Worker. Before phase 2, an appendix to this file fixes every derivation label, associated-data string, nonce rule and size. The rules it must hold:

- **Budget key.** 256 random bits made on the device when the budget is made, and only then: **a client never makes a key for a budget that already exists**, whatever the server says, so a server can't trick a device into starting over in the clear. HKDF derives one key per use and per key version: log entries, snapshots, the inbox private key's wrap, and a signing key pair.
- **In memory.** Derived keys are non-extractable. The raw budget key is unwrapped as extractable only during a slot change, which needs a fresh passkey prompt, and is dropped after. The key kept for a page refresh (`holdKey` in `vault.ts`) holds derived keys only.
- **Key slots.** The server stores the budget key only wrapped, once per way in:
  - **one slot per passkey**, wrapped under HKDF of that passkey's PRF output (the WebAuthn `prf` extension the copy already uses). Sign-in uses discoverable passkeys, so the app can't know which passkey will answer before it asks; the PRF input for slots is therefore one constant for the whole app, sent as a second PRF input beside the copy's per-device salt. PRF output differs per passkey anyway. Its labels differ from the copy vault's, so the two uses of one passkey give unrelated keys.
  - **one recovery slot**, wrapped under a key from the recovery key (5.8).
  - A slot's associated data binds the user, the budget, the passkey id, the key version and the slot format.
- **Sign-up ends only after the new slot has been opened once**, with a second passkey prompt, so a passkey that can't give PRF output is found before a budget depends on it.
- **A passkey with no PRF can't open a budget.** Today such a passkey opens the budget in memory (D-57 item 4). iCloud passkeys on iOS 18 and later have PRF; older systems don't. Other passkey apps and security keys vary: phase 0 tests them.
- **Signing.** An Ed25519 pair derived from the budget key. The server stores the public half and refuses any entry or snapshot not signed by it, so a session that holds no key (a stolen cookie, a passkey with no PRF) can't write junk into a budget. Verifying must fit the 10 ms rule; measure it in phase 0.
- **Inbox key pair.** An X25519 pair made on the device. The private half is sealed under the budget key and travels in the log; the public half is given to the server, signed by the budget's signing key. The server seals bank pages to it (5.5).
- **Changing the key.** Removing a passkey, signing a device out, making a new recovery key, or a device-add that is cancelled all make a new key version: a new budget key, a fresh sealed snapshot, new slots, a new signing key and a new inbox pair. The device first files every waiting bank page, then swaps the keys; it keeps the old inbox private half until no page sealed to it is left. Entries written before stay readable to whoever held the old key and an old copy of the data; the policy says so.
- **The copy on the device stays as built**: its own data key, wrapped under the passkey's PRF output and the per-device server share, so "Sign out other devices" still turns a copy off.
- **Adding a device.** A passkey synced by iCloud Keychain gives the same PRF output on every Apple device, so its slot just works. For a separate passkey: the new device makes an X25519 key pair and shows a short code; the person checks the same code on the signed-in device, which then seals the budget key to that public key. One use, 10 minutes.
- **AES-GCM limits.** Random 96-bit nonces, and far fewer than 2^32 seals per derived key; a key version change resets the count. AES-GCM doesn't commit to its key, which is harmless here because every key is 256 random bits and never chosen by another party.
- **Later:** a post-quantum hybrid for the inbox and device-add. Until then, bank pages sealed to the inbox are the one stored thing a future quantum computer could open from a copy made today; the log and snapshots are sealed with symmetric keys and are not at risk.

### 5.3 What the server stores: a sealed, signed log

`BudgetStore` keeps, per budget, a log, snapshots, the bank inbox and the bank links (5.5), and no budget tables.

**Entries.** One entry is the set of row changes that one edit, one bank run or one scan made. It holds **results** (rows), not operations: a device applying an entry writes rows and re-runs nothing. Each entry carries:

- in clear: its number, a random entry id, the writer's device id and that device's own counter, the key version, the schema version, the **processing version** (below), how far into the bank inbox it has filed, and the signature;
- sealed: the row changes, and the last entry number and hash this device has seen from every other device;
- associated data: the budget id, the number, and the hash of the entry before it. Hashes cover the sealed bytes, the nonce and the clear fields.

Bodies are padded to size steps (256 bytes, 1 KB, 4 KB, 16 KB, 64 KB). A change set larger than 64 KB is split into parts that the server appends in one step or not at all.

**What the row changes cover.** Every table an edit or a bank run writes, not only today's `SYNC_TABLES`: also `audit_log`, `txn_key_move` and the bank log (`bank_event`, `bank_page`). Section 6.2 lists every table.

**Writes are compare-and-swap, and safe to resend.** A device sends `{ base: N, entries }`. The server appends only if the log's last number is `N` and the signature is good. If it already holds an entry with the same entry id, it answers "already stored" and stores nothing: without this, a write whose answer was lost would be redone on top of itself, and `budget/assign`, which adds, would assign twice. This takes over the job of `edit_seen` (`routes/sync.ts`). Otherwise it answers with the entries after `N`.

**Redoing a refused write.** Today the engine can't undo an edit: one edit is several SQLite batches plus `derive()`, and the copy drops the change-log triggers (`local/engine.ts`). The copy therefore becomes two things: a **confirmed base** (the state at the last entry the server accepted) and a **queue** of edits not yet accepted, each kept as the request that made it, as the offline queue is today. The screens show base plus queue. To send, the engine runs the queued edit on the base with triggers that record each changed row, and builds the entry from that record. When the server refuses, the engine drops the result, applies the newer entries to the base, and runs the queue again. A queued edit can fail the route's own checks on the newer base (the category was removed meanwhile); the person is told, as a refused offline edit is today. The redo is tried a few times, then waits; it can't spin.

**Processing version.** Applying an entry needs no logic, but making a bank entry runs the matching code, and a tab left open keeps old code (`sw.js` serves the saved shell). The log holds the lowest app version allowed to file bank pages or run scans, as `DERIVE_VERSION` does for derived numbers. An older client reads and edits but doesn't file until it updates. A data migration (today's one-time jobs such as `refile_payees`) is written once, as one entry, by the first device on the new version; the others apply it as rows.

**Snapshots.** A device writes the whole base, sealed, in chunks, with a sealed and signed manifest: snapshot id, chunk count, each chunk's hash, the entry number and hash it stands at, and hashes of the chain at regular checkpoints. A device checks a new snapshot against its own state before trusting it. Entries older than a snapshot are deleted 30 days after it. A device away longer than that proves its remembered position against the checkpoints.

**A lying server: what is and isn't caught.**

- It can't forge or alter an entry or a snapshot.
- **Rollback.** Each device keeps the last number and hash it saw in a place separate from the copy, and nothing the server says clears it: not a new sync epoch, not a refused edit, not a revoke. A download that doesn't reach that position shows "The server's copy is older than this device's" and stops.
- **Holding back** new entries from one device can't be told apart from "nothing new" by that device alone.
- **A fork** (two devices each shown a different branch) can't be seen by one device alone. Because each entry carries what its writer last saw from the others, a fork shows the moment any entry crosses between branches. Settings → Sign-in also shows a short code for the log's position that can be compared across two devices by eye.
- A **new device** can be shown an older, consistent past. Setting one up shows "Last change: {date}, from {device}" to confirm.

So the claim is "a device notices if the server rolls back what it has seen", not "the server can't hide changes".

**No restore (owner, D-85).** Today a restore is the operator rolling a store back (`docs/runbooks/restore.md`, D-77). A sealed budget can't be checked or repaired by the operator, and the owner doesn't want a restore in the app. So there is none: the runbook and the undo (D-77) are retired at the cutover, and Cloudflare's point-in-time recovery is no longer used for budgets. A device that sees the server behind it stops; it doesn't offer to overwrite either side. The full backup stays as a way to take data out (5.8), not to put it back. The one exception is the way back during the move itself (section 8).

### 5.4 All budget work moves to the device

What the engine runs today: every screen, and six kinds of edit while offline (`OFFLINE_EDITS` in `apps/web/src/copy/copy.ts`). Every other edit and all background work run only on the server. The job runner is written against Durable Object storage (`store/jobs.ts`), the engine's environment has no Plaid keys and a sync starter that does nothing (`local/engine.ts`), and some handlers mix Plaid calls, token handling and budget writes in one function (`routes/settings/connections.ts`, `finalizeConnection` in `sync/process.ts`). So:

| Work                                            | Today                                      | After                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every edit (`routes/*.ts`)                      | Checked and stored by the server           | Run in the engine; the result is a log entry. Each route is first proved to give the same rows in the engine as on the server (a mutation twin of `engine-routes.test.ts`) |
| Bank sync: fetch                                | `BudgetStore` alarm jobs                   | Stays on the server; each page is sealed (5.5)                                                                                                                             |
| Bank sync: apply, process, finalize             | `BudgetStore` alarm jobs, 25 events a step | The engine, when the app is open, from the sealed inbox                                                                                                                    |
| Daily scan, maintenance                         | Alarms at 5:00 and 2:20                    | The engine, when the app is open, once for each day missed                                                                                                                 |
| Handlers that mix Plaid calls and budget writes | One function                               | Split: a Plaid call on the Worker, a budget write in the engine                                                                                                            |
| The bank log (`bank_event`, `bank_page`)        | Server only, append-only by trigger        | On the device, with the same triggers, stored beside the main copy and appended in chunks, so each save doesn't re-encrypt it all                                          |
| Raw Plaid pages (`raw_page`)                    | Server only, kept for ever                 | Not kept (owner, D-85). A sealed page is deleted once a device has filed it                                                                                                |
| Health and alerts about a budget                | Server writes them                         | The engine writes them                                                                                                                                                     |

**The device replays what the server would have done, as of when it would have done it.** On open, before it sends any edit of its own, the device works through the time since its last entry in order: each bank run in the inbox, and the daily scan and maintenance for each day missed. Each bank row's arrival time (`bank_txn.created_at`, which D-67 reads) is the server's stamp on its page. The clock for each step is the page's arrival time, or the time of the last log entry if that is later, so time never runs backwards in the log. This is what keeps the Money rules unchanged: D-67's "within an hour of the first row" and "within 14 days of the link", and D-68's "lasted a day", are worked out from the same times as today, however long the app was closed.

**One bank run is one write.** Today's code can't be run by two devices at once: the cursor moves only on a run's last page, events are unique per run id, and the lease lives in columns the copy doesn't hold (`sync/steps.ts`, `sync/lease.ts`). Here the server owns the cursor and the run (5.5), and a device files one whole run on a scratch copy of the base and sends **one** compare-and-swap write that holds the bank rows, the results and "inbox filed through run R". If another device got there first, the write is refused and thrown away; on the redo the base already shows run R filed. No lease is needed between devices, and a phone put in the background mid-run loses nothing. A test with two engines covers exactly this.

**Step sizes stay as they are.** Matching results depend on the step size: `docs/build-plan.md` records a case where it changed the number of "Same purchase?" questions. The device has no 10 ms limit, but the steps stay at 25 events until the owner accepts a change. Small steps also keep the app answering, because the engine handles one message at a time (`local/web-entry.ts`).

**Proving it is unchanged.** Row ids and times come from the clock (`ulid(now)`), so the device's rows can't be compared with the server's byte for byte. Phase 4 defines a canonical comparison: the same pages, the same step size, compared without ids and timestamps. During it the server both processes each page as today and seals it to the inbox, and the device replays beside it on the owner's real budget. Rows that differ only because a threshold fell between the server's clock and the page's arrival time are listed and looked at by hand. It also fixes a time zone written into `sync/process.ts` that must come from the budget.

### 5.5 Bank data: fetched in the background, sealed at once

- **Bank links stay on the server.** Each link's access token (under `TOKEN_KEYS`, as today), its Plaid cursor, its Item id and its state move from the budget's `connection` table to a server-only `bank_link` table. The rest of a connection (its name, its accounts) lives in the sealed budget. No token changes and no Item is touched.
- **The fetch step stays on the server**, on alarms and webhooks as today. It already takes a page from Plaid without parsing it, reading only the cursor (`packages/bank-provider/src/plaid.ts`). Instead of storing the page in `raw_page`, it seals it to the budget's inbox public key and stores the sealed page, with the link, the run, its place in the run and its arrival time in clear. The account balances and liabilities Plaid sends at the end of a run are sealed the same way. Nothing else is done with the page: the server's apply and processing steps are gone.
- **A run is whole or absent.** Pages of a run are staged, as `sync_page` does today, and a device sees a run only when its last page is in. If Plaid reports that data changed mid-run, the run's sealed pages are dropped and it starts again from its first cursor, as today. The cursor moves in the same transaction that stores the run's last page.
- **Pages are signed by the Worker.** The Worker signs each sealed page and its clear fields with a key held as a Worker secret; the app has the public half built in. Sealing to a public key needs no secret, so without this anyone who could write to the database could invent bank pages. With it, inventing a page needs the Worker's secrets.
- **The inbox public key.** Someone who can write to the database could replace it with their own and read pages fetched after that, until a device next opens: the device then can't open its inbox, says so, and puts its own key back. Pages sealed to the wrong key are lost; the device asks the server to fetch that link again from the start, and rows it already has are recognised by Plaid's transaction id and keep their first arrival time. This re-fetch path is new work and needs its own test against "retries add nothing" (`docs/sync-spec.md`).
- **Filing.** The device opens the inbox runs in order and files each as one write (5.4). The entry says how far it filed; the server then deletes those sealed pages.
- **Linking.** After Link finishes (5.7) the Worker exchanges the public token at once, as today, so a link is never lost, stores the token in `bank_link`, and starts the first run. What Plaid says about the new link (its bank, its accounts) reaches the device through the inbox. The count of links ever made moves from the store's `connection` table to the Directory, because the server can no longer count rows there.
- **Repair** (Plaid's update mode) and **removing a bank** are asked for by the person on a device, with a recent passkey check; the Worker calls Plaid with the stored token. The Worker removes an Item by itself only when an account is deleted or expires (5.8).
- **Webhooks.** Plaid's webhook still reaches the Worker and is verified. It starts a fetch, or marks the link "needs repair" in `bank_link` (today `login_required` is written into the budget's tables, `routes/ops.ts`); the device reads link states with the inbox.
- **An account nobody opens** keeps being fetched, and its sealed pages wait, until the account is deleted at 24 months. The size of a waiting inbox is measured in phase 0.

What this protects: someone who copies the database learns no bank data. What it doesn't: someone with the database and the Worker's secrets can ask Plaid for each link's data, as today. Replacing the bank keys so that older stolen copies stop working (`/item/access_token/invalidate`) is tabled by the owner (D-85).

### 5.6 Identity and metadata

- **No email.** Already true for sign-ups: `user.email` gets a random value (`routes/signup.ts`). The owner's row keeps its value, because the saved copy on the owner's devices is filed under it (`vault.ts` `recordKey`).
- **The name.** Sign-up requires a name today. It becomes optional and is described as a label ("anything you like"); Settings → Users shows the label or the account's date.
- **Budget name and bank names** move into the sealed budget. The server check that compares a typed budget name on delete account (`routes/people.ts`) moves to the device. Section 4.3 is clear that the operator can still learn which bank an Item is.
- **Passkey names, device names, user agents:** kept only as long as the passkey, device or session; names are the person's own words and can be blank.
- **Usage events and notes** (`usage_event`, `usage_note`, `usage_daily`) stay on the device, sealed with the budget. A person can export their own. The operator gets none from other people.
- **Logs.** Paths become generic (`/api/log`, `/api/inbox`), so a path no longer holds a transaction id. Phase 0 checks what Cloudflare's invocation logs record per request; if that includes an IP address, they are turned off before any claim about IP addresses is made.
- **Turnstile** (open sign-up, `docs/open-signup.md` 13) needs a script and a frame from `challenges.cloudflare.com`. It runs on its own page with its own CSP, before any key exists, and the app proper is reached by a full page load after it. The recovery screen, where the recovery key is typed, does the Turnstile step first and the key step after the same kind of page load.

### 5.7 No outside script where the keys are

Today the CSP allows `https://cdn.plaid.com` as a script source, and Plaid Link's script runs in the same page as the copy. With the budget key in the page, that is no longer acceptable.

Use Plaid's hosted Link: the app opens a page on Plaid's own site, the person links the bank there, and Plaid tells our server when it is done. The app's CSP becomes `script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'` with no `frame-src`. To check in phase 0: that hosted Link is offered on Plaid Trial; and what happens on an iPhone when a bank's own sign-in returns to Safari while the person started in the Home Screen app, which has separate storage. The app finishes a link by asking the server, not by trusting where the browser lands. The Worker asks Plaid for the same products as today and no more. If hosted Link can't be used, the fallback is Link on its own page with its own CSP, reached and left by full page loads, with no key in memory while it is open.

Also: drop `'unsafe-inline'` from `style-src`, add Trusted Types where the browser has them, and keep the CSP test that fails when any source loosens.

### 5.8 Recovery, backup, deleting

- **Recovery key.** 256 random bits, shown once at sign-up as words or letter groups. HKDF splits it in two: one half proves to the server that the person may add a passkey (the server stores only its hash, as with today's recovery code, `docs/open-signup.md` 4); the other half opens the recovery slot. It replaces the recovery code. Making a new one changes the key version (5.2).
- **No reset, by anyone.** The owner's runbook recovery (`docs/runbooks/setup.md`) can give back a sign-in but not a budget, so the owner gets a recovery key too. This changes "not for admins" (`docs/open-signup.md` 4; owner's yes, D-85).
- **Full backup.** Made on the device, after a fresh passkey prompt, which stands in for today's 15-minute rule on the server export. Sealed with the recovery key by default, so no password and no password-stretching code are needed; or plain, with a warning. `GET /api/export/dump` goes away. It takes data out; nothing loads it back. The two open items about restoring a backup (`docs/build-plan.md`) close as "not wanted".
- **Deleting an account.** The order in `docs/open-signup.md` 12 holds: sessions, devices and routes go first; then the server removes each Item at Plaid from its stored token, with retries; then the store wipes itself and the Directory deletes the slots and the user. What protects the remains is that the server never had the key. Whether Cloudflare's recovery keeps a wiped store's bytes is stated two ways in the docs; phase 0 tests it, and the claim says "up to 30 days" until then.
- **Idle accounts are deleted (owner, D-85).** The Directory's daily cron deletes, in the same way, an account with no sign-in for 24 months. With no email there is no way to warn someone who never opens the app, so sign-up and the policy say it plainly, and Settings → Privacy shows the date. Admin accounts are exempt. This replaces "nothing is deleted for being idle" (`docs/open-signup.md` 1 and 9).
- **Telling people about an incident.** With no email, notices show in the app at sign-in. A notice can require action before the budget opens, such as "make a new recovery key". The policy says this is the only channel.

### 5.9 Public, comparable releases

- **The repository is already public** (checked Nov 10, 2026), so the code is open today and branch protection is available. Its docs hold the owner's own purchases and bank names; the owner chose to take them out of the docs (D-85, a separate change). The git history keeps the old text.
- The web build is made reproducible: the same commit gives the same files, byte for byte.
- The deploy workflow publishes the list of file hashes for each release with a build attestation (free for public repositories), and Settings → About shows the release's commit and hash.
- Anyone can then compare what the site serves with what the public build made. This covers the app's code. It says nothing about what the Worker runs, and it can't catch code sent to one person once (4.2). The policy says both.

### 5.10 Who can ship code

After this design, the code path is the attack surface. Today every Claude session merges its own PRs and each merge deploys (`CLAUDE.md`, D-51). The owner agreed (D-85) that:

- A change to the key and sealing code, the fetch-and-seal step, the CSP (`apps/web/public/_headers`), `sw.js`, the build, or `.github/workflows` needs the owner's review before merging. `.github/CODEOWNERS` is `*` today; it is narrowed to those paths, so other work still merges as now, and branch protection enforces it. It starts when the key code exists, with a change to `CLAUDE.md` then.
- No new runtime dependency in the key and sealing code without the owner's review.
- Hardware-key or passkey two-step sign-in on Cloudflare, GitHub and Plaid (`docs/threat-model.md` says so already), and a Cloudflare API token that can deploy the Worker and nothing else.

### 5.11 What stays the same

Passkey sign-in, sessions, CSRF checks, rate limits, the breaker and fair-use shares (they count requests, entries and bytes, not content), the one cron, deploys by merge, `TOKEN_KEYS`, the 7 bank links, and every Money rule. The 15-minute recent-passkey rule stays for linking, repair, removing a bank and passkey changes, and becomes a passkey prompt on the device for backups.

## 6. What changes in the code

### 6.1 By area

| Area                                                | Change                                                                                                                                                                                                                                                              | Size   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `apps/web/src/copy`                                 | Budget key, slots, recovery key, device-add, key versions, sealing, signing, the remembered position, base plus queue, snapshots, opening the inbox                                                                                                                 | Large  |
| `apps/worker/src/local`                             | Run every edit; file bank runs as one write; replay scans and maintenance by day; record row changes; hold the bank log beside the copy                                                                                                                             | Large  |
| `apps/worker/src/routes`, `sync`, `ledger`, `views` | Split handlers that mix Plaid and budget writes; take an explicit clock; remove what depends on Durable Object storage and leases; the rest runs unchanged, on the device only                                                                                      | Large  |
| `apps/worker/src/store/budget-store.ts`             | Becomes the sealed log, snapshot and inbox store, with `bank_link`; the job runner stays for the fetch step only; dump and heavy-read code go                                                                                                                       | Large  |
| `apps/worker/src/store/directory.ts`                | Key slots, signing and inbox public keys, lifetime link count, the idle-account job                                                                                                                                                                                 | Medium |
| `packages/bank-provider`                            | The fetch step seals and signs; hosted Link                                                                                                                                                                                                                         | Medium |
| Migrations                                          | New: sealed log, snapshots, inbox, `bank_link`, key slots. Old tables: one migration drops the no-delete triggers; a stepped job under the breaker empties them (section 8). **Forward-only, on the owner's real budget**                                           | Medium |
| Tests, dev seed, e2e                                | The engine suite becomes the main one; new: edits in the engine match the server, two devices, lost answers, a lying server, key slots, recovery, replay after days away. `dev-seed.ts` and e2e seed the store's tables today and need a device or a sealed fixture | Large  |
| `tools/ci/smoke.mjs`, `deploy.yml`                  | The smoke test reads `watermarkLag` from `/api/health`; it changes in the same PR as health, or the deploy rolls itself back                                                                                                                                        | Small  |
| Docs                                                | `architecture.md`, `threat-model.md`, `sync-spec.md` notes, `open-signup.md`, runbooks (restore goes), a decision per phase                                                                                                                                         | Medium |

This is the largest change since the budget moved to the phone.

### 6.2 Where each server-side thing goes

| Today                                                            | After                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Synced tables (`sync-tables.ts`)                                 | In log entries                                                                   |
| `connection`: token, key version, cursor, lock, Item id          | Server only, in `bank_link`                                                      |
| `connection`: the rest; `provider_account`, `liability_snapshot` | In log entries                                                                   |
| `bank_event`, `bank_page`                                        | In log entries; kept beside the copy                                             |
| `raw_page`                                                       | Not kept (D-85)                                                                  |
| `sync_run`, `sync_page` (staging a run)                          | Server only: the sealed inbox                                                    |
| `apply_counter`, `lease_guard`                                   | Device only, inside one run; not shared                                          |
| `audit_log`, `txn_key_move`                                      | In log entries                                                                   |
| `change_log`, `edit_seen`                                        | Replaced by the log's numbers and entry ids                                      |
| `job`                                                            | Server: fetch jobs only. The engine keeps its own list for scans                 |
| `usage_event`, `usage_daily`, `usage_note`                       | Device only, sealed; the server's cap on batch size becomes a cap on entry bytes |
| `budget_line`, `month_snapshot`, month totals                    | Device only, as today                                                            |
| `GET /api/session` (reads name, time zone, setup step)           | Account facts from the Directory; budget facts from the copy                     |
| `GET /api/health` (reads connections and the bank log)           | Server health only: fetch errors and age per link, inbox and log size, limits    |
| Webhook writing `login_required` into the budget's tables        | A state in `bank_link`                                                           |
| Sync epoch                                                       | Kept, but it can no longer make a device forget its remembered position          |
| Restore and its undo (D-77), `docs/runbooks/restore.md`          | Retired (5.3)                                                                    |
| Idle budgets with no banks stopping their jobs                   | Unchanged: a budget with no bank link has no fetch job                           |
| Breaker and fair-use shares                                      | Unchanged; they count requests, entries and bytes                                |
| Admin Settings → Users                                           | Unchanged; it never showed budget content                                        |
| Server clock for "today"                                         | Kept; the device refuses a time far from its own (4.4)                           |

## 7. What the user sees

| Where                                      | Today                                 | After                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-up                                    | Name, passkey, then a recovery code   | An optional label, passkey, a second passkey prompt to prove the key works, then a **recovery key**: "If you lose your passkeys and this key, your budget is gone. We can't reset it." A step asks for part of the key back. It also says that an account not opened for 24 months is deleted |
| Opening the app                            | Bank rows are already in              | Bank pages are waiting, sealed. The device opens and files them ("Getting your bank's latest"). Screens answer between steps, a little slower meanwhile                                                                                                                                       |
| After weeks away                           | Up to date at once                    | A longer catch-up, with progress shown: the device works through each missed day. The numbers at the end are the ones today's server would have reached                                                                                                                                       |
| Linking a bank                             | Plaid Link opens inside the app       | The app hands off to Plaid's page and comes back                                                                                                                                                                                                                                              |
| A new device                               | Sign in; the budget downloads         | The same with an iCloud passkey. With a separate passkey: compare a short code on both devices, or type the recovery key                                                                                                                                                                      |
| An old browser or system                   | Works, with the copy in memory        | "This device can't open an encrypted budget"                                                                                                                                                                                                                                                  |
| Two devices at once                        | Both edit; the server orders them     | The same. A refused write is redone unseen; if the redo can't apply, the person is told which edit was dropped                                                                                                                                                                                |
| Removing a passkey or signing a device out | Immediate                             | A moment longer: the budget gets a new key and is sealed again                                                                                                                                                                                                                                |
| Settings → Backup                          | Full backup downloads from the server | Made on the device after a passkey prompt; sealed with the recovery key by default. It takes data out; nothing loads it back                                                                                                                                                                  |
| Settings → Sign-in                         | Passkeys, devices, recovery code      | Adds "Recovery key: make a new one" and a short code to compare between devices                                                                                                                                                                                                               |
| Settings → About                           | Version                               | Version, release commit and hash, a link to the public build                                                                                                                                                                                                                                  |
| Settings → Privacy (new)                   | Nothing                               | What is sealed, what the server knows (4.3), who else handles data (Cloudflare, Plaid), the idle date, delete account                                                                                                                                                                         |
| Delete account                             | Refused with linked banks             | Works; removes the banks at Plaid; says what remains for 30 days                                                                                                                                                                                                                              |
| A restore                                  | The operator restores for you         | There is no restore                                                                                                                                                                                                                                                                           |
| Support                                    | The operator can look                 | The operator can't look. Help is by description, or a backup the person chooses to send                                                                                                                                                                                                       |
| A server that rolls back                   | Not shown                             | "The server's copy is older than this device's." The app stops there                                                                                                                                                                                                                          |
| A security notice                          | None                                  | Shown at sign-in; some must be acted on before the budget opens                                                                                                                                                                                                                               |

All new text follows `docs/copy.md`.

## 8. Moving the owner's budget

The owner's budget is real, migrations are forward-only, and 7 of 10 lifetime bank links are used. Each step that merges a migration needs the owner's yes (`CLAUDE.md`). **No bank is linked, re-linked or removed at any step, and no bank key changes.**

1. **Before anything:** a full backup. PRF checked with the owner's existing passkey on every device (an open item in `docs/build-plan.md`). The owner has a recovery key and has proved it opens the slot.
2. **A release that knows "sealed"**: old code paths (routes, alarms, webhooks) refuse to touch a budget marked sealed. It ships well before the move, so that a later automatic code rollback (`deploy.yml` rolls back on a failed smoke test, and a rollback undoes code, not data) lands on code that obeys the mark.
3. **`bank_link` is filled** from `connection` by a migration, and the fetch step reads tokens and cursors from it. Each of the 7 links must then complete a fetch from `bank_link` before anything else moves. The old columns are left as they are.
4. **Shadow run** (phase 4) has matched on the owner's budget for two weeks.
5. **Cutover, one transaction on the server**, refused and tried again unless all of this holds: no bank run is in progress; the `change_log` head equals what the device holds; the device's first signed snapshot and its inbox public key are stored. Then the old processing jobs are deleted and the budget is marked sealed. The device's download for this includes the columns `/api/sync` leaves out today and the bank log, and is checked against the server's dump hashes with those columns included.
6. **A week of normal use**, with the old tables untouched. Until step 7 starts there is a way back: the mark is cleared and the old code runs on the old tables, which are as they were at the cutover; bank rows since then come again from Plaid by the old cursor, and edits made since are lost. This is a one-time safety net for the move, not a feature.
7. **Emptying the old tables.** `bank_event`, `bank_page` and `raw_page` refuse deletes by trigger, and deletes on synced tables write `change_log` rows; done at once, seven banks' rows could pass the free plan's daily row limit and rest the app. So: one migration drops those triggers, and a stepped job under the breaker empties the tables over days. Measure the row count first. From here there is no way back.
8. **30 days after step 7 ends**, point-in-time recovery holds no plain text, and the first two claims in 1.1 start.

## 9. The free plan

- Server CPU: storing a sealed row and checking a signature are small. The fetch step adds a seal and a signature over a page of up to about 200 KB; measure it against the 10 ms rule (`docs/measurements.md`), and lower the page size if needed.
- Durable Object rows fall: one row per edit or bank run, and one per sealed page, not one per changed row plus `change_log`.
- Worker requests stay about the same: the fetch step is an alarm as today; filing adds one request per bank run.
- Device work rises: filing bank runs, sealing, snapshots. Measure on the owner's iPhone in phase 0: opening a sealed snapshot of today's budget; filing a 100-row run; replaying a month away; the size of the bank log; a save with the bank log kept beside the copy.
- Nothing in the design costs money to build or run.

## 10. Phases

Each phase ships alone and leaves the app working. A decision file records each (`docs/decisions/`).

| Phase | What                                                                                                                                                                                                                                   | Claims it unlocks                                       | Risk to the owner's budget     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------ |
| 0     | Measure and check: PRF on each device and passkey kind; signature, seal and signing CPU; snapshot, inbox and bank-log size and time; hosted Link on Trial and on the iPhone; Cloudflare's log fields; what a wipe leaves in recovery   | None                                                    | None                           |
| 1     | Hosted Link and the `'self'` CSP; name optional; logs; Settings → Privacy; a privacy policy                                                                                                                                            | No trackers or outside scripts where keys are; no email | Low                            |
| 2     | Keys: budget key, slots, recovery key, device-add, key versions, signing, inbox pair. Keys exist; nothing is sealed yet. The appendix of exact labels is written first                                                                 | None                                                    | Low                            |
| 3     | Every edit runs in the engine and is proved to match the server; routes take an explicit clock; the bank log syncs to the device; `bank_link` (section 8, step 3)                                                                      | None                                                    | Low (the server still decides) |
| 4     | Shadow run: the fetch step also seals each page to the inbox; the device replays bank runs, scans and maintenance beside the server's, with the canonical comparison, on the owner's budget, for two weeks. The "knows sealed" release | None                                                    | None                           |
| 5     | Cutover: the sealed, signed log; server processing off; restore retired; delete account with banks; idle deletion (section 8, steps 5–6)                                                                                               | The bank-key claim; delete; idle deletion               | **High: forward-only**         |
| 6     | Empty the old tables; wait 30 days (section 8, steps 7–8)                                                                                                                                                                              | "A key we never hold"; "no readable copy"               | Medium                         |
| 7     | Reproducible build, attestation, About screen, the review rule for the key code                                                                                                                                                        | Public, comparable code                                 | None                           |
| 8     | Publish the claims, each with its limit and with "our word" where 1.1 says so. An outside review comes first only if the owner ever funds one                                                                                          | Section 1.1, in public                                  | None                           |

Phases 1 and 7 need no other phase.

The owner lifted D-78's freeze for the work in this design (D-85). Turning sign-up on is a separate step: other people can link banks only on Plaid Production, which costs money, so it waits for the owner's word.

## 11. Outside the code

None of this is needed to build the design, and none is paid for today (the $0 rule stands, D-85).

- **A privacy policy and terms** written from sections 2 and 4: what is stored, what is sealed, who else handles data (Cloudflare, Plaid), how long, how to delete, the "no reset" and 24-month rules, and that in-app notices are the only way we can reach a person. Writing them costs nothing; they are needed before other people sign up.
- **A page that says what we can hand over** if a court asks: section 4.3, and nothing else.
- **A security contact**: a `security.txt` and a short disclosure policy.
- **Only if sign-up is ever opened:** legal advice on the rules for companies that hold other people's financial data; Plaid Production, which has its own review and a price per linked Item; and, to turn "our word" into more than that, an outside audit.

## 12. What this design doesn't do

- It doesn't hide bank data from Plaid, or from the Worker's memory between Plaid's answer and the seal.
- It doesn't take the key to a bank link away from the server.
- It doesn't stop changed code, in the app or the Worker, from reading a budget or bank data (4.2).
- It doesn't stop the server from lying about bank data or the time (4.4), or from holding back changes (5.3).
- It doesn't hide IP addresses, times of use, counts, sizes or which banks from Cloudflare and the operator (4.3).
- It doesn't let two people share one budget. That needs each person's public key and a way to check it, which is its own design.
- It doesn't protect a budget on an unlocked or compromised device.
- It doesn't let anyone recover a budget whose keys are lost, and it has no restore.

## 13. Risks

| Risk                                                                                             | What limits it                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money is counted differently after the move                                                      | Arrival times stay the server's; replay by day; the mutation twin test (phase 3); the shadow run (phase 4); step sizes unchanged                                                                                                                                        |
| A bank link is lost during the move, with 3 lifetime links left                                  | No token or Item changes; `bank_link` is proved for all 7 links before the cutover; the old columns stay until step 7                                                                                                                                                   |
| A deploy rolls code back onto sealed data                                                        | The "knows sealed" release ships first (section 8, step 2); the smoke test changes with health                                                                                                                                                                          |
| A person loses the passkeys and the recovery key                                                 | iCloud passkeys sync; the key is proved at sign-up; a reminder until a backup or second passkey exists                                                                                                                                                                  |
| A bug in sealing loses data, and there is no restore                                             | The device holds a whole copy; the server deletes no entry a checked snapshot doesn't cover; the week before the old tables are emptied (section 8, step 6)                                                                                                             |
| Two devices, lost answers                                                                        | Entry ids; one bank run as one write; tests with two engines                                                                                                                                                                                                            |
| The copy grows with the bank log and saves slowly                                                | Measured in phase 0; the bank log is kept beside the copy; raw pages are not kept                                                                                                                                                                                       |
| The app's address changes later (the owner plans to, not soon). Passkeys are tied to the address | WebAuthn lets a new address use the old one's passkeys while the old address still answers ("related origins"; to confirm in phase 0). The `workers.dev` address must then stay alive. Failing that, each person signs in once at the new address with the recovery key |
| A sealed format or key mistake found after launch                                                | Every sealed value carries a format and key version; the claims are published last                                                                                                                                                                                      |

## 14. The owner's decisions (Nov 10, 2026)

Recorded in `docs/decisions/D-85-privacy-design-answers.md`. Nothing is open.

| Topic                              | Decision                                                                                                      | Where    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------- |
| No reset                           | Accepted, for the product and the owner's own budget. The owner gets a recovery key                           | 5.8      |
| Bank data                          | The server fetches in the background and seals at once, "for now". Arrival times and D-67, D-68 are unchanged | 5.4, 5.5 |
| The bank source                    | Plaid stays                                                                                                   | 5.5      |
| Abandoned and idle accounts        | Removed: an account not opened for 24 months is deleted, banks at Plaid included                              | 5.8      |
| Raw Plaid pages                    | No longer kept                                                                                                | 5.4      |
| Restore                            | None: not in the app, and the runbook goes                                                                    | 5.3      |
| D-78                               | Lifted for the work in this design                                                                            | 10       |
| Spending                           | None agreed. The $0 rule stands                                                                               | 11       |
| The address                        | It will change, but not soon                                                                                  | 13       |
| The owner's review of the key code | Yes                                                                                                           | 5.10     |
| The public repository              | The owner's own data comes out of the docs                                                                    | 5.9      |
| Replacing the 7 bank keys          | Tabled                                                                                                        | 5.5      |

**Considered and not chosen.**

- **The device keeps the bank key and the server only relays each Plaid call.** Stronger: nothing stored on the server could ask Plaid for anything. Not chosen because rows would arrive only while the app is open, which changes what "arrived" means for D-67 and D-68; the server couldn't remove an abandoned account's banks; and the owner's 7 bank keys would have to move to a device with 3 lifetime links left. A later switch is a medium job: the device's bank code is the same if it reads pages through one small interface, so it is built that way, but the three problems above would each need an answer.
- **Other bank sources** (checked Nov 10, 2026 from public pages; nothing was tried). No bank link, or a bank file read on the device, are the most private and free, and both need Money-rules answers first (D-81 removed CSV import over two of them). SimpleFIN Bridge has each person pay about $15 a year for their own read-only link, with no lifetime limit, but sends less than Plaid (no merchant ids), so payee names and matching (D-63, D-65) would need rework. Akoya needs a business contract. Teller holds the connection as Plaid does. Direct access under the US "1033" rule is blocked in court and being rewritten.

## 15. Review

### 15.1 v1 (Nov 10, 2026)

Two independent reviewers were told to break v1: one on the key design and the claims, one on the fit with the code. They made 39 findings, 11 of them critical; v2 fixed all of them. The critical ones:

1. "We can't read it, nor anyone who breaks in" was false: changed code can.
2. "We hold no access to your bank" was false for any shape in which the Worker sees the bank key.
3. Arrival time decides money (D-67, D-68); fetching only while the app is open would change it.
4. A new link's key was to be sealed and also removed after 24 hours; both couldn't hold, and removal burns a lifetime link.
5. `TOKEN_KEYS` also signs sign-in challenges; deleting it would break every sign-in.
6. Two devices processing the same pages would write the same rows twice.
7. A write whose answer is lost would be redone on itself; `assign` adds twice.
8. The phases sealed the budget before anyone but the server could sync banks.
9. The server can hold back entries or fork the log, and one device can't see it.
10. The server could make a device forget its position and then roll it back.
11. "Proof a stranger can check" was claimed for what the Worker does; nobody can inspect a Worker.

The 26 major findings covered: Turnstile's outside script; no key change when a passkey is removed; delete wording; sessions with no key writing junk; snapshots; the device-add link; forged bank data and time; downgrade to plain text; understated metadata; sealing to a public key; the cost of abandoned Items; comparing rows that hold clock values; edits the engine doesn't run today; undo in the engine; server work the design forgot; data migrations per device; deploy rollback onto sealed data; emptying tables that refuse deletes; the relay as an open door to Plaid; PRF salts with discoverable passkeys; conflicts with D-77 and D-78; the size of the copy; the delete order; and CODEOWNERS.

### 15.2 v4

Not yet reviewed.

### 15.3 Still unverified, to settle in phase 0

PRF behaviour with the owner's existing passkey, with other passkey apps and with security keys in Safari; hosted Link on Plaid Trial and its return path on an iPhone; what Cloudflare's invocation logs hold; whether a wiped store stays in point-in-time recovery; Ed25519 checking, and sealing and signing a page, inside 10 ms; "related origins" for a later change of address.

**Open for good:** code sent to one person once can't be detected by any web-only means (4.2). The design says so and offers no fix inside the $0 rule.
