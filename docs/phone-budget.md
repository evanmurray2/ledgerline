# Working out the budget on the phone

Status: built, v1.4, Nov 3, 2026 (decisions.md D-45, D-46). The owner asked for everything at once, including stage 5; section 16 says what was built and how it differs from this design. v1 got an adversarial review (1 blocker, 8 major, 9 minor); v1.1 includes its fixes, listed in section 15. v1.2 added the security design in section 13; v1.3 includes the fixes from its security review (1 blocker, 7 major, 7 minor). Nothing here changes how money is counted: the same `computeBudget()` runs, in a different place, and section 9 shows how its inputs stay the same.

## 1. The question

Today the server works out every screen. Each Budget, Activity, Accounts or Reports request reads rows in the budget's Durable Object, runs the domain functions and returns a finished view. To keep each request and job step under the owner's 10 ms CPU rule, the server keeps cached month totals and rebuilds them two months at a time in background jobs.

The proposal, in two parts that can be decided separately:

- **Part A: the phone keeps a copy of your transactions** and builds Activity, registers and search from it. The server still works out the budget.
- **Part B: the phone also works out the budget** with the same functions from `packages/domain`. The server keeps everything that has to be shared or trusted: sign-in, bank sync, matching and rules at import, and saving your edits.

## 2. How it works today, in numbers

| Fact                                                  | Value                                                                                                                                                    | Source                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Read endpoints that build screens                     | about 20 (`GET /api/budget/:month`, `/activity`, `/accounts`, `/reports`, sheets, settings views)                                                        | `docs/api.md`                                 |
| Server code that builds views or keeps derived totals | `views/*.ts` (971 lines), most of `routes/activity.ts` (1,121), `budget/recompute.ts` (299), `ledger/totals.ts`, ETags, the recompute job                | `apps/worker/src`                             |
| Derived tables                                        | `budget_line` and `month_snapshot`, kept on every write; `account_month_total` and `month_total_done`, filled when read and cleared on writes            | migration 0001, `ledger/totals.ts`            |
| Full recompute, 36 months, 60 categories              | 22.7 ms in workerd, half of it parsing 1 MB of rows                                                                                                      | `docs/measurements.md`                        |
| An edit 36 months back                                | 18 invocations (1 request + 17 job steps), about 50 rows written, about 8,000 rows read                                                                  | `docs/measurements.md`, D-22, D-38            |
| Activity on Cloudflare                                | p95 10.8 ms, the only path that fails the gate                                                                                                           | `docs/measurements.md`, phase 0               |
| Free daily limits hit in production                   | reads (D1, Nov 1); Durable Object rows written (Nov 3, the day after the move to Durable Objects and the phase 0 runs, not caused by the derived tables) | build plan; commit e10c310; `measurements.md` |
| Offline                                               | view-only: saved screens in `localStorage` (about 5 MB, largest dropped first), ignored after 24 hours                                                   | D-42, `state/saved.ts`                        |
| A second engine                                       | `apps/web/src/mock/db.ts`, 1,803 lines, "a plausible stand-in for the Worker, not the real budget engine"                                                | mock tests run against it                     |

The size of the data: 3,296 bank rows over three years in the measurement set, 5,402 budget lines and 2,124 assignments over 36 months. All of it is a few MB.

## 3. Goals and non-goals

Goals:

1. Every screen opens from data already on the phone, with no wait.
2. Activity stops failing the 10 ms gate (part A).
3. Budget math no longer has to fit 10 ms of server CPU, so the cached month totals, the recompute job and the "Updating" state can go (part B).
4. One budget engine, used by the app, the tests and the mock (part B).
5. Optionally, editing works offline and is sent when there's signal.

Non-goals: changing any Money rule; sharing a budget between people; a native app; peer-to-peer sync between devices; end-to-end encryption (the server still reads your data to run rules and matching). Fewer database writes is **not** a goal: section 11 shows the change is roughly even on writes and only clearly better on reads.

What does not change:

- **Money rules and `computeBudget()`.** The function moves, unchanged. `docs/sync-spec.md` Money rules stay the contract and their property tests stay.
- **Bank data is never edited.** `bank_event`, `bank_page` and `raw_page` stay append-only on the server.
- **Sync guarantees 1 and 2** (the cursor never goes backwards; retries add nothing). Guarantee 3 changes wording in part B (section 9).
- **Matching, rules, transfer detection and payee cleanup run on the server at import**, as now. They never read Ready to Assign or month totals (`sync/process.ts`), so they move nowhere. Changing a rule later never rewrites past months.
- **The server is the master copy.** The phone's copy can always be thrown away and downloaded again.

## 4. Options considered

