# Working out the budget on the phone

Status: proposal v1, Nov 3, 2026. Not decided. Nothing here changes how money is counted: the same `computeBudget()` runs, in a different place.

## 1. The question

Today the server works out every screen. Each Budget, Activity, Accounts or Reports request reads rows in the budget's Durable Object, runs the domain functions and returns a finished view. To keep each request and job step under the owner's 10 ms CPU rule, the server keeps cached month totals and rebuilds them two months at a time in background jobs.

The proposal: the phone keeps a full copy of the budget's data and works out every screen itself, with the same functions from `packages/domain`. The server keeps everything that has to be shared or trusted: sign-in, bank sync, matching and rules at import, and saving your edits.

## 2. How it works today, in numbers

| Fact                                                  | Value                                                                                                                                             | Source                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Read endpoints that build screens                     | about 20 (`GET /api/budget/:month`, `/activity`, `/accounts`, `/reports`, sheets, settings views)                                                 | `docs/api.md`                      |
| Server code that builds views or keeps derived totals | `views/*.ts` (about 1,000 lines), most of `routes/activity.ts` (1,121), `budget/recompute.ts` (299), `ledger/totals.ts`, ETags, the recompute job | `apps/worker/src`                  |
| Derived tables kept on every write                    | `budget_line`, `month_snapshot`, `account_month_total`, `month_total_done`                                                                        | migration 0001                     |
| Full recompute, 36 months, 60 categories              | 22.7 ms in workerd, half of it parsing 1 MB of rows                                                                                               | `docs/measurements.md`             |
| An edit 36 months back                                | 18 invocations (1 request + 17 job steps), about 50 rows written, about 8,000 rows read                                                           | `docs/measurements.md`, D-22, D-38 |
| Activity on Cloudflare                                | p95 10.8 ms, fails the gate                                                                                                                       | `docs/measurements.md`, phase 0    |
| Free daily limits hit in production                   | reads (D1, before Nov 2), Durable Object rows written (Nov 3)                                                                                     | build plan; commit e10c310         |
| Offline                                               | view-only: saved screens in `localStorage`, about 5 MB, largest screens dropped first                                                             | D-42, `state/saved.ts`             |
| A second engine                                       | `apps/web/src/mock/db.ts`, 1,803 lines, "a plausible stand-in for the Worker, not the real budget engine"                                         | mock tests run against it          |

The size of the data: 3,296 bank rows over three years in the measurement set, 5,402 budget lines and 2,124 assignments over 36 months. All of it is a few MB, about the size of one photo.

## 3. Goals and non-goals

Goals:

1. Every screen opens from data already on the phone, with no request.
2. Budget math no longer has to fit 10 ms of server CPU, so the cached month totals, the recompute job and the "Updating" state can go.
3. Far fewer database reads and writes per day, well clear of the free limits.
4. Editing works offline and is sent when there's signal (stage 3).
5. One budget engine, used by the app, the tests and the mock.

Non-goals: changing any Money rule; sharing a budget between people; a native app; peer-to-peer sync between devices; end-to-end encryption (the server still reads your data to run rules and matching).

What does not change:

- **Money rules and `computeBudget()`.** The function moves, unchanged. `docs/sync-spec.md` Money rules stay the contract and their property tests stay.
- **Bank data is never edited.** `bank_event`, `bank_page` and `raw_page` stay append-only on the server.
- **Sync guarantees 1 and 2** (the cursor never goes backwards; retries add nothing). Guarantee 3 changes wording (section 9).
- **Matching, rules, transfer detection and payee cleanup run on the server at import**, as now. They decide things once, and those decisions are stored; changing a rule later never rewrites past months.
- **The server is the master copy.** The phone's copy can always be thrown away and downloaded again.

## 4. Options considered

