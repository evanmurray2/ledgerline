# Phase 1 measurements (go/no-go)

## Update: sync pages for the phone's copy (Nov 3, 2026)

`measure/phone.measure.ts`: `GET /api/sync` on a 3,000-transaction budget (node:sqlite, SQLite included, as a Durable Object pays it), 200 rows a page.

| Request                                | Count | ms median / p90 / max |
| -------------------------------------- | ----- | --------------------- |
| Full download page                     | 16    | 3.6 / 5.9 / 7.8       |
| Change page (600 changed transactions) | 4     | 3.9 / 4.2 / 4.2       |
| Nothing new                            | 20    | 0.1 / 0.2 / 0.2       |

Working out the budget moved to the phone (D-45), which has no 10 ms limit; the iPhone timings are still to be taken after deploy.

## Update: bank pending matching (Nov 3, 2026, D-47)

`measure/sync.measure.ts`, sync processing step, two runs each, ms (median / p90): before 1.4–1.5 / 1.6–2.4, after 1.5–1.7 / 2.2–2.5 at count 500 (cold first steps 11 vs 14–17). `pairBankPending` alone: 1.9 ms for 400 unmatched posted rows against 60 pending rows (an extreme account), with each description cleaned once per call; older posted rows are read only when the batch brings a pending row for that account.

## Update: step sizes in the code match D-37 (Nov 2, 2026)

The code had kept the D1-era sizes (apply 50 events, processing 100 events, recompute 6 months per request) while production ran in Durable Objects, where SQLite counts as CPU. They are now 25, 25 and 2 (decisions.md D-38). `apps/worker/measure` runs the same code on `node:sqlite` with the store's own migrations and now reports CPU **including** SQLite (`ms`), as a Durable Object pays it. Three runs, Node, ms (median / p90 / max):

| Path                                   | Before (6 months, 50 / 100 events) | After (2 months, 25 / 25 events) |
| -------------------------------------- | ---------------------------------- | -------------------------------- |
| Budget edit, first month (the request) | 8.7 / 21.8 / 21.8                  | 2.2–2.7 / 4.5–6.8 / 4.5–6.8      |
| Recompute job step                     | 6.3 / 15.8 / 21.5                  | 2.0–2.1 / 6.3–6.5 / 11.9–16.3    |
| Sync apply step                        | 6.2 / 7.2 / 14.2                   | 4.9–5.1 / 6.7–7.0 / 13.5–14.9    |
| Sync processing step                   | 5.6 / 5.9 / 8.4                    | 2.6–2.7 / 2.9–3.6 / 6.5–9.1      |
| Sync fetch step (100 transactions)     | 3.3 / 3.5 / 4.0                    | 3.2–3.7 / 3.6–4.3 / 4.7–6.0      |

A first-month edit now takes 18 small invocations instead of 6, and a 3,000-transaction backfill about 244 job steps; both are alarms, which have no daily step limit. The max column is the first, cold runs on a shared machine; the phase 0 figures from Cloudflare below are the reference for p95.

## Update: phase 0 on Cloudflare, a Durable Object per budget (Nov 2, 2026)

`.github/workflows/phase0.yml` deployed a throwaway Worker (`ledgerline-phase0`, not the live app) and ran the real code inside a SQLite Durable Object through the D1-shaped adapter (`apps/worker/src/store/adapter.ts`). Each operation ran 30 times or more as its own alarm invocation, one group of operations at a time with a quiet minute between groups. CPU per invocation comes from GraphQL Analytics (`durableObjectsInvocationsAdaptiveGroups`, run 41395183161). The Worker was deleted afterwards.

Data: the November budget plus 3,296 bank rows over three years; a 3,000-transaction backfill at 100 per page; the 36-month, 60-category budget. Step sizes: apply 25 events, processing 25 events, recompute 2 months.

CPU per invocation in ms. The gate is a p95 under 8 ms; the owner's limit is 10 ms.

