# Privacy design: a server that holds no key to a budget

Status: v3, Nov 10, 2026. A proposal: nothing here is built. The owner answered most of its questions on Nov 10 (section 14, D-85); three are still open. v1 got two adversarial reviews (the key design and the claims; the fit with the code); v2 included their fixes, and section 15 lists them. v3 adds the owner's answers. `docs/architecture.md` says what runs today.

What the owner asked: to offer Ledgerline to other people as a privacy-focused budget app, with the strongest privacy and security claims that can be made honestly, and to know what has to change and what users would see.

## 0. The short answer

Today the server stores every budget as plain text, so the honest claim is "we don't look". This design changes that to "we hold no key":

1. **The budget is encrypted on the device** with a key the server never has. The server stores only sealed data.
2. **All work on budget data moves to the device**: every edit, bank processing, matching, the daily scan. The device already works out every screen (D-45, D-46), but most edits and all bank work still run on the server, so this is a large move, not a small one.
3. **Bank data passes through the server and is not stored readable.** The device, not the server, keeps each bank link's access token.
4. **No outside script runs where the keys are**, no email address is collected, and logs hold nothing about a person.
5. **The code is public** and each release can be compared with it.

Four limits stay whatever is built (section 4): Plaid sees bank data; a web app runs the code its server sends; the server sees that an account exists and when it is used; and the server can lie about bank data and the time. The claims in section 1 are worded around those limits.

Two prices:

- **Nobody can reset an account, and nothing can be restored.** A person who loses every passkey and the recovery key loses the budget (accepted by the owner, D-85).
- **Two Money rules count by when a bank row arrived** (D-67, D-68). They keep working unchanged only if the server keeps fetching in the background (5.5, shape B, recommended while the bank source is Plaid).

## 1. The claims

### 1.1 What could be said, and what backs each

"Checkable" means a stranger can confirm it. "Our word" means it rests on the public code being what runs, plus an outside audit: nobody outside can inspect a running Worker.

| Claim (plain words)                                                                                                                                                            | True from                                   | Backed by                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------- |
| "Your budget is encrypted on your devices with a key we never hold. What we store can't be read by us, or by anyone who copies it."                                            | 30 days after phase 6 clears the old tables | Public code for the app (checkable, 5.9); audit           |
| "We keep no readable copy of your bank data. It passes through our server on its way from Plaid to your device."                                                               | The same                                    | Our word; audit                                           |
| "We use the key to your bank link only to fetch your data, seal it for you at once, and remove the link." (Shape B. With shape A: "We don't store the key to your bank link.") | Phase 5                                     | Our word; audit                                           |
| "No ads, no trackers, no analytics. No outside script runs on any page that holds your budget or your keys."                                                                   | Phase 1                                     | Checkable: the Content Security Policy header             |
| "No email address and no phone number."                                                                                                                                        | Phase 1                                     | Checkable: the sign-up screen                             |
| "When you delete your account we delete everything we hold. Sealed remains last up to 30 days in Cloudflare's recovery and open only with your own keys."                      | Phase 5                                     | Our word; audit                                           |
| "The app's code is public, and every release is built from it in public."                                                                                                      | Phase 7                                     | Checkable: the repository, the build log, the attestation |
| "A budget entered by hand involves no bank and no Plaid: only your devices hold anything readable."                                                                            | Phase 5, plus accounts without a bank link  | Public code; audit                                        |

Each claim is published next to the limit that goes with it: "Like every web app, this depends on the code we send your browser. That code is public (4.2)."

### 1.2 What must never be said

- **"We can't read your data"** or **"nobody who breaks in can read it"**, flat. Someone who can change the code the server sends can (4.2). Say "we hold no key" and "stored data can't be read".
- **"Zero-knowledge"** or **"end-to-end encrypted"**, for any budget. The server relays bank data, learns metadata, and sends the code.
- **"We have no access to your bank."** The Worker holds the Plaid secret and sees the access token each time it relays a call (5.5).
- **"We keep no copy of your bank data."** We keep a sealed copy. Say "no readable copy".
- **"Nobody but you can see your transactions."** Plaid can, and so can the bank.
- **"Deleted at once", "gone for ever".** Cloudflare's recovery keeps sealed bytes 30 days, and Plaid keeps its own records under its own policy.
- **"We can't be forced to hand anything over."** We can be made to hand over sealed data and metadata, and in principle to ship changed code.
- **"Anonymous."** Cloudflare sees IP addresses, and Plaid knows who the person is.
- "Bank-level", "military-grade", "unhackable".

### 1.3 The pitch that survives a hostile reader

> Your budget is encrypted on your devices with a key we never hold. Bank data comes through Plaid and passes through our server without being stored in readable form. No email, no trackers, public code.

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

`docs/threat-model.md` accepts this for one owner: "a compromise of your Cloudflare account exposes the data and the secrets". That sentence is what has to stop being true for stored data.

## 3. Who we defend against

| Who                                                                                                                                                      | Today                                      | After this design                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stranger on the internet                                                                                                                               | Stopped                                    | Stopped                                                                                                                                                                         |
| Someone who copies the database, a backup or a restore                                                                                                   | Reads everything                           | Gets sealed data and metadata                                                                                                                                                   |
| The operator being curious, or a legal demand for stored data                                                                                            | Reads everything                           | Sealed data and metadata only                                                                                                                                                   |
| Stolen Worker secrets plus the database                                                                                                                  | Can pull 180 days of bank history per link | Can pull nothing: the server stores no access token                                                                                                                             |
| Someone who can **write** to the database but not change code                                                                                            | Can change a budget                        | Can't forge an entry (5.3); can hold back or delete data, which devices notice                                                                                                  |
| Someone who can **change the code the server sends or runs** (a taken-over Cloudflare or GitHub account, a bad dependency, an operator under compulsion) | Reads everything                           | **Reads the budgets and bank tokens of people who use the app while the bad code is live.** Phase 7 makes an untargeted change visible afterwards; it does not prevent it (4.2) |
| A server that lies about bank data or the time                                                                                                           | Not considered                             | Not prevented (4.4)                                                                                                                                                             |
| A server that hides, repeats or forks changes                                                                                                            | Not considered                             | Rollback of what a device has seen is detected; a fork is detected when devices compare (5.3)                                                                                   |
| Plaid                                                                                                                                                    | Sees bank data                             | Sees bank data (4.1)                                                                                                                                                            |
| Someone with the unlocked device and its passcode                                                                                                        | Reads the budget                           | Reads the budget                                                                                                                                                                |

## 4. Limits no design here removes

### 4.1 Plaid sees the bank data

Plaid fetches transactions from the bank and keeps them under its own policy. Its API answers only a server that holds our Plaid secret, so the data must pass through our Worker; Plaid can't encrypt to a person's device. The claims are therefore about what we **store**. The privacy policy names Plaid and links its policy and its page where a person can see and remove connections.

A budget with no bank link has none of this. "Accounts without a bank link" (`docs/build-plan.md`) is the most private mode. It waits on D-78 and on the owner's Money-rules answers about starting balances.

### 4.2 A web app runs whatever its server sends