| Option                                                 | What it is                                                                                                              | Verdict                                                                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A0. Keep it, tune it                                   | A stored Activity list, smaller steps, more caching                                                                     | Fixes Activity's 10 ms with yet another derived table; nothing else improves                                                                |
| B0. Server works out everything per request, no caches | Drop the 10 ms rule for budget math (Durable Objects on Free didn't stop a 49 ms request in phase 0)                    | Simplest code. Breaks the owner's hard rule and relies on behaviour Cloudflare doesn't promise                                              |
| **A. Transactions on the phone (part A)**              | The phone syncs transactions and settings; Activity, registers and search read them; Budget still comes from the server | Fixes the failing gate, instant Activity and search, offline viewing. No change to where money is worked out. Keeps every server-side cache |
| **B. Budget on the phone too (part B)**                | A, then the phone runs `project()` and `computeBudget()`                                                                | Removes the derived tables, the recompute job and the second engine. Needs the care in sections 9–10                                        |
| D. Full local-first: the phone owns the data           | Edits are operations merged on each device; the server is a relay                                                       | Needs merge rules for every kind of edit and moves matching and rules to the phone; too much risk for a money app with one user             |

Recommendation: build A. Decide on B after A has run for two weeks, with B's shadow stage (section 12) as the evidence. A is worth having even if B never happens.

## 5. Pros and cons

**For:**

|                                     | Why it matters                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instant screens (A)                 | Activity and registers read memory. Search over downloaded rows is as-you-type.                                                                       |
| Activity passes the gate (A)        | The server stops building Activity lists; sync pages are sized to fit.                                                                                |
| Fewer reads (A, B)                  | Opening the app is "anything new since N?": a couple of indexed reads when nothing changed, instead of one request per screen.                        |
| Offline viewing beyond 24 hours (A) | Everything downloaded opens with no signal, for up to 7 days without a confirmed session (section 13).                                                |
| No 10 ms ceiling on budget math (B) | The phone has far more than 10 ms. A full recompute is tens of ms on an iPhone (stage 0 measures it).                                                 |
| Less server code (B)                | Recompute, chunking, month snapshots, ETags and the mock's second engine go. The view logic moves to the phone rather than disappearing (section 10). |
| Changing a Money rule is easier (B) | Nothing derived is stored, so a fix to `computeBudget()` takes effect when each device reloads. Today every stored month has to be redone.            |
| One engine (B)                      | The mock and e2e tests run the real engine on a sample budget.                                                                                        |

**Against:**

|                                                | How bad, and what limits it                                                                                                                                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| More of your history is stored on the phone    | Today at most 24 hours of saved screens, unencrypted. With this, encrypted with your passkey and a per-device server share. Someone with your passkey who keeps the phone offline keeps the last snapshot (section 13.6).                 |
| Face ID more often                             | The copy locks after 10 idle minutes or in the background, and locking ends the server session; today a session lasts 24 hours without a prompt.                                                                                          |
| Phone and server can disagree for a moment     | The phone shows what it last synced; today's screens are also as old as the last load. It shows "Updated 2 min ago" when it's been a while.                                                                                               |
| Two devices can show different numbers briefly | Each catches up on its next sync, and after a release, when it reloads. The shadow stage flags it.                                                                                                                                        |
| The phone's clock and time zone (B)            | "Today" and the current month use the budget's time zone and the server's clock (section 9), never the phone's, so travel can't move money between months.                                                                                |
| A slow phone (B)                               | Compute in a Web Worker so scrolling never stutters; keep month snapshots in memory and recompute from the edited month, as the server does now.                                                                                          |
| iOS can clear website storage                  | Home Screen apps aren't subject to Safari's 7-day rule, but iOS can still clear storage when the phone is low on space. The app asks for persistent storage (`navigator.storage.persist()`); if cleared anyway, the cost is one download. |
| A big change in a working app                  | Two parts, six stages, each reversible until the last (section 12).                                                                                                                                                                       |
| More writes, not fewer                         | Every change to a transaction also writes its `change_log` row (section 11). Kept low by leaving history out of the log; measured in stage 0.                                                                                             |
| Server paths that need budget numbers (B)      | Archiving a category, removing one in use, mutation answers and projected fronts read server numbers today. Section 10 changes each.                                                                                                      |

## 6. Shape

```
Phone (installed web app)                  Worker + BudgetStore (Durable Object)
┌──────────────────────────────┐           ┌────────────────────────────────────┐
│ IndexedDB, one per user and  │  GET      │ Sign-in (Directory)                │
│   budget: rows by entity,    │ /api/sync │ Plaid sync → bank log (append-only)│
│   epoch, last number N       │ ?since=N ─▶ matching, rules, transfers         │
│ Activity, registers, search  │ ◀─ rows   │ overlay, assignments, targets …    │
│ (B) Web Worker: toLogical →  │           │ change_log, written by triggers    │
│   project → computeBudget    │  POST     │ validates and saves edits          │
│ (opt.) outbox for edits      │ edits ───▶│ answer includes the rows it changed│
└──────────────────────────────┘           └────────────────────────────────────┘
```

## 7. What the phone holds

Transactions are sent **without the fields copied from other tables** (`payee` name, `account_name`, `account_kind`, `budget_from`). The phone joins them to the `payee` and `account` rows with a small pure function in `packages/domain`, so renaming a payee or an account changes one row, not every transaction. Everything else about a transaction comes from the server's own views (`v_txn_bank`, `v_txn_manual`), so there is one definition of how a bank row and your edits combine.

| Entity                                      | Comes from                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `txn`                                       | `v_txn_bank` / `v_txn_manual` without the copied fields, plus `manual_pending.stale_snooze_until`               |
| `split`, `owed`, `link`                     | `txn_split`, `expected_reimbursement`, `txn_link`                                                               |
| `account`                                   | `account` + latest balances and card statement                                                                  |
| `connection`                                | status, `last_attempt_at`, last sync, needs sign-in (for the repair and failure cards)                          |
| `category`, `group`, `assignment`, `target` | as stored; target versions included                                                                             |
| `payee`, `rule`                             | as stored                                                                                                       |
| `alert`                                     | `alert` (history changed, possible re-issue, identity, …)                                                       |
| `health`                                    | `health_status` (the monitor notice on Accounts)                                                                |
| `setting`, `budget`                         | time zone, budget start, and `upcomingThrough` (section 9)                                                      |
| `month_total` (A only)                      | `account_month_total` for the last 13 months, for the net worth chart while Reports still comes from the server |

**Which transactions.** The first download is every row `project()` doesn't treat as history: `RECENT_TX` (`ledger/ledger.ts`) plus any row with `pending_at_link = 1` whatever its date. That is defined in SQL once and shared by the sync endpoint and the existing queries. Older rows come from `GET /api/sync/history?account=&before=` when you scroll past them, and are kept. History rows are not in `change_log`: a history page carries the epoch and the time it was read, and the phone fetches it again when the server's `historyVersion` for that account changes (bumped by anything that edits a history row, which is rare).

**What's only as complete as the download.** Search and "You've used for…" (payee history) cover the rows on the phone. When they find nothing locally, Activity offers "Search older", which uses today's server search.

## 8. The sync protocol

**Numbers that never go backwards.** `change_log (entity TEXT, id TEXT, seq INTEGER NOT NULL, deleted INTEGER NOT NULL, PRIMARY KEY (entity, id))` with an index on `seq`. `seq` comes from a one-row counter (the same pattern as `apply_counter`), never from `rowid`, so numbers are never reused, even after pruning.

**Written by triggers, not by each route.** SQLite triggers on the base tables (`bank_txn`, `txn_overlay`, `manual_pending`, `txn_split`, `txn_link`, `expected_reimbursement`, `account`, `connection`, `category`, `category_group`, `assignment`, `target`, `payee`, `rule`, `alert`, `health_status`, `setting`, `budget`) upsert the `change_log` row for the entity they change. The schema already uses triggers. That covers every writer, including the daily scan, processing and imports. Durable Object writes are serialized and each batch is one transaction, so `seq` order matches commit order.

**Rows that leave without a delete.** Some changes take a row out of `v_txn_*` without deleting anything: a manual row matched to a bank row (`matched_txn_key`), a bank row removed (`removed_at`), and a posted row moving from its `p:` key to an inherited key. The triggers on those columns log the old key as deleted. While a posted row has inherited a key and its pending row isn't removed yet, the entity id is the provider transaction id, not the key, so two live rows never share an id.

**The epoch.** The budget row holds a random `sync_epoch`. Any point-in-time recovery, `restoreDump` or pruning of deleted rows sets a new one (the restore runbook gets a step for recovery, and is updated from its D1 wording). Every sync answer carries the epoch. When it differs from the phone's, the phone throws its copy away and downloads again. Without this, a recovered store would rewind its numbers and the phone would keep rows the server no longer has, with nothing to notice.

**`GET /api/sync?since=N&epoch=E`** returns `{ format, epoch, serverTime, through, more, rows: [{ entity, id, data | null }] }`: the current row for each entity with `seq > N`, in `seq` order. `data: null` means deleted. Pages are sized by measured CPU (stage 0), likely 100–150 transaction rows. With nothing new, it reads one index row. **The phone applies pages as they come but recomputes and shows numbers only when `more` is false**, so one write's changes are never shown half-applied.

**When the phone syncs:** on open, when the app comes back to the screen, on pull-to-refresh, and every 2 minutes while open. The answer to every edit includes the rows that edit changed.

## 9. Part B: computing on the phone

**The same inputs as the server.** The phone runs `toLogical()` (moved from `ledger/ledger.ts` into `packages/domain`) → `project()` → `computeBudget()` → `categoryStatus()`, `neededThisMonth()`, `cardStatus()`, `projectedFronts()` → the view shapes in `packages/contracts/src/screens.ts`. The screens keep their props.

**When things count.** Two inputs depend on time, and both come from the server so the phone counts money at exactly the moments the server does:

- **Today and the current month:** the budget's time zone applied to `serverTime` plus the phone's measured offset from it. The phone's own time zone is never used.
- **Upcoming rows:** the server counts a scheduled row from the day the daily scan picks it up, not from local midnight (`project()` uses the `today` the lines were built with; the scan runs at 08:10 UTC). The server sends `upcomingThrough`, the date its lines were last built with, and the phone passes that to `project()` instead of its own date. If the owner wants upcoming rows to count from local midnight instead, that changes when money counts, and is a separate decision.

**Guarantee 3 in part B:** "Every number on screen is a from-scratch compute of the data the phone holds, and the phone's data equals the server's as of `through` and `epoch`."

**The identity check (rule 10)** runs on the phone after every compute. A failure posts to a new route that writes the existing `identity` alert (`budget-jobs.ts`), which shows in Needs attention on every device. This replaces sync-spec's "rule 10 runs as an assertion in the daily recompute" and needs a decision entry.

## 10. Server paths that need budget numbers (part B)

| Path                                                                     | Today                                                                | In part B                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archive a category, or remove one in use: its available goes back to RTA | reads `month_snapshot` via `monthResult()` (`categories.ts:200-215`) | The phone sends the amount it computed and the `through` it computed at; the server refuses with "changed, try again" if any `change_log` row is newer than `through`. The server can't work out one category alone: card refunds pay other categories' unfunded purchases (D-12, `compute.ts:280-297`). Trusting the phone here adds nothing an attacker couldn't already do, since anything that can send this request can also call assign and move. Money moves exactly as now. |
| "Is this category in use?"                                               | counts `budget_line` rows (`categories.ts:245`)                      | counts overlays and splits pointing at it                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Every mutation answer                                                    | `MutationResult.rta`, `rtaUpdating`                                  | both become optional in one contract change old and new clients accept; the phone computes RTA                                                                                                                                                                                                                                                                                                                                                                                      |
| Owed: projected fronts                                                   | uses the server's RTA (`activity.ts:1066`)                           | the phone runs `projectedFronts()`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/api/badges`, Needs attention, Assign suggestions, Reports              | server views                                                         | phone                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**The server keeps computing until the last stage.** `planLineRebuild`, the recompute job and month totals keep running through stages 1–4, so every stage can be turned back with a setting and the shadow comparison has something to compare with. They're removed only in stage 5.

**What goes in stage 5:** `month_snapshot`, `budget_line`, `account_month_total`, `month_total_done`, the dirty-month and version-fence columns, `budget/recompute.ts` and its job, the server views and read routes (except search and history paging), ETags and `data_version`, `/api/badges`, `state/saved.ts`, and `mock/db.ts` + `server.ts` (the mock becomes a sample sync dataset fed to the real engine). Migrations follow the expand-only rule: stop reading, then drop in a later release. `store/dump.ts` keeps restoring old backups that include the dropped tables, by skipping them.

**What moves rather than goes:** the view logic in `views/budget.ts` (`categoryRows`, the attention list, cards) and in `accounts.ts` (registers, Reports) is ported to the phone. Honest size: about 2,000–2,500 lines added (sync endpoint, triggers, IndexedDB store, Web Worker, ported views), about 4,000 removed.

## 11. Cost on the free plan

Estimates; stage 0 measures each.

|                                            | Today                                                                     | Proposal                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Opening the app, nothing changed           | session check + one request per screen opened, each a few rows with ETags | session check + one sync request, about 2 rows                                                                                                  |
| Categorize one recent transaction          | overlay, its lines, recompute (1 invocation; up to 18 for an old month)   | A: same + 1–2 `change_log` rows. B (after stage 5): overlay + 1–2 `change_log` rows                                                             |
| Adding a bank (3,000 rows, mostly history) | about 20,000 rows written                                                 | about the same: history rows stay out of `change_log`; the 300–600 budget-period rows add 2–3 writes each, offset in B by no `budget_line` rows |
| Payee merge touching 200 transactions      | 200 overlay updates                                                       | the same 200 + 200 `change_log` rows (the overlays' `payee_id` changes)                                                                         |
| A new phone, or a new epoch                | n/a                                                                       | about 5,000–15,000 rows read once, 40–100 requests                                                                                              |

## 12. Stages

Each stage ships on its own and, until stage 5, can be turned back with a setting.

0. **Measure (1 day).** Ship `/api/sync` in production behind a setting that only the owner's session uses (dev routes are never served in production and there is no staging). Gates:
   - server CPU per sync page on Cloudflare, p95 under 8 ms;
   - first download on mobile data under 10 seconds;
   - cold open (read IndexedDB, build the copy) to the first Budget screen under 1 second;
   - (for B) full compute of the 36-month set on the iPhone under 150 ms, also with Lockdown Mode if the owner uses it;
   - rows written for a 3,000-row backfill and a 200-row payee merge;
   - the PRF checks in section 13.7, and decrypting the full copy takes under 100 ms.
1. **Part A (4–5 days).** Activity, registers and search read the phone's copy. Budget, Accounts and Reports still come from the server.
2. **Decide on B.** After two weeks of stage 1.
3. **Shadow (2–3 days).** The phone computes in the background. Each Budget load compares the phone's Ready to Assign and every category's available with the server's, **only when the server isn't mid-recompute and both are at the same `through`**, and posts any difference.
4. **Switch to phone numbers (4–5 days).** Budget, Accounts, Reports and the sheets use the phone's compute; section 10's server paths change. The shadow comparison keeps running.
5. **Delete (2–3 days).** After two clean weeks of stage 4. Not reversible without rebuilding the derived tables, so it waits for the owner's go-ahead.

**Optional, after stage 1 or 4: offline edits.** A short list: category, memo, budget month, set an assigned amount, target, mark reviewed. Each edit gets an id made on the phone and the time it was made (the phone's clock corrected by its measured offset from the server), so most-recent-wins in `field_edits` uses when you made the edit, not when it arrived. The server keeps edit ids for 30 days and ignores repeats. It also keeps a map from old transaction keys to new ones, so an edit made offline to a row the server has since re-keyed lands on the right row. Assigning is sent as "set to X if it was Y". The phone applies edits to its copy with reducers in `packages/domain`. A property test runs each reducer and the real route on the same data and checks they agree; this matters because the routes have side effects (categorizing removes splits and turns waiting money into income). Outbox entries carry the app version, so a release can migrate or refuse old ones. Safari has no background sync, so the outbox sends only while the app is open. Edits that need the server's judgement (matching a payback, splitting, rules, linking banks) stay online-only.

## 13. Data on the phone

**The aim:** a copy on the phone is no easier to read than the server, as far as a web app allows. The copy is encrypted with a key from your passkey, combined with a share the server holds for each device, so reading it needs your passkey and, whenever the phone is online, the server's agreement. Section 13.6 lists what this can't do.

### 13.1 Threats

| Threat                                             | Server only, today                          | This design                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone stolen while locked                          | Needs your passkey (Face ID or passcode)    | Unreadable without your passkey                                                                                                                                  |
| Phone taken while unlocked, app open               | The session cookie works for up to 24 hours | The app locks after 10 idle minutes or when it goes to the background, and ends the server session at the same time                                              |
| Thief who watched you type the passcode            | Can use your passkeys, so gets the server   | Same. Stolen Device Protection helps only away from familiar places                                                                                              |
| Thief with the passkey who keeps the phone offline | Gets nothing new from the server            | **Keeps the last snapshot.** Revoking the device stops it from getting the server's share again, but can't reach a phone that never connects (13.6)              |
| Malicious script in the web app                    | Can call the API while you're signed in     | Can read everything while you're signed in or unlocked, and can keep a usable key for later. Locking doesn't help against a script that's already running (13.5) |
| Phone backups (iCloud)                             | Nothing on the phone                        | Only ciphertext; anyone with your iCloud-synced passkey can already sign in                                                                                      |
| App switcher snapshot                              | The last screen                             | The app covers its content when it goes to the background                                                                                                        |
| Someone else using the same phone                  | Separate sign-in                            | Separate database, and their passkey can't unlock yours                                                                                                          |
| Browser extensions (a laptop copy)                 | Same access as a malicious script           | Same; no laptop copy until that's accepted (section 14)                                                                                                          |
| Jailbroken device                                  | Keychain and memory readable                | Same                                                                                                                                                             |

### 13.2 Keys

- **PRF:** each unlock runs a WebAuthn ceremony asking for the PRF extension with `userVerification: 'required'`, a per-device random salt, `allowCredentials` set to the credential that wrapped the key, and `evalByCredential`. The app checks the user-verified flag. Sign-in and unlock are one ceremony when online.
- **Server share:** each device holding a copy has a row in a new `device` table (id, user, created, last seen, revoked) and a random 32-byte share the server keeps. After a successful sign-in the server returns the share only for a device that isn't revoked.
- **Key-encryption key:** HKDF-SHA-256 over PRF output ‖ server share, with `info` = `ledgerline-copy-v1‖userId‖budgetId‖deviceId`. It is a non-extractable `CryptoKey` held in memory only.
- **Data key:** random 256-bit, wrapped with AES-GCM under the key-encryption key with associated data `credentialId‖salt‖deviceId`, and unwrapped as non-extractable. One wrapped copy is kept per passkey: signing in with a second passkey while unlocked adds a wrapped copy for it. A different passkey at a locked unlock is refused with "use the passkey you set this phone up with", never a wipe.
- **Offline unlock:** the server share is cached on the device, wrapped under a PRF-only key, with the last `serverTime`. Offline unlock is allowed for 7 days from that time and refused if the phone's clock is earlier than it. A tampered app can ignore this limit (13.6).
- **The PRF output never leaves the phone:** `clientExtensionResults.prf` is removed before the sign-in answer is posted to `/api/auth/login/verify`.

### 13.3 Rows

- Every value is encrypted with AES-GCM under the data key with a fresh random 96-bit IV from `getRandomValues` (never a counter), and associated data `deviceId‖entity‖id‖seq‖format`, so rows can't be swapped between ids or entities.
- An encrypted manifest holds the epoch, `through`, and a hash over every `(entity, id, seq)`. It's checked on load; if it doesn't match, the copy is dropped and downloaded again. This stops an old row being replayed under a newer sync position.
- Decrypted rows live in the Web Worker's memory. That makes scrolling smoother; it isn't a security boundary, since the page asks the Worker for rows.

### 13.4 Lock and wipe

- **Lock:** after 10 idle minutes, or 10 minutes after the app goes to the background, the keys, the decrypted copy, React Query's cache and the screens are dropped, and the server session is ended. iOS suspends timers in a backgrounded app, so the app records the time on `visibilitychange: hidden`, covers its content at once, and on return checks the elapsed time before drawing anything. While locked it doesn't sync. Unlocking online is a fresh sign-in.
- **Separate answers from the server:** `session_expired` asks for your passkey and keeps everything. `revoked` (the device row is revoked) and `not_member` wipe. Today a single `unauthenticated` answer covers all three (`api.ts`) and the app clears its data on it; plain 401s never wipe in this design.
- **Wipe:** the database, wrapped keys, cached share, salt, the old saved-screens store (`ledgerline-saved-data`) and the query cache. The Worker closes its database connection on `versionchange` so `deleteDatabase` isn't blocked, and the app confirms the delete finished. Before a wipe the outbox is sent if the phone is online; edits that can't be sent are lost and the app says so.
- **Triggers:** sign-out; `revoked` or `not_member`; the 7-day offline limit.
- **Revoking a device:** (since D-52, there's no separate device list: Settings → Sign-in lists locked phones with a copy among the sign-ins, and signing one out turns its copy off; the phone checks `copy-status` when it opens and when its sign-in ends.) Settings → Security lists devices from the `device` table, each with Revoke. Revoking marks the row and deletes its share and sessions. "Sign out other devices" also revokes every other device. This replaces today's button, which only deletes sessions and is hidden unless another unexpired session exists (`security.ts:16`); a phone that has been offline a day can then be revoked too.
- **Copy only in the Home Screen app:** Safari in a browser tab keeps data in memory only, so there's never a forgotten Safari copy.
- **Saved screens:** the plaintext `localStorage` persister (`state/saved.ts`) is turned off in stage 1; it is not kept until stage 5.

### 13.5 Scripts in the page

- The Content Security Policy makes injecting a script harder. It does **not** stop a running script from sending data out: page navigation and `window.open` aren't covered by CSP, and WebRTC may not be in Safari.
- Narrow `connect-src` from `https://*.plaid.com` to the exact hosts Plaid Link needs from the top page (or `'self'` if Link's iframe does the talking), and add `worker-src 'self'` (today it falls back to `script-src`, which allows `cdn.plaid.com`). The CSP test covers `connect-src`, `script-src`, `worker-src`, `frame-src`, `form-action`, `img-src` and `style-src`, and fails if any loosens.
- Plaid Link's script stays in the page after linking, so the app reloads after Link closes.
- The real defence is keeping foreign scripts out: no inline scripts, pinned dependencies, the existing supply-chain checks.

### 13.6 What this can't do

- Someone who has your passkey and keeps the phone offline can read the snapshot already on it, for as long as they like, by ignoring the app's own limits. Revocation works only on a device that connects again. This is the main difference from keeping everything on the server.
- A script running while you're signed in or unlocked reads what you can read, and can keep a usable key for later runs.
- The iOS keyboard may learn payee names typed in search, as with any text field.

**On your phone:** turn on Stolen Device Protection (Settings → Face ID & Passcode).

### 13.7 Before stage 1 ships

- Stage 0 tests on your iPhone: PRF in the Home Screen app; PRF with your existing passkey (it may have been created before iOS 18); offline unlock; and the iOS version floor. If PRF doesn't work in the Home Screen app, part A waits.
- `docs/threat-model.md` takes the table in 13.1, and a decision record notes the change.

## 14. Owner's answers (Nov 3, 2026)

1. Build part A and part B: yes. Stages 0–4 are built behind settings; stage 5 (deleting the derived tables) waits for two clean weeks of the shadow comparison.
2. Lock after **10** idle minutes (or 10 minutes in the background). Accepted: someone with your passkey who keeps the phone offline keeps the last snapshot (section 13.6).
3. Offline edits: included, for the short list in section 12.
4. A copy is kept only in the Home Screen app on the iPhone; browsers keep data in memory only (13.4).

## 15. Review history

v1 got an adversarial review the same day. Every finding was checked against the code; all are fixed here.

| #     | Finding                                                                                                                                                    | Severity | Resolution                                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| B1    | Point-in-time recovery rewinds `change_log`; `seq` from `rowid` is reused after pruning; the phone would keep wrong rows silently                          | Blocker  | Epoch on the budget row, changed by any recovery or restore; `seq` from a counter row; restore runbook step (section 8)                         |
| M1    | Archiving and removing categories, mutation answers and projected fronts read server numbers                                                               | Major    | Section 10                                                                                                                                      |
| M2    | Payee and account renames change every transaction's row; key moves and removals leave no delete; route-by-route logging misses writers                    | Major    | Copied fields joined on the phone; `change_log` written by triggers; old keys logged as deleted (sections 7–8)                                  |
| M3    | The first download lacks history for the net worth chart, snoozes, monitor status and connection state; search silently incomplete                         | Major    | Added entities; A keeps the server's month totals; "Search older" (section 7)                                                                   |
| M4    | The cost table was unsupported; a bank link likely costs more writes; the Nov 3 outage was misattributed                                                   | Major    | History out of `change_log`; fewer writes dropped as a goal; table marked as estimates to measure; attribution corrected (sections 2, 11)       |
| M5    | 500-row pages won't fit 10 ms; stage 0 couldn't run on dev routes; the gates missed server CPU and cold start                                              | Major    | Pages sized by measurement; production endpoint behind a setting; new gates (stage 0)                                                           |
| M6    | Stages weren't reversible; the shadow comparison would report false differences; upcoming rows would count at a different time                             | Major    | Server keeps computing until stage 5; compare only when clean and at the same `through`; `upcomingThrough` from the server (sections 9, 10, 12) |
| M7    | More data at rest for longer than the threat model allows; iOS encryption claim unverified                                                                 | Major    | Section 13                                                                                                                                      |
| M8    | Offline edits lost on re-keyed rows; ordered by arrival time; reducers duplicate SQL side effects                                                          | Major    | Key map, edit time, property test against routes, versioned outbox (section 12)                                                                 |
| m1–m9 | Identity check reporting; the first-download set; half-applied pages; shared keys; code size; request count; totals description; old backups; version skew | Minor    | Sections 2, 5, 7, 8, 9, 10, 11                                                                                                                  |
| —     | A simpler option was missing: transactions on the phone, budget still on the server                                                                        | Minor    | Now part A, recommended first (section 4)                                                                                                       |

v1.2 (Nov 3, 2026): section 13 rewritten. The copy on the phone is encrypted with a key from your passkey (WebAuthn PRF), locks after 10 idle minutes, and is kept only where PRF works. The server works out an archived category's available itself instead of taking the phone's amount. Not yet reviewed.

v1.2 got a security review the same day. Findings were checked against the code; all are fixed in v1.3.

| #     | Finding                                                                                                                                                                          | Severity | Resolution                                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| B1    | The claim that a category's available depends only on its own rows was false: card refunds pay other categories' unfunded purchases (D-12), and refunds depend on card-wide debt | Blocker  | Claim removed; archive back to the v1.1 design (section 10), with why trusting the phone's amount adds no risk |
| M1    | Revoking never reached the copy; "Sign out other devices" only deletes sessions and is hidden for offline devices                                                                | Major    | `device` table, server key share, revoke, honest limits (13.2, 13.4, 13.6)                                     |
| M2    | Wiping on any 401 would wipe at the 24-hour session limit and lose offline edits                                                                                                 | Major    | Separate `session_expired`, `revoked`, `not_member`; outbox sent before a wipe (13.4)                          |
| M3    | Several passkeys and cross-device sign-in don't fit one wrapped key                                                                                                              | Major    | Credential id stored, `allowCredentials`, one wrapped key per passkey, refuse rather than wipe (13.2)          |
| M4    | Plaintext saved screens would stay through stages 1–4                                                                                                                            | Major    | Persister off in stage 1; cache cleared on lock (13.4)                                                         |
| M5    | The CSP doesn't stop a script sending data out; it allows every Plaid host                                                                                                       | Major    | Said plainly; narrower `connect-src`, `worker-src`, wider test (13.5)                                          |
| M6    | "Readable only while unlocked" was wrong both ways                                                                                                                               | Major    | Lock ends the server session; reload after Plaid Link; reworded (13.1, 13.4, 13.5)                             |
| M7    | Rows weren't bound to their ids, so they could be swapped or replayed                                                                                                            | Major    | Associated data, random IVs, encrypted manifest (13.3)                                                         |
| m1–m7 | Background timers; blocked deletes; Safari copies; uncertain PRF facts; PRF output in the sign-in post; threat table gaps; clock rollback                                        | Minor    | 13.1, 13.2, 13.4, 13.7                                                                                         |

## 16. As built (Nov 3, 2026, D-46)

- **One release, no stages or settings** (owner). `apps/worker/test/engine.test.ts` replaces the shadow comparison: a copy fed only by `/api/sync` gives exactly the server's answers for 11 screens, after a full download and after changes.
- **The phone runs the server's own code.** The engine (`apps/worker/src/local/engine.ts`) keeps the stored tables in sql.js (`sqljs-db.ts`) and answers screens with the server's routes and SQL, so there's one definition of every screen. So the sync sends the stored tables (`src/sync-tables.ts`), not screen-shaped transaction rows: a payee or account rename changes one row, and the views join it on the phone. After a sync the engine rebuilds only the lines of the transactions that changed and recomputes from the earliest month they or an assignment touch; it rebuilds everything after the first download, on a new day (upcoming rows can start counting), and when an account or the budget's start or time zone changes. Changes to payees, rules, alerts, balances or targets need no rebuild.
- **`change_log`** numbers are one more than the highest logged; rows are never deleted, so numbers never repeat.
- **The sync epoch lives in the Directory** (a restore of the budget's own database can't roll it back). `restoreVerify`, `restoreTo` and `POST /api/settings/restore` change it.
- **The server keeps nothing derived**, and the code runs one way (Nov 3, 2026): no route works anything out, on the server or on the phone. Changes answer `{ ok: true }`; on the server, screen reads answer `on_device`; the daily maintenance has no recompute or identity step, and the daily scan schedules repeats without looking at budget lines. The engine rebuilds lines and months after every sync page and every offline edit (`derive()`), and adds Ready to Assign to an offline edit's answer. The four derived tables stay, unused, until the next release drops them.
- **The copy is one AES-GCM blob**, bound to the device by associated data. Putting back an older blob only shows older data, and the next sync brings it up to date, so the per-row manifest in 13.3 isn't needed.
- **One passkey per copy.** The data key is non-extractable, so it can't be wrapped again for a second passkey; unlocking asks for the passkey that set the phone up (`allowCredentials`), and another one is refused, never wiped.
- **Upcoming rows** count from midnight in the budget's time zone on the phone. The server's daily scan counted them about 10 minutes after midnight, at most 40 a day.
- **Search and payee history** cover all history: the whole budget is synced, so "Search older" wasn't needed.
- **Lock** ends the server session too; unlocking online is a fresh sign-in, which also returns the PRF output in the same Face ID prompt. Registration asks for the `prf` extension, which security keys need and iCloud passkeys don't.
- **Not built yet:** dropping the derived tables (next release), the iPhone checks in stage 0, and replacing the mock API's own engine with a sample dataset.
- **Safari too (D-48, owner):** on an iPhone or iPad the copy is saved in Safari as well as in the Home Screen app; computers keep it in memory only.
- **No separate device list (D-52, owner):** "Phones with a copy" and its Turn off are gone. A phone with a saved copy is one of the sign-ins in Settings → Sign-in, shown as locked when it has no session; signing it out turns its copy off and the phone deletes it the next time it opens online, before showing anything.