| Operation                          | p50  | p95  | p99  | Gate |
| ---------------------------------- | ---- | ---- | ---- | ---- |
| `/api/session`                     | 2.0  | 6.5  | 7.8  | pass |
| `/api/badges`                      | 3.1  | 7.6  | 8.4  | pass |
| `/api/budget/2026-11`              | 3.3  | 7.7  | 13.3 | pass |
| `/api/accounts`                    | 3.5  | 7.9  | 13.0 | pass |
| `/api/reports`                     | 4.0  | 7.9  | 9.3  | pass |
| `/api/activity`                    | 7.2  | 10.8 | 17.0 | fail |
| `/api/activity?filter=attention`   | 5.5  | 9.8  | 10.7 | fail |
| Sync fetch step (100 transactions) | 3.3  | 4.5  | 6.1  | pass |
| Sync apply step (25 events)        | 3.4  | 4.7  | 5.6  | pass |
| Sync processing step (25 events)   | 5.0  | 7.7  | 10.6 | pass |
| Recompute step (2 months)          | 4.0  | 6.3  | 11.3 | pass |
| Move step (~150 KB of rows)        | 10.5 | 17.9 | 18.6 | fail |

These figures include the harness's own work in every invocation: reading its step plan and writing a timeline row, roughly 0.5 ms. Real steps will be a little lower.

What else phase 0 found:

- **Durable Objects on Free don't stop at 10 ms.** A request that burned about 49 ms of CPU succeeded, and an alarm that burned about 100 ms ran once without a retry. No invocation in the run reported `exceededCpuErrors`. The 10 ms limit is the owner's rule, not a platform cutoff for Durable Objects. Peaks over 10 ms don't fail, but the gate stays as designed.
- **Point-in-time recovery answered "This database has no history"** for a timestamp from before the object existed. It did not say the feature isn't available, which is what the local simulator says. This needs a retest against an object that's more than a minute old.
- **Durable Object rows are counted separately from D1** (`durableObjectsPeriodicGroups.rowsRead` / `rowsWritten`). D1's figures for the day didn't include them. Whether the Free plan enforces the two daily limits as one pool can't be seen without hitting a limit. Cloudflare's pricing pages list them as separate limits.
- **Per invocation, the Worker calling the object** (the router, a separate invocation) used 1–6 ms.

What changes in the design (`docs/multi-user.md`):

1. **Move steps of about 50 KB of rows**, not 150 KB. CPU scales with bytes: about 10.5 ms per 150 KB at p50, so 50 KB is about 3.5 ms.
2. **The Activity screen needs the fallback** planned in phase 0: a stored list of recent rows, kept up to date by sync and by edits, so the screen reads a few hundred stored rows instead of building them from `v_transaction` every time. The filter view gets the same. This is required before the switch.
3. **Processing and recompute have p99 peaks of about 11 ms.** They pass the gate. Dropping to 20 events and staying at 2 months would leave more margin; this is a tuning choice for phase 2.

## Update: SQLite in-process, for a database per budget (Nov 2, 2026)

Phase 0 of `docs/multi-user.md` v2 asked whether the hot paths would still fit 10 ms of CPU if each budget's SQLite ran inside a Durable Object, on the same thread as the code, instead of inside D1. `apps/worker/measure/store.measure.ts` runs the real code against `node:sqlite` and reports two numbers for each path. The first is today's Worker CPU, with SQLite excluded as in production. The second is the CPU spent executing SQLite and building result rows (`NodeD1.stats.execMicros`), which a Durable Object would add. Data: the November budget plus 3,296 bank rows over three years; a 3,000-transaction backfill at 100 per page; and the 36-month, 60-category budget.