The keys live in the browser, and the browser runs the JavaScript the Worker serves on each visit. Whoever controls that JavaScript can read the keys. A service worker can't prevent it: the browser replaces a service worker with whatever new one the server sends. A changed Worker can also keep every bank token it relays. No web-only design closes this. What can be done:

- make every release public and comparable (5.9), so an untargeted bad release leaves evidence. Code sent once to one person leaves none;
- make it hard to ship code without the owner seeing it (5.10);
- or ship an app from an app store, where the code is signed and can't change per visit. That has a yearly fee and breaks the $0 rule.

### 4.3 What the server and the operator still learn

- That an account exists, when it was made, how many passkeys and devices it has, each passkey's maker id, and each session's user agent.
- When the app is used and from which IP address (Cloudflare sees it; the app stores none).
- How many changes are made and when, and their rough size. Padding (5.3) blurs size, not count or timing; a bank step looks different from a typed edit.
- For each bank link: the Plaid Item id, **which bank it is** (Plaid's dashboard shows the operator every Item's bank), when it was linked, when Plaid says it has news or needs repair, and the size of each relayed answer, which hints at how many transactions it holds.
- Bank data and the access token, in the Worker's memory, for the moment of each relayed call.

The page "what we can hand over" (section 11) lists exactly this.

### 4.4 The server can lie about bank data and the time

Plaid doesn't sign its answers for the device. A Worker running changed code could add, alter or drop bank rows and balances before relaying them, and the device would seal them as true. The server also supplies "today" (`apps/worker/src/local/engine.ts`), which decides the current month. The device refuses a server time far from its own clock, and that is all it can do. This is the same trust as 4.2.

### 4.5 The device

Someone with the unlocked device and its passcode reads the budget, as today (`docs/phone-budget.md` 13.6). A jailbroken device, a malicious browser extension on a computer, a shared or exported passkey, and the iOS keyboard's learning are outside what the app controls.

## 5. Design

### 5.1 Shape

```
            Plaid ──(bank data, TLS)──▶ Worker ──(relayed, not stored)──▶ device
                                          │                                  │
                                          │                      engine: all budget work
                                          │                      (edits, matching, scans)
                                          ▼                                  │
   Directory: accounts, passkeys, sessions,                                  │
   key slots (sealed), Item ids, usage counts     ◀──(sealed, signed entries)┘
   BudgetStore: a sealed log + sealed snapshots
```

The server keeps doing four things: sign-in, storing and ordering sealed entries, relaying Plaid calls, and counting usage for the free plan's limits. It stops doing everything that reads a budget.

### 5.2 Keys

Building blocks: AES-256-GCM, HKDF-SHA-256, SHA-256, Ed25519 and X25519 from WebCrypto, which Safari 17 and Workers have. Sealing to a public key (adding a device) uses HPKE (RFC 9180) through one reviewed library, checked against the RFC's test vectors; that library is the only dependency in the key code. Before phase 2, an appendix to this file fixes every derivation label, associated-data string, nonce rule and size, because an outside reviewer asks for that first. The rules it must hold:

- **Budget key.** 256 random bits made on the device when the budget is made, and only then: **a client never makes a key for a budget that already exists**, whatever the server says, so a server can't trick a device into starting over in the clear. HKDF derives one key per use and per key version: log entries, snapshots, bank tokens, and a signing key pair.
- **In memory.** Derived keys are non-extractable. The raw budget key is unwrapped as extractable only during a slot change, which needs a fresh passkey prompt, and is dropped after. The key kept for a page refresh (`holdKey` in `vault.ts`) holds derived keys only.
- **Key slots.** The server stores the budget key only wrapped, once per way in:
  - **one slot per passkey**, wrapped under HKDF of that passkey's PRF output (the WebAuthn `prf` extension the copy already uses). Sign-in uses discoverable passkeys, so the app can't know which passkey will answer before it asks; the PRF input for slots is therefore one constant for the whole app, sent as a second PRF input beside the copy's per-device salt. PRF output differs per passkey anyway. Its labels differ from the copy vault's, so the two uses of one passkey give unrelated keys.
  - **one recovery slot**, wrapped under a key from the recovery key (5.8).
  - A slot's associated data binds the user, the budget, the passkey id, the key version and the slot format.
- **Sign-up ends only after the new slot has been opened once**, with a second passkey prompt, so a passkey that can't give PRF output is found before a budget depends on it.
- **A passkey with no PRF can't open a budget.** Today such a passkey opens the budget in memory (D-57 item 4). iCloud passkeys on iOS 18 and later have PRF; older systems don't. Other passkey apps and security keys vary: phase 0 tests them, and a passkey that fails the check above is refused at sign-up.
- **Signing.** An Ed25519 pair derived from the budget key. The server stores the public half and refuses any entry or snapshot not signed by it, so a session that holds no key (a stolen cookie, a passkey with no PRF) can't write junk into a budget. Verifying must fit the 10 ms rule; measure it in phase 0.
- **Changing the key.** Removing a passkey, signing a device out, making a new recovery key, or a device-add that is cancelled all make a new key version: a new budget key, a fresh sealed snapshot, new slots, a new signing key. Entries written before stay readable to whoever held the old key and an old copy of the data; the policy says so.
- **The copy on the device stays as built**: its own data key, wrapped under the passkey's PRF output and the per-device server share, so "Sign out other devices" still turns a copy off.
- **Adding a device.** A passkey synced by iCloud Keychain gives the same PRF output on every Apple device, so its slot just works. For a separate passkey: the new device makes an X25519 key pair and shows a short code; the person checks the same code on the signed-in device, which then seals the budget key to that public key. One use, 10 minutes. (v1 put a secret after `#` in the link; a link can be copied, synced and left in history.)
- **AES-GCM limits.** Random 96-bit nonces, and far fewer than 2^32 seals per derived key; a key version change resets the count. AES-GCM doesn't commit to its key, which is harmless here because every key is 256 random bits and never chosen by another party.
- **Later:** a post-quantum hybrid for device-add. Everything stored is sealed with symmetric keys and is not at risk from that.

### 5.3 What the server stores: a sealed, signed log

`BudgetStore` keeps, per budget, a log and snapshots, and no budget tables.

**Entries.** One entry is the set of row changes that one edit, one bank run or one scan made. It holds **results** (rows), not operations: a device applying an entry writes rows and re-runs nothing. Each entry carries:

- in clear: its number, a random entry id, the writer's device id and that device's own counter, the key version, the schema version, the **processing version** (below), and the signature;
- sealed: the row changes, and the last entry number and hash this device has seen from every other device;
- associated data: the budget id, the number, and the hash of the entry before it. Hashes cover the sealed bytes, the nonce and the clear fields.

Bodies are padded to size steps (256 bytes, 1 KB, 4 KB, 16 KB, 64 KB). A change set larger than 64 KB is split into parts that the server appends in one step or not at all.

**What the row changes cover.** Every table an edit or a bank run writes, not only today's `SYNC_TABLES`: also `audit_log`, `txn_key_move`, the bank log (`bank_event`, `bank_page`), and the cursor of each connection. Section 6.2 lists every table.