| Option                                                                 | What it is                                                                                           | Verdict                                                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A. Keep it, tune it                                                    | Stored Activity list, smaller steps, more caching                                                    | Fixes Activity's 10 ms but adds another derived table; the free-limit and complexity problems stay                              |
| B. Server works out everything per request, no caches                  | Drop the 10 ms rule for budget math (Durable Objects on Free didn't stop a 49 ms request in phase 0) | Simplest code. Breaks the owner's hard rule and leans on behaviour Cloudflare doesn't promise                                   |
| **C. Phone works out the screens; server stores and syncs (this doc)** | Phone downloads changed rows and runs the domain functions                                           | Removes the derived tables and the read-side server code; keeps the 10 ms rule easily                                           |
| D. Full local-first: the phone owns the data                           | Edits are operations merged on each device; server is a relay                                        | Needs merge rules for every kind of edit and moves matching and rules to the phone; too much risk for a money app with one user |

C, built in stages, gets nearly all of D's benefits at a fraction of the risk.

## 5. Pros and cons

**For:**

|                                 | Why it matters                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Instant screens                 | Every tap reads memory. Search in Activity is local and as-you-type.                                                                                   |
| No 10 ms ceiling on budget math | The phone has seconds, not milliseconds. A full recompute is tens of ms on an iPhone (to be measured, section 12).                                     |
| Less code                       | Read-side views, stored totals, recompute chunking, ETags and the mock's second engine go (section 10). Roughly 3,000–4,000 lines out, about 1,000 in. |
| Free limits far away            | Opening the app becomes "anything new since N?": one indexed read when nothing changed. Edits stop writing month snapshots and totals.                 |
| Real offline                    | Read everything offline at once (stage 1); edit offline later (stage 3).                                                                               |
| Changing a Money rule is easier | Nothing derived is stored, so a fix to `computeBudget()` takes effect on the next app load. Today it needs every stored month redone.                  |
| One engine                      | The mock and e2e tests run the real engine on a sample budget, so they can no longer pass against logic that production doesn't use.                   |

**Against:**

|                                                  | How bad, and what limits it                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your full history is stored on the phone         | Today up to 24 hours of screens already are. iOS encrypts app storage while the phone is locked; the copy is wiped on sign-out and on any "signed out" answer. Optional later: encrypt it with a key that only your passkey unlocks (WebAuthn PRF).                             |
| Phone and server can disagree for a moment       | The phone shows what it last synced. Today's screens are also as old as the last load. It shows "Updated 2 min ago" when it's been a while.                                                                                                                                     |
| Edits from two devices                           | The server orders them as now (`txn_overlay.field_edits`, most recent wins). Each device catches up with the next sync.                                                                                                                                                         |
| The phone's clock and time zone                  | "Today" and the current month must use the budget's time zone (America/Los_Angeles), never the phone's, so travel can't move money between months. The server sends its time in every sync answer, and the phone uses it when its own clock differs by more than a few minutes. |
| A slow or old phone                              | Compute in a Web Worker so scrolling never stutters; keep month snapshots in memory and start a recompute from the edited month, as the server does now.                                                                                                                        |
| iOS can clear website storage                    | A Home Screen app's storage isn't cleared by Safari's 7-day rule, but iOS can still clear it when storage is low. The server is the master copy, so the cost is one download.                                                                                                   |
| A big change in a working app                    | Staged so every stage ships alone and can be turned back, with a shadow stage that compares phone and server numbers before anything switches (section 12).                                                                                                                     |
| The SQL view and its TypeScript copy could drift | Avoided: the server sends rows already shaped by `v_transaction`, so there's one definition of a transaction (section 7).                                                                                                                                                       |
| Two app versions out of step                     | Each sync answer carries a format version. A phone on an older format downloads everything again after reloading for the new release (`state/version.ts` already reloads).                                                                                                      |

## 6. Shape

```
Phone (installed web app)                  Worker + BudgetStore (Durable Object)
┌──────────────────────────────┐           ┌────────────────────────────────────┐
│ IndexedDB: rows by entity    │  GET      │ Sign-in (Directory)                │
│   + last change number N     │ /api/sync │ Plaid sync → bank log (append-only)│
│ Web Worker:                  │ ?since=N ─▶ matching, rules, transfers         │
│   toLogical → project →      │ ◀─ rows   │ overlay, assignments, targets …    │
│   computeBudget → views      │           │ change_log (number, entity, id)    │
│ Screens read memory          │  POST     │ validates and saves edits          │
│ Outbox for edits (stage 3)   │ edits ───▶│ answer includes the rows it changed│
└──────────────────────────────┘           └────────────────────────────────────┘
```

## 7. What the phone holds

The sync unit is **the row as the app means it**, not the raw tables, so that only the server's SQL defines how the bank row and your edits combine:

| Entity                                      | Comes from                                                                                                    | Notes                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `txn`                                       | `v_transaction` (bank rows with your edits, and manual rows): the `TxRow` shape already in `ledger/ledger.ts` | Bank rows from the budget start and every pending row in the stores' indexes; older history in pages on demand (section 8) |
| `split`, `owed`, `link`                     | `txn_split`, `expected_reimbursement`, `txn_link`                                                             | Keyed by transaction                                                                                                       |
| `account`                                   | `account` + latest balances, card statement                                                                   |                                                                                                                            |
| `category`, `group`, `assignment`, `target` | as stored                                                                                                     | Target versions included                                                                                                   |
| `payee`, `rule`                             | as stored                                                                                                     | For pickers, the Rules screen and rule previews                                                                            |
| `alert`                                     | `alert` (history changed, possible re-issue, needs sign-in)                                                   | Server facts the phone can't work out                                                                                      |
| `setting`, `budget`                         | time zone, budget start, connection status                                                                    |                                                                                                                            |

On the phone: `toLogical()` (moved from `ledger/ledger.ts` into `packages/domain`) → `project()` → `computeBudget()` → `categoryStatus()`, `neededThisMonth()`, `cardStatus()`, `projectedFronts()` → the same view shapes as `packages/contracts/src/screens.ts`. The screens keep their props; only where the data comes from changes.

## 8. The sync protocol

**Change numbers.** A `change_log (seq INTEGER PRIMARY KEY, entity TEXT, id TEXT, deleted INTEGER)` table with a unique index on `(entity, id)`: each write upserts the row for each entity it touches with a new `seq`, in the same transaction as the write. So the table holds one row per entity, not one per edit, and never grows past the number of entities. Writers that change a transaction's shape (bank apply, processing, overlay, splits, links, owed marks, account renames that change `account_name`) record `txn:<key>`. A helper used by every writer, plus a test that fails if any table in the list changes without a `change_log` row, keeps writers honest.

**`GET /api/sync?since=N&limit=500`** returns `{ format, serverTime, through, more, rows: [{ entity, id, data | null }] }`: the current row for each entity with `seq > N`, in `seq` order, up to the limit. `data: null` means deleted. With nothing new, it reads one index row and answers at once. Pages are sized to stay under 10 ms (measured in stage 0, like Activity's window).

**First download** is `since=0`, paged. History before the earliest budget start isn't sent at first: Activity and registers ask for older pages (`GET /api/sync/history?account=&before=`) when you scroll past them, and the phone keeps what it has fetched.

**When the phone syncs:** on open, when the app comes back to the screen, on pull-to-refresh, and every 2 minutes while open (as today's freshness window). The answer to every edit includes the rows that edit changed, so the screen is right without waiting for the next sync.

**Deletes and pruning:** a deleted entity keeps its `change_log` row with `deleted = 1`. If the server ever prunes those, it records the lowest `seq` still complete; a phone asking from below it downloads everything again.

## 9. Edits

**Stages 1–2: online edits, as now.** The phone calls the same mutation endpoints with the same contracts. The server validates, writes, rebuilds nothing derived, and answers with the changed rows. The phone recomputes from the edited month. The edit shows on screen when the answer arrives, which is how it works today.

**Stage 3: offline edits for a short list.** Category, memo, budget month, assign / set / move, target, mark reviewed. Each edit gets an id made on the phone and goes into an outbox in IndexedDB. The phone applies it to its copy with a reducer in `packages/domain` (`applyEdit(state, edit)`), the same function the server runs before its SQL write, so the two can't disagree about what an edit means. The server keeps the edit ids it has seen for 30 days and ignores repeats, so a resend after a dropped answer adds nothing. Edits that need the server's judgement (link a bank, match a payback, split a reimbursement, rules) stay online-only and are greyed out offline, as everything is today.

**Assign adds, so it is sent as "set to".** `AssignRequest` adds to each category. An offline add that is sent twice, or added on two devices, would count twice. Offline assign edits are sent as "set this category's assigned for this month to X, if it was Y"; if the server's value isn't Y, the edit is refused and the phone shows the server's number with a note.

**Guarantee 3 changes wording:** "Every number on screen is a from-scratch compute of the data the phone holds; the phone's data equals the server's as of `through`." There are no cached summaries left to drift.

## 10. What goes and what stays

Goes (stage 4, after stage 2 has run cleanly for two weeks):

- `month_snapshot`, `account_month_total`, `month_total_done`, and the dirty-month and version-fence columns on `budget`.
- `budget_line` and `planLineRebuild` (the phone derives lines with `project()`).
- `budget/recompute.ts`, the recompute job and its retries, the "Updating" state.
- Read endpoints and `views/*.ts`; most of `routes/activity.ts`, `accounts.ts` and the report route; ETags and `data_version` counters; `/api/badges`.
- `apps/web/src/mock/db.ts` and `server.ts`: the mock becomes a sample `/api/sync` dataset fed to the real engine.
- Saved screens in `localStorage` (`state/saved.ts`) and the drop-the-largest logic.

Migrations are forward-only, so dropping tables follows the expand-only rule: stop reading, then drop in a later release.

Stays: everything in section 3's "does not change", the job runner for sync and processing, the breaker's write levels, the Directory, passkeys, deploys.

**The daily identity check (rule 10)** moves to the phone: after every compute the phone runs `checkIdentity()` and, if it fails, posts a short report (`POST /api/notes` with the months and amounts, no payee names), which shows as a Needs attention item on every device. A server-side check would need the chunked recompute this doc removes.

## 11. Cost on the free plan

|                                  | Today (estimate)                                                                                         | Phone (estimate)                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Opening the app, nothing changed | 5–15 screen requests, a few rows each with ETags                                                         | 1 request, 1 row                                                                             |
| Categorize one transaction       | write the overlay, rebuild its lines, recompute 1–18 invocations, about 50 rows written for an old month | write the overlay, 1–3 `change_log` rows                                                     |
| Adding a bank (3,000 rows)       | about 20,000 rows written                                                                                | lower: no `budget_line`, totals or month rows; `change_log` adds about 1 row per transaction |
| A new phone or a cleared copy    | n/a                                                                                                      | about 10,000–15,000 rows read once (0.3% of the daily allowance)                             |

## 12. Stages

Each stage ships on its own and can be turned back with a setting.

0. **Measure (half a day).** Build `/api/sync` behind the dev routes; time a full download and a full compute on your iPhone with the 36-month, 60-category set. Go if the full compute is under 150 ms and the first download under 5 seconds on mobile data.
1. **Shadow (2–3 days).** Production: the phone syncs and computes in the background but screens still use the server. Every Budget load compares the phone's Ready to Assign and each category's available with the server's and posts any difference. Turns up any gap in what the phone is sent.
2. **Switch reads (3–5 days).** Budget, Activity, Accounts, Reports and the sheets read the phone's copy. Edits stay online. Shadow compare keeps running until stage 4.
3. **Offline edits (3–4 days).** Outbox, `applyEdit` reducers, edit ids, assign as set-if.
4. **Delete (2 days).** Section 10, after two clean weeks.

## 13. Open questions for the owner

1. Is the full history on the phone acceptable, with wipe on sign-out? Or should the copy be encrypted with a passkey-unlocked key from the start?
2. Stage 3 (offline edits): wanted, or is offline viewing enough?
3. Any other device besides the iPhone that should keep a copy (a laptop browser)?