Median ms over three runs of 7 (one run's p90 in brackets). This is a shared, noisy container, so read the ranges, not single values:

| Path                                | Today (SQLite in D1) | SQLite work | In a Durable Object |
| ----------------------------------- | -------------------- | ----------- | ------------------- |
| Budget screen                       | 1.4–2.2              | 0.4–0.7     | 1.8–2.9 (4.5)       |
| Activity screen                     | 2.0–2.8              | 1.7–2.2     | 3.6–5.1 (12.5)      |
| Other screens                       | 0.8–1.4              | 0.2–1.0     | 0.9–2.9             |
| Sync apply step (50 events)         | 2.6–4.0              | 2.1–2.7     | 4.7–6.7 (8.4)       |
| Sync processing step                | 0.6–0.9              | 4.2–5.9     | 4.9–6.8 (5.8)       |
| Budget edit, first month (6 months) | 3.2–5.3              | 2.0–3.0     | 5.2–8.0 (9.8)       |
| Recompute Workflow step (6 months)  | 3.1–7.3              | 2.0–2.4     | 5.0–9.1 (13.8)      |

The Durable Object column is a slight overestimate: today's figure includes the D1 client's JSON round trip, which a Durable Object doesn't do. The machine is also somewhat slower than the one behind the workerd figures below. Even so, the sync steps, budget edits and recompute steps would sit around 5–7 ms with peaks past 10 ms, against a 5 ms design threshold. Fitting them would mean smaller chunks: more Workflow steps, and steps (3,000 a day) are already the tightest Free-plan limit.

**Result at today's chunk sizes: no-go on the Free plan.** `execMicros` was added to `NodeD1` for this measurement, and `sync.measure.ts` was brought up to date with the 50-event apply chunks.

**Where the SQLite time goes** (`NodeD1.bySql`, per run): processing does four large reads per step (planning rows from `bank_txn` and `v_transaction`, about 1.3–1.7 ms each at 100 events). A recompute step does one read of the chunk's `budget_line` rows (about 0.6 ms per month). An apply step re-reads its staged 200 KB page (0.8 ms). The Activity screen's two `v_transaction` reads take about 1.3 ms. Every hot path except the screens scales with chunk size.

**With smaller chunks** (two runs each, store estimate median, p90 in brackets):

| Path                                  | Today's chunks                 | Smaller chunks               |
| ------------------------------------- | ------------------------------ | ---------------------------- |
| Processing step                       | 5.8–8.5 (9–14), 100 events     | 3.2–4.1 (3.9–4.9), 25 events |
| Budget edit, first month              | 6.2–8.3 (14–17), 6 months      | 2.9–3.4 (7.7–8.0), 2 months  |
| Recompute step                        | 5.5–7.4 (14–21), 6 months      | 2.3–3.3 (7.2–7.7), 2 months  |
| Apply step                            | 7.2–7.5 (10.6–10.8), 50 events | 3.8–4.0 (6.0–6.1), 25 events |
| Activity / Budget screens (unchunked) | 3.8–5.5 / 2.0–2.3              | same                         |

So the per-budget design fits 10 ms on Free with chunks of 2 months, 25 processing events and 25 apply events. That costs about 2–4 times as many invocations. As Workflow steps that would eat the 3,000-a-day limit (a 3,000-transaction backfill would go from about 150 steps to about 400), so the per-budget design should run its chunked work on Durable Object alarms. Alarms count as Durable Object requests (100,000 a day on Free) and one row written each, not as Workflow steps.

## Update: no R2 (decisions.md D-26)

Raw pages moved from R2 into D1, so the fetch step now decodes the page once and sends its text to D1 as one parameter, and the apply step parses the page text out of D1's response. Re-measured the same way (kernel method, 30 reps, median of 5, 100 transactions per page):

| Step  | Before (R2)  | Now (D1)   | With ~2 ms I/O |
| ----- | ------------ | ---------- | -------------- |
| Fetch | 0.07 ms      | 1.2–1.4 ms | about 3.5 ms   |
| Apply | 2.9 (2.5) ms | 3.1–3.4 ms | about 5.5 ms   |

A first try that also hashed each page measured 3.3–4.1 ms for fetch; SHA-256 of a 200 KB page alone was about 1.3 ms, so the page hash was dropped. The 3,000-transaction backfill through the real Workflow on local `wrangler dev` completed in 153 steps (30 fetch, 60 apply, plus processing and recompute), with 3,000 `bank_txn` rows, the cursor moved once and the lease released. That run also found a bug unrelated to R2: processing built SQL `IN` lists with one parameter per transaction, over D1's 100-parameter limit on large syncs; they are now chunked (regression test in `apps/worker/test/sync.test.ts`).

Sign-in (D-27) adds one D1 read per API request (the session row) and, at sign-in only, one ECDSA verification.

## Update: database reads per screen (Nov 1, 2026)

On the first day with 7 banks (578 transactions) the account passed D1's free 5 million rows read per day. Each screen reads every transaction (about 4 rows per transaction through `v_transaction`), and the tab badges loaded the full Activity and Accounts views on every screen, so each visit or edit cost about 16,000 reads. Measured on about 600 transactions (`apps/worker/test/read-cost.test.ts`, which now fails if these grow):

| Request                                                                                                       | Before                                   | After                                                      |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| Tab badges (every screen; new `/api/badges`, also carries the cached Ready to Assign for the desktop sidebar) | about 12,600 (Activity + Accounts views) | 2,200                                                      |
| Activity, Needs attention                                                                                     | 7,200                                    | 3,600 (skips the posted and upcoming scans it never shows) |
| Budget                                                                                                        | 4,100                                    | 4,100                                                      |

Data now stays fresh for 2 minutes before switching back to the app refetches it (was 15 seconds).

Then the heavy screens stopped reading history (migration 0006): an index on bank rows by date, `v_txn_bank` and `v_txn_manual` (the two halves of `v_transaction`, which can be read through indexes), `RECENT_TX` (rows posted since the earliest budget start, rows still pending from before it, and manual rows), lookups by key instead of joining `v_transaction`, a windowed Activity list, a covering payee index, and card statements kept to one snapshot per card per day with an indexed latest-per-card lookup (that query read every snapshot for every snapshot, so it grew with the square of their number). On data shaped like the real account (8 cards, about 600 transactions of history, two months of daily statements):

| Request                          | Start of the day                         | After                                     |
| -------------------------------- | ---------------------------------------- | ----------------------------------------- |
| Tab badges                       | about 16,000 (Activity + Accounts views) | about 700                                 |
| Budget                           | 11,900                                   | about 330                                 |
| Accounts                         | 13,100                                   | about 1,300                               |
| Activity, Needs attention        | 4,300                                    | under 1,500                               |
| Activity, full list (first page) | 8,400                                    | about 2,300                               |
| Owed to you                      | 3,500                                    | 120                                       |
| Reports                          | 15,100                                   | about 4,600 (13 months of totals at most) |
| Categorize, assign               | about 100                                | about 100                                 |

A day of active use (a few hundred screen visits and edits) is now in the hundreds of thousands of reads, under 10% of the free 5 million.

Then (migration 0007): every screen response carries an ETag built from `budget.data_version` (bumped by every
successful change through the API and by the daily jobs), the sync and recompute counters, connection updates, the
date and the deployed commit (`apps/worker/src/http/etag.ts`). A screen that hasn't changed answers 304 for a few
rows read. The app saves its data on the device and shows it at once after confirming the session (`state/saved.ts`;
cleared on sign-out and when a session ends), and categorizing no longer refetches Activity: the screen already
shows the change and the counts are adjusted locally. Estimates for a very heavy day (about 3,000 screen visits and
1,500 categorizations): visits mostly 304s (a few rows each), each categorization about 130 reads plus the version
bump, so well under 1 million reads; a normal day stays a few percent of the limit.

Then (migration 0008): posted totals per account per finished month are stored the first time they're needed and
reused until a write that could change them clears them (`apps/worker/src/ledger/totals.ts`; the sync's apply step
clears the months of every row it touches, before and after; processing clears from the earliest month it touched;
CSV import clears everything). The current month is always added up live. Accounts and Reports read these instead of
re-adding every posted row: on the test data, later visits cost about 960 and 1,080 reads (were 1,300 and 4,600, and
growing with history); the first visit after a change to a finished month stores it again. `apps/worker/test/sync.test.ts`
checks the stored totals equal a full recount after syncs that change, move and remove old rows, and fails if the
clearing is switched off.

The sections below are the original go/no-go, measured with R2.

Result: **go**, after two redesigns that the measurements forced. Each hot path's own compute is now under 3 ms in workerd, about 5 ms with the estimated I/O, against the 10 ms limit:

- **Sync apply step.** It could not fit at the design's 500 or 250 transactions per page. With raw pages in R2, the `bank_txn` projection built inside D1, and 100-transaction pages applied in 50-event steps, it is 2.5–2.9 ms.
- **Budget edit in the first month of a 36-month budget.** It could not fit as one recompute: about 20 ms, roughly 0.6 ms per month of history. It now recomputes at most 6 months per invocation (2.3–2.75 ms). Edits within the last 6 months finish in the request; older ones finish in the recompute Workflow, 6 months per step.

Measured on local `wrangler dev` (workerd, wrangler 4.156.0), against a Plaid-shaped mock (`tools/plaid-mock`), because no Plaid Sandbox keys were available in the build environment (decisions.md D-4). The mock serves the same request and response shapes as `/transactions/sync`, with transaction objects sized like Sandbox's (about 2 KB each, pretty-printed). With Sandbox keys in `apps/worker/.dev.vars`, the same harness runs against Sandbox.

## How CPU was measured

workerd freezes `Date.now()` and `performance.now()` while code runs, so in-Worker timers can't measure CPU. The harness (`tools/measure/`) takes V8 CPU profiles through workerd's inspector and counts every non-idle sample. A calibration loop measures 14.2 ms in Node and 15.7–16.9 ms under the profiler, so the profiler is accurate.

Whole-request profiles of a step on local dev are not usable on their own. Locally, D1 and R2 are simulators in the same workerd process, and their work shows up in the profile as native `fetch`, `get` and `put` frames, garbage collection and "(program)". Identical pages measured anywhere from 15 ms to 140 ms, and a request that does nothing measured 0.3–8.7 ms. So the go/no-go numbers come from two parts:

1. **Step compute, in workerd.** The `/__measure/kernel` route runs exactly the code a step runs on its data, repeated 30 times in one request. That covers decoding the bytes, parsing and normalizing the page, hashing each payload, building the batch, and the JSON serialization the D1 client does for the request. Per-step cost = (CPU of 30 reps − CPU of 1 rep) / 29, median of 5 runs, with the JIT warm as in a reused isolate.
2. **Fixed I/O per step, estimated.** A step makes four binding calls: renew the lease, one read batch, one R2 get, and one write batch. Locally these measure 4.8–7.5 ms, but that is the simulators' work; it is not reproducible here. The estimate below assumes **2 ms**. It must be confirmed after the first deploy from the CPU time Workers Logs records for each step (observability is on in `wrangler.jsonc`).

## Sync steps

Per-step compute in workerd, ms (median of 5; best in brackets):

| Design                                                                          | Fetch step | Apply step    | Fits 10 ms with 2 ms I/O?                |
| ------------------------------------------------------------------------------- | ---------- | ------------- | ---------------------------------------- |
| As designed, 500 per page (raw JSON per event in D1, projection params from JS) | 10–16      | 20–21         | No                                       |
| As designed, 250 per page                                                       | ~7         | 7.5–9.5       | No                                       |
| As designed, 100 per page                                                       | 2.4–3.5    | 3.8           | Borderline (~5.8)                        |
| Redesign, 500 per page, 50-event apply steps                                    | 0.05       | 7.5 (6.8)     | No: parsing the 1 MB page alone is ~4 ms |
| Redesign, 250 per page, 50-event apply steps                                    | 0.01       | 4.9 (4.4)     | Yes, but over the ~5 ms design threshold |
| **Redesign, 100 per page, 50-event apply steps (chosen)**                       | **0.07**   | **2.9 (2.5)** | **Yes: ~2 ms fetch, ~4.9 ms apply**      |

Where the apply step's time went before the redesign, at 100 per page: 1.2 ms in the D1 client's JSON serialization of a batch that carried every transaction twice (event payload plus projection parameters), 0.85 ms parsing and normalizing the page, 0.9 ms hashing 100 payloads, 0.4 ms decoding. The redesign:

- **Raw pages go to R2, once.** The fetch step hands Plaid's response bytes to R2 without decoding them (only the last 4 KB is decoded to read `next_cursor` and `has_more`). R2 computes the checksum server-side, and D1 keeps only metadata. Each `bank_event` stores a reference into its page instead of a copy of the raw JSON. A new append-only `bank_page` row records each applied page and its checksum.
- **The projection is built inside D1.** `INSERT INTO bank_txn … SELECT json_extract(payload, …) FROM bank_event`, run in the same batch, so transactions cross the wire once and the SQL runs in D1 rather than in Worker CPU.
- **Pages of 100, applied in 50-event steps.** Parsing grows with the page, so each step re-parses the 200 KB page (0.8 ms) and applies half of it.
- **Write-budget checks run inside each fetch and apply step** instead of as separate steps.

## Backfill of 3,000 transactions

|                                                    | Value                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Plaid calls (`count` 100)                          | 30, one per fetch step (under 50 even if the external-subrequest limit is per Workflow instance)  |
| Workflow steps, end to end on local `wrangler dev` | 109 (limit 1,024 per instance; 3,000 per day per account)                                         |
| D1 queries per fetch step / apply step             | 2 / 3 (plus 1 for the write-budget check)                                                         |
| Statements per apply batch                         | 10–11                                                                                             |
| D1 rows written                                    | ~4.1 per transaction including index writes, about 12,300 for the backfill before post-processing |
| Result                                             | 3,000 events and 3,000 `bank_txn` rows; cursor moved once, after the last page; lease released    |

The subrequest limit (per invocation or per Workflow instance) and the step limits can only be confirmed on Cloudflare. With 100 per page, a run stays under 50 Plaid calls up to 5,000 transactions, and a 180-day backfill per bank login is normally well under that.

## Fences (local D1 in workerd, `apps/worker/test/fences.test.ts`)

All pass:

- An apply batch rolls back when its lease was released, expired, is held by another run, has no expiry, or its connection row is missing. The batch's other write is gone afterwards.
- A failed-run release keeps the request flag for the next cron.
- `lease_guard.ok` rejects a missing value and 0.
- A processing batch rolls back when another processor moved the watermark.
- `bank_event` rejects UPDATE and DELETE.

## Budget edit (36 months, 60 categories)

Dataset (`apps/worker/src/measure/budget-seed.ts`): 36 months, 60 categories (58 spending or saving plus 2 card payment categories), 5,402 budget lines (about 150 a month on 4 cash and 2 card accounts), and 2,124 assignments. The edit changes one category's assignment in the first budget month.

Per-edit compute in workerd (`/__measure/kernel-budget`, `tools/measure/budget-kernel.mjs`) covers parsing D1's response, mapping rows, `computeBudget()`, encoding and hashing every month, and serializing the write batch:

| Months recomputed in one invocation  | CPU, ms (median, best) | D1 response size |
| ------------------------------------ | ---------------------- | ---------------- |
| 36 (the edit in one go, as designed) | 22.7 (20.9)            | 1.0 MB           |
| 12                                   | 5.1 (5.0)              | 350 KB           |
| **6 (chosen chunk)**                 | **2.75 (2.3)**         | 176 KB           |
| 3                                    | 1.1 (1.4)              | 90 KB            |
| 1                                    | 1.2 (1.3)              | 32 KB            |

Half the 36-month cost is parsing the 1 MB of activity rows. SQL grouping doesn't shrink it much at about 2.5 transactions per category per month, and funding card purchases needs date order inside each month. So the recompute is chunked (decisions.md D-22).

The whole first-month edit on SQLite (`apps/worker/measure/budget.measure.ts`, the same code path through `node:sqlite`):

|                              | Value                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Invocations                  | 6: the edit request (6 months) plus 5 recompute-Workflow steps (6 months each)                                                           |
| D1 calls per invocation      | 4: budget row, one read batch, one write batch, plus the edit itself in the request                                                      |
| Rows written for the edit    | about 50: the assignment, 36 month rows, and budget-row updates; one row per month because each month's cells are stored together (D-21) |
| Rows read for the edit       | about 8,000                                                                                                                              |
| An edit in the current month | 1 invocation, about 1 ms of compute                                                                                                      |

## D1 export (backup) row reads, estimated

A D1 export reads every row once. The 36-month dataset holds about 5,400 transactions, at roughly 5 rows each across `bank_event`, `bank_txn`, `budget_line`, `txn_overlay` and links, plus 2,124 assignments and the month rows. That is about 30,000 rows, under 1% of the 5,000,000 daily read limit. Confirm with the first nightly backup's manifest, which records row counts.

## Still to confirm on Cloudflare after the first deploy (owner)

- CPU time per Workflow step and per request in Workers Logs: fetch about 2 ms, apply about 5 ms expected.
- Whether the 50 external subrequests apply per invocation or per Workflow instance.
- Rows read by the first D1 export (estimate above).

### Phase 0 rerun, owner-sized Activity (Nov 2, 2026, run 41406679174)

- **Point-in-time recovery on Free works** on a Durable Object a few minutes old (bookmark returned). The first try, on a brand-new object, failed only because the requested time was before the object existed.
- **Activity: no numbers.** All 243 steps ran, but GraphQL Analytics returned no Durable Object CPU rows for them. This run and the first one used about 90% of the account's daily Durable Object allowance (the owner got Cloudflare's 90% notice). No further runs: Activity is measured on the real app's analytics after the move instead, and the stored recent-rows list is built only if it's over budget there.