**Writes are compare-and-swap, and safe to resend.** A device sends `{ base: N, entries }`. The server appends only if the log's last number is `N` and the signature is good. If it already holds an entry with the same entry id, it answers "already stored" and stores nothing: without this, a write whose answer was lost would be redone on top of itself, and `budget/assign`, which adds, would assign twice. This takes over the job of `edit_seen` (`routes/sync.ts`). Otherwise it answers with the entries after `N`.

**Redoing a refused write.** Today the engine can't undo an edit: one edit is several SQLite batches plus `derive()`, and the copy drops the change-log triggers (`local/engine.ts`). The copy therefore becomes two things: a **confirmed base** (the state at the last entry the server accepted) and a **queue** of edits not yet accepted, each kept as the request that made it, as the offline queue is today. The screens show base plus queue. To send, the engine runs the queued edit on the base with triggers that record each changed row, and builds the entry from that record. When the server refuses, the engine drops the result, applies the newer entries to the base, and runs the queue again. A queued edit can fail the route's own checks on the newer base (the category was removed meanwhile); the person is told, as a refused offline edit is today. The redo is tried a few times, then waits; it can't spin.

**Processing version.** Applying an entry needs no logic, but making a bank entry runs the matching code, and a tab left open keeps old code (`sw.js` serves the saved shell). The log holds the lowest app version allowed to process bank data or run scans, as `DERIVE_VERSION` does for derived numbers. An older client reads and edits but doesn't process until it updates. A data migration (today's one-time jobs such as `refile_payees`) is written once, as one entry, by the first device on the new version; the others apply it as rows.

**Snapshots.** A device writes the whole base, sealed, in chunks, with a sealed and signed manifest: snapshot id, chunk count, each chunk's hash, the entry number and hash it stands at, and hashes of the chain at regular checkpoints. A device checks a new snapshot against its own state before trusting it. Entries older than a snapshot are deleted 30 days after it. A device away longer than that proves its remembered position against the checkpoints.

**A lying server: what is and isn't caught.**

- It can't forge or alter an entry or a snapshot.
- **Rollback.** Each device keeps the last number and hash it saw in a place separate from the copy, and nothing the server says clears it: not a new sync epoch, not a refused edit, not a revoke. A download that doesn't reach that position shows a warning with no default choice.
- **Holding back** new entries from one device can't be told apart from "nothing new" by that device alone.
- **A fork** (two devices each shown a different branch) can't be seen by one device alone. Because each entry carries what its writer last saw from the others, a fork shows the moment any entry crosses between branches. Settings → Sign-in also shows a short code for the log's position that can be compared across two devices by eye.
- A **new device** can be shown an older, consistent past. Setting one up shows "Last change: {date}, from {device}" to confirm.

So the claim is "a device notices if the server rolls back what it has seen", not "the server can't hide changes".

**No restore (owner, Nov 10, D-85).** Today a restore is the operator rolling a store back (`docs/runbooks/restore.md`, D-77). A sealed budget can't be checked or repaired by the operator, and the owner doesn't want a restore in the app either. So this design has no restore of any kind: the runbook and the undo (D-77) are retired at the cutover, and Cloudflare's point-in-time recovery is no longer used for budgets. A device that sees the server behind it shows the warning above and stops; it doesn't offer to overwrite either side. The full backup stays as a way to take your data out (5.8), not to put it back.

### 5.4 All budget work moves to the device

What the engine runs today: every screen, and six kinds of edit while offline (`OFFLINE_EDITS` in `apps/web/src/copy/copy.ts`). Every other edit and all background work run only on the server. The job runner is written against Durable Object storage (`store/jobs.ts`), the engine's environment has no Plaid keys and a sync starter that does nothing (`local/engine.ts`), and some handlers mix Plaid calls, token handling and budget writes in one function (`routes/settings/connections.ts`, `finalizeConnection` in `sync/process.ts`). So:

| Work                                            | Today                                      | After                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every edit (`routes/*.ts`)                      | Checked and stored by the server           | Run in the engine; the result is a log entry. Each route is first proved to give the same rows in the engine as on the server (a mutation twin of `engine-routes.test.ts`) |
| Bank sync: fetch, apply, process                | `BudgetStore` alarm jobs, 25 events a step | Fetch stays on the server and seals each page (5.5, shape B); apply and process run in the engine while the app is open                                                    |
| Daily scan, maintenance                         | Alarms at 5:00 and 2:20                    | The engine, on the first open of the day                                                                                                                                   |
| Handlers that mix Plaid calls and budget writes | One function                               | Split: a relay call on the Worker, a budget write in the engine                                                                                                            |
| The bank log (`bank_event`, `bank_page`)        | Server only, append-only by trigger        | On the device, with the same triggers, stored beside the main copy and appended in chunks, so each save doesn't re-encrypt it all                                          |
| Raw Plaid pages (`raw_page`)                    | Server only, kept for ever                 | Section 14: recommended not kept                                                                                                                                           |
| Health and alerts                               | Server writes them                         | The engine writes them                                                                                                                                                     |

**One bank run is one unit.** v1 said two devices processing the same pages are safe because the second finds the cursor moved. That is wrong for today's code: the cursor moves only on a run's last page, events are unique per run id, and the lease lives in columns the copy doesn't hold (`sync/steps.ts`, `sync/lease.ts`), so a second device starting from the old cursor would write the same Plaid rows again as new events. Instead: a device fetches a run's pages into memory, applies and processes them on a scratch copy of the base, and sends **one** compare-and-swap write that holds the bank rows, the results and the cursor move. If another device got there first, the write is refused and the whole run is thrown away; on the redo the cursor has moved and there is nothing to do. No lease is needed between devices, and a phone put in the background mid-run loses nothing. A test with two engines covers exactly this.

**Step sizes stay as they are.** Matching results depend on the step size: `docs/build-plan.md` records a case where it changed the number of "Same purchase?" questions. The device has no 10 ms limit, but the steps stay at 25 events until the owner accepts a change. Small steps also keep the app answering, because the engine handles one message at a time (`local/web-entry.ts`).

**Arrival time and the Money rules.** D-67 gives a bank row its role by when it first arrived (`bank_txn.created_at`, read in `ledger/link.ts`): "within an hour of the connection's first row", "within 14 days of the link". D-68 shows a bank difference once it "has lasted a day". Today the server fetches within minutes of Plaid's webhook, so arrival means "when the bank had it". With fetching only while the app is open, arrival would mean "when the app was next opened": a person who links a bank and opens the app three weeks later would have settling rows counted as history. That would be a Money-rules change. Shape B in 5.5 avoids it: the server keeps fetching in the background and stamps each page's arrival, so both rules count as today.

**Proving the rest is unchanged.** Row ids and times come from the clock (`ulid(now)`), and some results depend on when a step ran, so the device's rows can't be compared with the server's byte for byte. Phase 4 defines a canonical comparison: the same event stream, the same `now`, the same step size, compared without ids and timestamps. It runs on the owner's real budget, the device beside the server, before the server's processing is switched off. It also fixes a time zone written into `sync/process.ts` that must come from the budget.

### 5.5 Bank data: never stored readable

