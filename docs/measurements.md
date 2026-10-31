# Phase 1 measurements (go/no-go)

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