There are two shapes. Which one fits depends on the bank source, which the owner has left open (question B in section 14).

**Shape B: the server keeps the bank key, fetches in the background, and seals each page at once. Recommended while the bank source is Plaid.**

- The server keeps each access token as today (`connection.access_token_enc`, under `TOKEN_KEYS`). No token moves, and no Item is touched.
- The fetch step runs on alarms as today. It already takes a page from Plaid without parsing it (`packages/bank-provider/src/plaid.ts`). Instead of storing the page in `raw_page`, it seals it to the budget's **inbox public key** (HPKE) and stores the sealed page with its arrival time in clear. The server's apply and processing steps are gone.
- The inbox key pair is made on the device; the private half is sealed under the budget key. The public half is signed with the budget's signing key. Someone who can write to the database could swap both public keys and read pages fetched after that; devices would then fail to open their inbox and say so.
- The device opens the inbox pages in order and processes them as one unit (5.4). Its entry records how far into the inbox it got; the server then deletes those sealed pages.
- **The Money rules are untouched:** arrival times are the server's, as today (D-67's "within an hour" and "within 14 days", D-68's "lasted a day"). The shadow run checks this.
- The server can remove an abandoned account's banks at Plaid, which the owner asked for (5.8).
- The claim is: "We keep no readable copy of your bank data. We use the key to your bank link only to fetch your data, seal it for you at once, and remove the link." It is **not** "we don't store the key".
- The weakness: someone who steals the database **and** the Worker's secrets can pull each link's history from Plaid (180 days at link, and whatever is new).

**Shape A: the device keeps the bank key, and the server only relays.**

- The device sends `{ token, cursor }` to `POST /api/bank/fetch`; the Worker adds the Plaid secret, streams Plaid's answer back, and stores nothing. The Directory keeps a SHA-256 of each token with its budget and refuses any other token, so the endpoint isn't a general door to Plaid.
- Stronger: nothing stored on the server can ask Plaid for anything.
- But: rows arrive only while the app is open, which changes what "arrived" means for D-67 and D-68 (a Money-rules change); the server can't remove an abandoned account's banks; and the owner's 7 tokens would have to move to a device, with 3 lifetime links left as the margin for error.

**Both shapes:**

- **Webhooks.** Plaid's webhook still reaches the Worker and is verified. The Directory records per Item only "has news" or "needs repair" (today `login_required` is written into the store, `routes/ops.ts`).
- **Linking.** After Link finishes (5.7) the Worker exchanges the public token at once, as today, so a link is never lost. It never removes an Item by itself except for a deleted or expired account (5.8): on Plaid Trial a removed Item still counts toward the 10 for life. The count of links ever made moves from the store's `connection` table to the Directory before the tables are sealed.
- **Replacing tokens** (`/item/access_token/invalidate`) is tabled by the owner until the bank source is settled (D-85).

#### Bank sources other than Plaid

The owner asked whether a more private source exists. Checked on Nov 10, 2026 from public pages only; nothing was tried.

| Source                                    | Privacy                                                                                                                                                                                                                                                                                                      | Cost and limits                                                                                   | Fit                                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No bank link (typed entries)              | Best: nothing leaves the device unsealed                                                                                                                                                                                                                                                                     | Free                                                                                              | Needs "accounts without a bank link" (`docs/build-plan.md`) and the owner's starting-balance answers                                                                                 |
| A bank file read on the device (OFX, CSV) | Best: the file never reaches the server                                                                                                                                                                                                                                                                      | Free; the person downloads a file from the bank by hand                                           | D-81 removed CSV import over two Money-rules problems; those would need answers first                                                                                                |
| SimpleFIN Bridge                          | Good: the person has their own account with the bridge and gives the app a read-only link they can switch off. The device could keep that link, so shape A works without the abandoned-account problem. The bridge itself still sees the data and reportedly uses a large aggregator behind it (unconfirmed) | The **person** pays the bridge about $15 a year; nothing for the operator; no lifetime link limit | Sends less than Plaid (no merchant ids), so payee names and matching (D-63, D-65) would need rework. To check: whether a browser can call it directly, so bank data skips our server |
| Akoya                                     | Says it passes data through and stores none; the person signs in at the bank itself                                                                                                                                                                                                                          | A business contract; not for a $0 project                                                         | No                                                                                                                                                                                   |
| Teller                                    | Like Plaid: it holds the connection                                                                                                                                                                                                                                                                          | Free up to 100 live connections                                                                   | No privacy gain                                                                                                                                                                      |
| Direct from the bank (US "1033" rule)     | Would be best: no middleman                                                                                                                                                                                                                                                                                  | The rule is blocked in court and being rewritten                                                  | Not available                                                                                                                                                                        |

Recommendation: keep Plaid for the owner's budget; build the device's bank code against a small "bank source" interface so a second source can be added; in phase 0, try SimpleFIN Bridge with one account to see what it sends. For other people it removes both the Plaid Production cost and the lifetime link limit, at a yearly price they pay themselves.

### 5.6 Identity and metadata

- **No email.** Already true for sign-ups: `user.email` gets a random value (`routes/signup.ts`). The owner's row keeps its value, because the saved copy on the owner's devices is filed under it (`vault.ts` `recordKey`).
- **The name.** Sign-up requires a name today. It becomes optional and is described as a label ("anything you like"); Settings → Users shows the label or the account's date.
- **Budget name and bank names** move into the sealed budget. Two server checks that compare a typed budget name (delete account, `routes/people.ts`; restore, `routes/sync.ts`) move to the device. Section 4.3 is clear that the operator can still learn which bank an Item is.
- **Passkey names, device names, user agents:** kept only as long as the passkey, device or session; device and passkey names are the person's own words and can be blank.
- **Usage events and notes** (`usage_event`, `usage_note`, `usage_daily`) stay on the device, sealed with the budget. A person can export their own. The operator gets none from other people.
- **Logs.** Paths become generic (`/api/log`, `/api/bank/fetch`), so a path no longer holds a transaction id. Phase 0 checks what Cloudflare's invocation logs record per request; if that includes an IP address, they are turned off before any claim about IP addresses is made.
- **Turnstile** (open sign-up, `docs/open-signup.md` 13) needs a script and a frame from `challenges.cloudflare.com`. It runs on its own page with its own CSP, before any key exists, and the app proper is reached by a full page load after it. The recovery screen, where the recovery key is typed, does the Turnstile step first and the key step after the same kind of page load.

### 5.7 No outside script where the keys are

Today the CSP allows `https://cdn.plaid.com` as a script source, and Plaid Link's script runs in the same page as the copy. With the budget key in the page, that is no longer acceptable.

Use Plaid's hosted Link: the app opens a page on Plaid's own site, the person links the bank there, and Plaid tells our server when it is done. The app's CSP becomes `script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'` with no `frame-src`. To check in phase 0: that hosted Link is offered on Plaid Trial; and what happens on an iPhone when a bank's own sign-in returns to Safari while the person started in the Home Screen app, which has separate storage. The app finishes a link by asking the server, not by trusting where the browser lands. The Worker asks Plaid for the same products as today and no more.

Also: drop `'unsafe-inline'` from `style-src`, add Trusted Types where the browser has them, and keep the CSP test that fails when any source loosens.

### 5.8 Recovery, backup, deleting

- **Recovery key.** 256 random bits, shown once at sign-up as words or letter groups. HKDF splits it in two: one half proves to the server that the person may add a passkey (the server stores only its hash, as with today's recovery code, `docs/open-signup.md` 4); the other half opens the recovery slot. It replaces the recovery code. Making a new one changes the key version (5.2).
- **No reset, by anyone.** The owner's runbook recovery (`docs/runbooks/setup.md`) can give back a sign-in but not a budget, so the owner needs a recovery key too. Today recovery codes are "not for admins" (`docs/open-signup.md` 4); that rule changes (owner's yes, D-85).
- **Full backup.** Made on the device, after a fresh passkey prompt, which stands in for today's 15-minute rule on the server export. Sealed with the recovery key by default, so no password and no password-stretching code are needed; or plain, with a warning. `GET /api/export/dump` goes away. It is a way to take your data out; there is no way to load it back (5.3).
- **Deleting an account.** With shape B (5.5) the order in `docs/open-signup.md` 12 holds: the server removes each Item at Plaid from its stored token, with retries, then wipes. With shape A the device must send each token while the session is still live, before anything is deleted. What protects the remains is that the server never had the key, not that the slots are deleted: slots are wrapped under the person's own secrets. Whether Cloudflare's recovery keeps a wiped store's bytes is stated two ways in the docs (`docs/open-signup.md` 12 says it can't bring them back); phase 0 tests it, and the claim says "up to 30 days" until then.
- **Idle accounts are deleted (owner, Nov 10, D-85).** An account not opened for 24 months is deleted like any deleted account, banks at Plaid included (shape B). With no email there is no way to warn someone who never opens the app, so sign-up and the policy say it plainly, and the app shows the date under Settings → Privacy. The owner's own account is exempt. This replaces "nothing is deleted for being idle" (`docs/open-signup.md` 1 and 9).
- **Telling people about an incident.** With no email, notices show in the app at sign-in. A notice can require action before the budget opens: "replace your bank tokens", "make a new recovery key". The policy says this is the only channel.

### 5.9 Public, comparable releases

- **The repository is already public** (checked Nov 10, 2026). So the code is open today, and branch protection is available. Its docs and history hold the owner's own purchases, bank names and the Cloudflare account id (for example `docs/decisions/D-67-start-date-rule.md`, `CLAUDE.md`); none is a secret, but the owner may want them out before pointing strangers at it (question C).
- The web build is made reproducible: the same commit gives the same files, byte for byte.
- The deploy workflow publishes the list of file hashes for each release with a build attestation (free for public repositories), and Settings → About shows the release's commit and hash.
- Anyone can then compare what the site serves with what the public build made. This covers the app's code. It says nothing about what the Worker runs, and it can't catch code sent to one person once (4.2). The policy says both.

### 5.10 Who can ship code

After this design, the code path is the attack surface. Today every Claude session merges its own PRs and each merge deploys (`CLAUDE.md`, D-51). For a product that holds other people's budgets:

- A change to the key and sealing code, the relay, the CSP (`apps/web/public/_headers`), `sw.js`, the build, or `.github/workflows` needs the owner's review before merging. `.github/CODEOWNERS` is `*` today; it is narrowed to those paths, so other work still merges as now. Enforcing it needs branch protection, which is available because the repository is public. The owner said yes to this rule (D-85); it starts when the key code exists, with a change to `CLAUDE.md` then.
- No new runtime dependency in the key and sealing code without the owner's review.
- Hardware-key or passkey two-step sign-in on Cloudflare, GitHub and Plaid (`docs/threat-model.md` says so already), and a Cloudflare API token that can deploy the Worker and nothing else.

### 5.11 What stays the same

Passkey sign-in, sessions, CSRF checks, rate limits, the breaker and fair-use shares (they count requests, entries and bytes, not content), the one cron, deploys by merge, and every Money rule except the one in question 1. The 15-minute recent-passkey rule stays for linking and passkey changes, and becomes a passkey prompt on the device for backups.

## 6. What changes in the code

### 6.1 By area

| Area                                                | Change                                                                                                                                                                                                                                      | Size   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `apps/web/src/copy`                                 | Budget key, slots, recovery key, device-add, key versions, sealing, signing, the remembered position, base plus queue, snapshots                                                                                                            | Large  |
| `apps/worker/src/local`                             | Run every edit, the bank run as one unit, scans and maintenance; record row changes; hold the bank log beside the copy                                                                                                                      | Large  |
| `apps/worker/src/routes`, `sync`, `ledger`, `views` | Split handlers that mix Plaid and budget writes; remove what depends on Durable Object storage, alarms and leases; the rest runs unchanged, on the device only                                                                              | Large  |
| `apps/worker/src/store/budget-store.ts`             | Becomes the sealed log and snapshot store; jobs, dump and heavy-read code go                                                                                                                                                                | Large  |
| `apps/worker/src/store/directory.ts`                | Key slots, signing public key, Item flags and token hashes, lifetime link count; delete order                                                                                                                                               | Medium |
| `packages/bank-provider`                            | Relay calls that take the token from the request and stream; hosted Link; token replacement                                                                                                                                                 | Medium |
| `apps/worker/src/http/challenge.ts`                 | Sign-in challenges are signed with `TOKEN_KEYS` today. They get their own secret **before** anything else here, or removing `TOKEN_KEYS` breaks every sign-in                                                                               | Small  |
| Migrations                                          | New: sealed log, snapshots, key slots. Old tables: one migration drops the no-delete triggers; a stepped job under the breaker empties them (section 8)                                                                                     | Medium |
| Tests, dev seed, e2e                                | The engine suite becomes the main one; new: edits in the engine match the server, two devices, lost answers, a lying server, key slots, recovery. `dev-seed.ts` and e2e seed the store's tables today and need a device or a sealed fixture | Large  |
| `tools/ci/smoke.mjs`, `deploy.yml`                  | The smoke test reads `watermarkLag` from `/api/health`; it changes in the same PR as health, or the deploy rolls itself back                                                                                                                | Small  |
| Docs                                                | `architecture.md`, `threat-model.md`, `sync-spec.md` notes, runbooks, a decision per phase                                                                                                                                                  | Medium |

This is the largest change since the budget moved to the phone.

### 6.2 Where each server-side thing goes

| Today                                                                    | After                                                                            |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Synced tables (`sync-tables.ts`)                                         | In log entries                                                                   |
| `bank_event`, `bank_page`, connection cursor                             | In log entries; kept beside the copy                                             |
| `raw_page`                                                               | Not kept (section 14, still open)                                                |
| `audit_log`, `txn_key_move`                                              | In log entries                                                                   |
| `change_log`, `edit_seen`                                                | Replaced by the log's numbers and entry ids                                      |
| `sync_run`, `sync_page`, `apply_counter`, `lease_guard`, connection lock | Device only, inside one run; not shared                                          |
| `job`                                                                    | Gone from the store; the engine keeps its own list                               |
| `usage_event`, `usage_daily`, `usage_note`                               | Device only, sealed; the server's cap on batch size becomes a cap on entry bytes |
| `budget_line`, `month_snapshot`, month totals                            | Device only, as today                                                            |
| `GET /api/session` (reads name, time zone, setup step)                   | Account facts from the Directory; budget facts from the copy                     |
| `GET /api/health` (reads connections and the bank log)                   | Server health only: the log's size and age, relay errors, limits                 |
| Webhook writing `login_required` into the store                          | A flag per Item in the Directory                                                 |
| Sync epoch                                                               | Kept, but it can no longer make a device forget its remembered position          |
| Restore and its undo (D-77)                                              | Retired: no restore (5.3)                                                        |
| Idle budgets stopping their jobs                                         | Nothing to stop: a sealed store has no jobs                                      |
| Breaker and fair-use shares                                              | Unchanged; they count requests, entries and bytes                                |
| Admin Settings → Users                                                   | Unchanged; it never showed budget content                                        |
| Server clock for "today"                                                 | Kept; the device refuses a time far from its own (4.4)                           |

## 7. What the user sees

| Where                                      | Today                                 | After                                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-up                                    | Name, passkey, then a recovery code   | An optional label, passkey, a second passkey prompt to prove the key works, then a **recovery key**: "If you lose your passkeys and this key, your budget is gone. We can't reset it." A step asks for part of the key back |
| Opening the app                            | Bank rows are already in              | Shape B: bank pages are waiting, sealed; the device opens and files them on open ("Getting your bank's latest"). Screens answer between steps, a little slower meanwhile                                                    |
| After weeks away                           | Up to date at once                    | A longer catch-up. Repeating upcoming rows catch up one step per scan (`daily-scan.ts`), so the first open runs several scans before numbers settle                                                                         |
| Linking a bank                             | Plaid Link opens inside the app       | The app hands off to Plaid's page and comes back                                                                                                                                                                            |
| A new device                               | Sign in; the budget downloads         | The same with an iCloud passkey. With a separate passkey: compare a short code on both devices, or type the recovery key                                                                                                    |
| An old browser or system                   | Works, with the copy in memory        | "This device can't open an encrypted budget"                                                                                                                                                                                |
| Two devices at once                        | Both edit; the server orders them     | The same. A refused write is redone unseen; if the redo can't apply, the person is told which edit was dropped                                                                                                              |
| Removing a passkey or signing a device out | Immediate                             | A moment longer: the budget gets a new key and is sealed again                                                                                                                                                              |
| Settings → Backup                          | Full backup downloads from the server | Made on the device after a passkey prompt; sealed with the recovery key by default. It takes data out; nothing loads it back                                                                                                |
| Settings → Sign-in                         | Passkeys, devices, recovery code      | Adds "Recovery key: make a new one" and a short code to compare between devices                                                                                                                                             |
| Settings → About                           | Version                               | Version, release commit and hash, a link to the public build                                                                                                                                                                |
| Settings → Privacy (new)                   | Nothing                               | What is sealed, what the server knows (4.3), who else handles data (Cloudflare, Plaid), delete account                                                                                                                      |
| Delete account                             | Refused with linked banks             | Works; removes the banks at Plaid first; says what remains for 30 days. An account not opened for 24 months is deleted the same way                                                                                         |
| A restore                                  | The operator restores for you         | There is no restore                                                                                                                                                                                                         |
| Support                                    | The operator can look                 | The operator can't look. Help is by description, or a backup the person chooses to send                                                                                                                                     |
| A server that rolls back                   | Not shown                             | "The server's copy is older than this device's." The app stops there                                                                                                                                                        |
| A security notice                          | None                                  | Shown at sign-in; some must be acted on before the budget opens                                                                                                                                                             |

All new text follows `docs/copy.md`.

## 8. Moving the owner's budget

The owner's budget is real, migrations are forward-only, and 7 of 10 lifetime bank links are used. Each step below that merges a migration needs the owner's yes (`CLAUDE.md`). **No bank is linked, re-linked or removed at any step.**

1. **Before anything:** sign-in challenges get their own secret (6.1). A full backup. PRF checked with the owner's existing passkey on every device (already an open item in `docs/build-plan.md`). The address is settled (question 9).
2. **A release that knows "sealed"**: old code paths (routes, alarms, webhooks) refuse to touch a budget marked sealed. It ships well before the move, so that a later automatic code rollback (`deploy.yml` rolls back on a failed smoke test, and a rollback undoes code, not data) lands on code that obeys the mark.
3. **Shadow run** (phase 4) has matched on the owner's budget for two weeks.
4. **Cutover, one transaction on the server:** jobs are deleted; the `change_log` head equals what the device holds; the device's first signed snapshot is stored; the budget is marked sealed. If the head has moved (a job or another device wrote meanwhile), the cutover is refused and tried again. The device's download for this includes the columns `/api/sync` leaves out today and the bank log, and is checked against the server's dump hashes with those columns included.
5. **Tokens:** the device collects the 7 access tokens in the same cutover. Each must then complete a relayed fetch from the device, and be inside a backup the owner holds, before step 7.
6. **Emptying the old tables.** `bank_event`, `bank_page` and `raw_page` refuse deletes by trigger, and deletes on synced tables write `change_log` rows; done at once, seven banks' rows could pass the free plan's daily row limit and rest the app. So: one migration drops those triggers, and a stepped job under the breaker empties the tables over days. Measure the row count first.
7. **30 days after step 6 ends:** point-in-time recovery holds no plain text. Only now: the stored tokens and `TOKEN_KEYS` are removed by the owner, and, with the owner's yes, each of the 7 tokens is replaced (5.5) so that no token the server ever stored still works. Until this step, a restore to before step 4 is the way back, and it needs `TOKEN_KEYS`.

The first claim in 1.1 starts after step 7.

**With shape B (5.5), the recommended one for Plaid, this is simpler and safer:** tokens never move, so step 5 and the token parts of step 7 drop out, `TOKEN_KEYS` stays, and the 7 Items are never at risk. The cutover adds the inbox key pair, and from then on the fetch step seals pages.

## 9. The free plan

- Server CPU per request falls: storing a sealed row, checking a signature and relaying a stream are small. Measure all three (`docs/measurements.md`).
- Durable Object rows fall: one row per edit or bank run, not one per changed row plus `change_log`.
- Worker requests rise a little: each Plaid page is a relayed request while the app is open, where today it is an alarm.
- Device work rises: a bank run, sealing, snapshots. Measure on the owner's iPhone in phase 0: opening a sealed snapshot of today's budget; a 100-row bank run; the size of the bank log; the cost of a save with the bank log kept beside the copy.
- Nothing in the design costs money to build or run.

## 10. Phases

Each phase ships alone and leaves the app working. A decision file records each (`docs/decisions/`).

| Phase | What                                                                                                                                                                                                                                                                  | Claims it unlocks                                                    | Risk to the owner's budget     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------ |
| 0     | The owner's answers (14). Measure and check: PRF on each device and passkey kind; signature and relay CPU; snapshot and bank-log size and time; hosted Link on Trial and on the iPhone; Cloudflare's log fields and what a wipe leaves in recovery; token replacement | None                                                                 | None                           |
| 1     | Hosted Link and the `'self'` CSP; name optional; logs; Settings → Privacy; a privacy policy; challenges off `TOKEN_KEYS`                                                                                                                                              | No trackers or outside scripts where keys are; no email              | Low                            |
| 2     | Keys: budget key, slots, recovery key, device-add, key versions, signing. Keys exist; nothing is sealed yet. The appendix of exact labels is written first                                                                                                            | None                                                                 | Low                            |
| 3     | Every edit runs in the engine and is proved to match the server; the bank log syncs to the device; the Worker gains the relay, still using the server's stored tokens                                                                                                 | None                                                                 | Low (the server still decides) |
| 4     | Shadow run: the device does bank runs, scans and maintenance beside the server's, with the canonical comparison, on the owner's budget, for two weeks. The "knows sealed" release                                                                                     | None                                                                 | None                           |
| 5     | Cutover: the sealed, signed log; server processing off; shape B: the fetch step seals pages (shape A: tokens move to the device) (section 8, steps 4–5)                                                                                                               | "We don't store the key to your bank link", once tokens are replaced | **High: forward-only**         |
| 6     | Empty the old tables; 30 days later remove `TOKEN_KEYS`, replace tokens (section 8, steps 6–7)                                                                                                                                                                        | "A key we never hold"; "no readable copy"; delete                    | Medium                         |
| 7     | A fresh public repository, reproducible build, attestation, About screen, review rule for the key code                                                                                                                                                                | Public, comparable code                                              | None                           |
| 8     | An outside review of the key design and code; fix what it finds; then publish the claims                                                                                                                                                                              | Section 1.1, in public                                               | None                           |

Phases 1 and 7 need no other phase. Sealing (5) and the token move must be one cutover: once the server holds only sealed data it can't process bank pages, and a server that still stored bank tokens could still pull history, so "a key we never hold" would mean little.

The owner lifted D-78's freeze for the work in this design (D-85). Open sign-up itself still needs a bank source other people can use (5.5).

## 11. Outside the code

- **A privacy policy and terms** written from sections 2 and 4: what is stored, what is sealed, who else handles data (Cloudflare, Plaid), how long, how to delete, the "no reset" rule, and that in-app notices are the only way we can reach a person.
- **A lawyer**, before sign-up opens. Questions to bring: whether US rules for companies that handle consumer financial data apply; state privacy laws; GDPR if anyone in Europe can sign up; breach notice duties with no email on file.
- **Plaid Production** has its own security and privacy review, requires a privacy policy and a consent screen, and charges per linked Item: find the price before choosing it (section 14, B).
- **An outside audit** of the key design and its code. Without one, half of section 1.1 is our word.
- **A security contact**: a `security.txt` and a short disclosure policy.
- **A page that says what we can hand over** if a court asks: section 4.3, and nothing else.

## 12. What this design doesn't do

- It doesn't hide bank data from Plaid, or from the Worker's memory during a relay.
- It doesn't stop changed code, in the app or the Worker, from reading a budget or a bank token (4.2).
- It doesn't stop the server from lying about bank data or the time (4.4), or from holding back changes (5.3).
- It doesn't hide IP addresses, times of use, counts, sizes or which banks from Cloudflare and the operator (4.3).
- It doesn't let two people share one budget. That needs each person's public key and a way to check it, which is its own design.
- It doesn't protect a budget on an unlocked or compromised device.
- It doesn't let anyone recover a budget whose keys are lost, and it has no restore (5.3).

## 13. Risks

| Risk                                                                                             | What limits it                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money is counted differently after the move                                                      | Shape B keeps arrival times as today; the mutation twin test (phase 3); the shadow run (phase 4); step sizes unchanged                                                                                                                                                                             |
| A bank link is lost during the move, with 3 lifetime links left                                  | Tokens are moved, never re-made; `TOKEN_KEYS` and stored tokens stay until each token has worked from the device and is in a backup (section 8)                                                                                                                                                    |
| A deploy rolls code back onto sealed data                                                        | The "knows sealed" release ships first (section 8, step 2); the smoke test changes with health                                                                                                                                                                                                     |
| A person loses the passkeys and the recovery key                                                 | iCloud passkeys sync; the key is proved at sign-up; a reminder until a backup or second passkey exists                                                                                                                                                                                             |
| A bug in sealing loses data                                                                      | The device holds a whole copy; the server deletes no entry a checked snapshot doesn't cover; full backup first                                                                                                                                                                                     |
| Two devices, lost answers                                                                        | Entry ids; one bank run as one write; tests with two engines                                                                                                                                                                                                                                       |
| The copy grows with the bank log and saves slowly                                                | Measured in phase 0; the bank log is kept beside the copy; question 5                                                                                                                                                                                                                              |
| An Item is left at Plaid when an account is abandoned                                            | Shape B: the server removes it when the account is deleted or expires (5.8)                                                                                                                                                                                                                        |
| The app's address changes later (the owner plans to, not soon). Passkeys are tied to the address | WebAuthn lets a new address use the old one's passkeys while the old address still answers ("related origins"; Safari 18 has it; to confirm in phase 0). The `workers.dev` address must then stay alive for good. Failing that, each person signs in once at the new address with the recovery key |
| A sealed format or key mistake found after launch                                                | Every sealed value carries a format and key version; an outside review before the claims are published                                                                                                                                                                                             |

## 14. The owner's answers (Nov 10, 2026) and what is still open

Recorded in `docs/decisions/D-85-privacy-design-answers.md`.

| #   | Question                           | Answer                                                                                                                      |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | What "arrived" means (D-67, D-68)  | **Open (A below).** The owner asked what the rules are and whether they can change                                          |
| 2   | No reset                           | Yes                                                                                                                         |
| 3   | D-78                               | Start now: the freeze is lifted for the work in this design. The owner also asked about bank sources other than Plaid (5.5) |
| 4   | Abandoned accounts with bank links | Find a way to remove them. That needs the server to hold the bank key: shape B (5.5)                                        |
| 5   | Raw Plaid pages                    | **Open (below).** The owner asked what they are                                                                             |
| 6   | Restore                            | No restore at all: not in the app, and the runbook goes (5.3)                                                               |
| 7   | Idle accounts                      | Yes, delete them (5.8: 24 months)                                                                                           |
| 8   | Costs outside $0                   | Not agreed; the owner asked why any would be needed. Nothing here is needed to build the design. The $0 rule stands         |
| 9   | The address                        | It will change, but not soon (section 13)                                                                                   |
| 10  | Owner's review for the key code    | Yes (5.10)                                                                                                                  |
| 11  | Public repository                  | It is already public (5.9)                                                                                                  |
| 12  | Replacing the 7 bank tokens        | Tabled until the bank source is settled                                                                                     |
| 13  | Order of phases                    | No preference                                                                                                               |

**Still open:**

- **A. Background fetch (shape B).** With Plaid, shape B is the only way to both remove abandoned accounts' banks (answer 4) and leave D-67 and D-68 as they are. Confirm it, and question 1 goes away. The cost is the weaker bank claim in 5.5.
- **B. The bank source.** Stay with Plaid for other people (which needs Plaid Production, and that costs money), or try SimpleFIN Bridge, where each person pays about $15 a year themselves (5.5)?
- **C. The public repository** holds your own purchases and bank names in its docs and history. Leave them, or take them out?
- **Raw Plaid pages** are the exact answers Plaid sent, kept word for word and never deleted, beside the cleaned-up bank log made from them. They exist so a bug in reading Plaid's data could be traced or redone. With shape B the server stops keeping them (it keeps sealed pages only until a device files them). Recommended: the device keeps the bank log and not the raw pages.

## 15. Review

v1 was reviewed on Nov 10, 2026 by two independent reviewers who were told to break it: one on the key design and the claims, one on the fit with the code. Neither could check Plaid's or Cloudflare's behaviour online; what rests on that is listed last.

| #   | Finding (v1)                                                                                                                                                                                        | Severity | Fixed in                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------- |
| 1   | "We can't read it, nor anyone who breaks in" is false: changed code can                                                                                                                             | Critical | 1.1, 1.2, 3                        |
| 2   | "We hold no access to your bank": the Worker sees the token on every call, and tokens don't expire                                                                                                  | Critical | 1.1, 1.2, 5.5 (replacing tokens)   |
| 3   | Arrival time decides money (D-67, D-68); fetching on open changes it                                                                                                                                | Critical | 0, 5.4, question 1                 |
| 4   | Sealed token plus "remove after 24 hours" can't both hold, and removal burns a lifetime link                                                                                                        | Critical | 5.5 Linking                        |
| 5   | `TOKEN_KEYS` also signs sign-in challenges; deleting it early also breaks the way back                                                                                                              | Critical | 6.1, 8 steps 1 and 7               |
| 6   | Two devices processing the same pages write the same rows twice; the lease isn't shared                                                                                                             | Critical | 5.4 "one unit"                     |
| 7   | A write whose answer is lost is redone on itself; `assign` adds twice                                                                                                                               | Critical | 5.3 entry ids                      |
| 8   | Phase order: sealing before the token move leaves nobody able to sync banks                                                                                                                         | Critical | 10                                 |
| 9   | The server can hold back entries or fork the log; one device can't see it                                                                                                                           | Critical | 5.3 "a lying server"               |
| 10  | The server can make a device forget its position (epoch, refused edit) and then roll it back                                                                                                        | Critical | 5.3 Rollback                       |
| 11  | "Proof a stranger can check" for what the Worker does: nobody can inspect a Worker                                                                                                                  | Critical | 1.1 "our word", 5.9                |
| 12  | Turnstile needs an outside script and frame                                                                                                                                                         | Major    | 1.1, 5.6                           |
| 13  | No key change on passkey removal, sign-out or a new recovery key                                                                                                                                    | Major    | 5.2 "Changing the key"             |
| 14  | "Keys destroyed at once"; "can't be opened" on delete                                                                                                                                               | Major    | 1.1, 1.2, 5.8                      |
| 15  | A session with no key can write junk                                                                                                                                                                | Major    | 5.2 Signing                        |
| 16  | Snapshots: no manifest, no link from an old position, no check before old entries go                                                                                                                | Major    | 5.3 Snapshots                      |
| 17  | Device-add secret in a link is a bearer key                                                                                                                                                         | Major    | 5.2 "Adding a device"              |
| 18  | The server can forge bank data and the time                                                                                                                                                         | Major    | 4.4, 12                            |
| 19  | A server could trick a client into plain text or a fresh key                                                                                                                                        | Major    | 5.2 Budget key, 8 step 2           |
| 20  | The 7 old tokens were readable by the server for months                                                                                                                                             | Major    | 8 step 7, question 12              |
| 21  | Metadata understated: bank identity, webhook codes, maker ids, sizes, counts                                                                                                                        | Major    | 4.3                                |
| 22  | "No copy of bank data"; "end-to-end with no exception"                                                                                                                                              | Major    | 1.1, 1.2                           |
| 23  | Sealing to a public key isn't in WebCrypto; an unsigned public key in the Directory can be swapped                                                                                                  | Major    | 5.2 (HPKE; the inbox key is gone)  |
| 24  | Abandoned Items may cost money on Plaid Production                                                                                                                                                  | Major    | 11, question 4                     |
| 25  | Rows can't be compared one for one (ids, times, step size)                                                                                                                                          | Major    | 5.4 "Proving"                      |
| 26  | "No logic change" is wrong: the engine runs six edits today; handlers mix Plaid and budget writes                                                                                                   | Major    | 0, 5.4, 6.1                        |
| 27  | Undo by savepoint doesn't fit the engine; the copy has no change triggers                                                                                                                           | Major    | 5.3 "Redoing"                      |
| 28  | Server work and tables the design forgot (audit log, session, health and the smoke test, name checks, repair flag)                                                                                  | Major    | 6.2                                |
| 29  | Data migrations and matching code differ per device version                                                                                                                                         | Major    | 5.3 "Processing version"           |
| 30  | A deploy rollback puts old code on sealed data; no freeze at cutover                                                                                                                                | Major    | 8 steps 2 and 4                    |
| 31  | The old tables refuse deletes; emptying them can pass the daily row limit                                                                                                                           | Major    | 8 step 6                           |
| 32  | The relay is an open door to Plaid for any signed-in user                                                                                                                                           | Major    | 5.5 "Only your own Items"          |
| 33  | Per-passkey PRF salt can't work with discoverable passkeys                                                                                                                                          | Major    | 5.2 Key slots                      |
| 34  | Conflicts with D-78, D-77 and "recovery not for admins" weren't raised                                                                                                                              | Major    | Questions 2, 3, 6                  |
| 35  | The copy is saved whole each time; the bank log makes that heavy                                                                                                                                    | Major    | 5.4, 9                             |
| 36  | Delete order can't stay as in `open-signup.md` 12                                                                                                                                                   | Major    | 5.8                                |
| 37  | CODEOWNERS is `*`; branch protection isn't free on a private repository; the history holds owner data                                                                                               | Major    | 5.9, 5.10                          |
| 38  | Facts about today: 180 days, not 24 months; sign-up asks a name; the email value is already random; `fetchSyncPage` buffers; invocation logs are on                                                 | Minor    | 2, 3, 5.5, 5.6                     |
| 39  | Missing: an incident channel with no email; GCM limits; backup password stretching; the address and passkeys; catch-up after months away; the 15-minute rule for a device backup; the lawyer's cost | Minor    | 5.2, 5.8, 7, 13, questions 8 and 9 |

**Still unverified, to settle in phase 0:** PRF behaviour with the owner's existing passkey, with other passkey apps and with security keys in Safari; hosted Link on Plaid Trial and its return path on an iPhone; that replacing an access token uses no link; whether an Item can be removed without its token; what Plaid Production charges for an unused Item; what Cloudflare's invocation logs hold; whether a wiped store stays in point-in-time recovery; Ed25519 checking and relay streaming inside 10 ms.

**Open after this review:** code sent to one person once can't be detected by any web-only means (4.2). The design says so and offers no fix inside the $0 rule.
