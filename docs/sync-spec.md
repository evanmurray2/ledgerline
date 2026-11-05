# Sync and recalculation spec

This tab is the implementation contract for the bank sync engine and budget recalculation; the Design tab states what they guarantee. Revised Oct 31, 2026 after an independent review (findings F1–F12 are cited where each rule comes from).


## What's true now

The **Money rules** and the matching mechanics below still stand exactly. The plumbing around them changed: see [`docs/whats-true-now.md`](whats-true-now.md). Where a section disagrees, the decision named wins; each changed section starts with a **Now** note.

## Guarantees the code must uphold

> **Now:** 1 and 2 stand. 3 holds on the phone, which does the recompute (D-45). 4 applies to the Durable Object daily limits, through the breaker (D-40).

1. A sync never moves a connection's Plaid cursor backwards and never applies a page from a run that no longer holds the lease.
2. Retrying any step adds nothing; every applied bank event is matched, ruled and reflected in the budget even if a run crashes partway.
3. Budget summaries always equal a from-scratch recompute, and one pure function defines Ready to Assign for both paths.
4. No background path can push the account past D1's daily write limit, because hitting it takes the whole app offline until 00:00 UTC.

## Free-plan limits this spec is built around

> **Now:** D1 and Workflow limits no longer apply (D-37). What counts now: 10 ms of CPU per request or alarm step (SQLite included), Durable Object rows and requests, and Worker requests (D-40).

| Limit | Value on Workers Free | Where it bites |
| --- | --- | --- |
| CPU per request, cron run or Workflow step | 10 ms | Every apply step and every budget edit |
| D1 queries per invocation | 50; a `batch()` counts as one | Budget recompute, apply steps |
| Subrequests per invocation | 50 external, 1,000 to Cloudflare services | Plaid calls; the docs list it per Workflow instance in one place and per invocation in another, so Phase 1 measures it |
| D1 bound parameters per statement | 100 | Multi-row inserts must be chunked |
| D1 row or value size | 2 MB | Staged pages |
| D1 rows written per day | 100,000, account-wide; all queries fail until 00:00 UTC once exceeded | Backfills, loops, recompute |
| Workflow step defaults | 5 retries, 10-minute timeout per attempt, exponential backoff from 10 s | Overridden below (F1) |
| Workflow state retention | 3 days | Staging lives in D1, not in step results |
| Workflow step result | 1 MiB | Steps return ids, never pages |
| Steps per instance | 1,024 per instance; 3,000 steps per day across the account | Verify in Phase 1 |

## Connection lease (F1, F2)

> **Now:** the lease and fences stand; steps are alarm job steps (store/jobs.ts), not Workflow steps (D-37).

Columns on `connection`: `sync_lock` (owning `sync_run` id), `lock_expires`, `resync_requested`. Lease TTL is 90 minutes. Every step is configured with a 2-minute timeout and 3 retries, so a step's worst case (about 9 minutes) stays far below the TTL.

1. **Request.** A webhook, the cron or Refresh sets `resync_requested = 1`, then tries to acquire.
2. **Acquire.** `UPDATE connection SET sync_lock = :run, lock_expires = :now + TTL, resync_requested = 0 WHERE id = :c AND (sync_lock IS NULL OR lock_expires < :now)`. Acquiring clears the flag, so a run's own trigger cannot make it loop. Losers exit.
3. **Renew.** Every step starts with `SET lock_expires = max(lock_expires, :now + TTL) WHERE id = :c AND sync_lock = :run`. If it changes 0 rows, the step throws `NonRetryableError` and the instance ends.
4. **Fence.** Every batch that applies data or moves the cursor starts with `INSERT OR REPLACE INTO lease_guard(id, ok) VALUES (1, coalesce((SELECT sync_lock = :run AND lock_expires > :now FROM connection WHERE id = :c), 0))`. `lease_guard.ok` has **no default** and is `NOT NULL CHECK (ok = 1)`. Every non-holding case (another run, released, expired, missing expiry, missing connection row) yields 0 and fails the CHECK. SQLite treats a CHECK failure under REPLACE as ABORT, and a D1 batch is a transaction, so the whole batch rolls back. The reviewer tested these cases in SQLite 3.53.1.
5. **Sleep.** Before sleeping for the write budget, a run sets `lock_expires` to its wake time plus the TTL, so the lease outlives the sleep and no cron run takes it over meanwhile.
6. **Release.** A successful run releases with `SET sync_lock = NULL, lock_expires = NULL WHERE id = :c AND sync_lock = :run AND resync_requested = 0`. A failed run releases on `sync_lock = :run` alone and leaves the flag for the next cron, so a failing run is never handed off to itself.
7. **Hand off.** If a successful run's release changes 0 rows, a request arrived mid-run:
   1. One step creates the next Workflow instance with id `:next` and returns `:next` as its step result, so a retry reuses it; "already exists" counts as success.
   2. The next step moves the lease: `SET sync_lock = :next, resync_requested = 0 WHERE sync_lock = :run`. Its renewal accepts `sync_lock IN (:run, :next)`.
   3. The new instance's first step retries (within its 3 attempts) until the lease names it.

   A new instance has fresh step names and a new run id, so cached step results and event keys cannot collide. At most 3 hand-offs in a row; if a hand-off dies between its two steps, the lease expires after the TTL and the next cron picks the work up.

## Run lifecycle

> **Now:** runs are alarm jobs (store/sync-job.ts); staged pages live in SQLite (D-26, D-37).

`sync_run` columns: `id`, `connection_id`, `phase` (fetching, applying, finalizing, done, failed), `run_start_cursor`, `restart_count`, `pages_fetched`, `applied_through`, `next_cursor`.

**Fetch.** Record `run_start_cursor` from `connection.cursor`. Step `fetch-{restart}-{i}` makes one `/transactions/sync` call with `count` 500 (Plaid's maximum, fewer calls per backfill), falling back to 250 if Phase 1 shows the apply step over budget, and writes one `sync_page` row. On `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`: delete this run's pages, increment `restart_count`, restart from `run_start_cursor`. After 3 restarts: phase failed, the lease is released (failed-run release, rule 6) and the flag stays set for the next cron.

**Apply.** Step `apply-{i}` sends one batch: fence; insert the page's events, chunked to 100 bound parameters per statement; upsert `bank_txn`; set `applied_through = i`; on the last page also set `connection.cursor = next_cursor` and `phase = finalizing`. Every event gets an `apply_seq` from a global counter row incremented in the same batch, so the log replays in the exact order it was applied (F12). Event key: `UNIQUE(sync_run_id, page, position)`; pages are applied once per run, so a retried step inserts nothing.

**Adopt, never delete (F1).** When a run acquires an expired lease and finds the previous run in `applying`, it adopts that run: the new instance continues from `applied_through` using the staged pages. A previous run still `fetching` has its pages deleted and fetching restarts from `connection.cursor`, which has not moved. Staging is pruned only for runs in `done` or `failed`.

## Post-apply work, driven by a watermark (F3)

> **Now:** stands, at 25 events per step (D-38); it no longer rebuilds budget lines on the server (D-45).

Matching, rules and recompute never depend on which run applied the events. `budget.processed_through` holds the highest `apply_seq` fully processed.

1. Each processing step reads up to 200 events with `apply_seq > processed_through`, in order, remembering the watermark it read as `:expected`.
2. One batch starts with a watermark fence (`ok = coalesce((SELECT processed_through = :expected FROM budget WHERE id = :b), 0)`, the lease-guard pattern), then writes the matcher's links, rule results for rows with no user categorization, and the new `processed_through`. If another processor moved the watermark first, the batch rolls back; this one re-reads and continues, at most 3 times.
3. When it catches up: refresh balances and card liabilities, mark the budget dirty, recompute, then release.

Because every batch applies against the exact watermark it read, two connections finishing together, the cron and the daily maintenance job can all process at once without matching a row twice, and the watermark never moves backwards.

If a run dies after moving the cursor, the next run, the cron or the daily maintenance job continues from the watermark. Rules never overwrite `categorized_by = user`, so reprocessing is harmless. `/api/health` reports watermark lag; the monitor alerts if lag stays above 0 for 24 hours.

## Matching mechanics (F4, F10)

> **Now:** the manual pending row is replaced (D-?, `docs/payee-names.md` 9.1, 9.2). Your entry pairs with a bank row only on exact evidence (your typed name equals one of its Plaid names, or the same amount on the same day), never on a score; otherwise "Same purchase?" asks, with Yes and No, and Not the same undoes a pair. An entry also covers a bank pending row: the bank row is hidden and the entry counts until the charge posts, then the posted row takes the entry's key. Batch order: link, posted ↔ bank pending, posted ↔ entries, bank pending ↔ entries. The other rows stand.

| Case | Rule |
| --- | --- |
| Posted row with `pending_transaction_id` | Inherit that pending row's `txn_key` |
| Manual pending | Same account, unmatched, dated 0–14 days before the posted date, amount within tolerance; auto-match only a unique best score on both sides |
| Posted row without the link, bank pending row still listed or removed (either order) | Claim it (D-47): same account and sign, amount within tolerance, pending authorized on the posted row's authorization day or the day before (else dated 0–14 days before), store numbers agree when both rows name one (D-50), names alike unless amount and day agree; best score first, each row once; ask only when a close alternative carries different edits |
| Claimed pending row | Hidden at once (views), even while the bank still lists it; its later removal changes nothing |
| Any match | Won't clear is cleared (flagged if it was set): a posted charge always counts |
| Re-issued posted row | Same account, same amount, dates within 3 days, and exactly one candidate on each side: inherit; otherwise queue "Possible re-issue" |
| Both rows carry user edits | For each field, the most recent edit wins, whichever row it was made on; the conflict is flagged for review |
| Removed row's edits | Held 14 days for a late match, then archived (visible in the audit log, not lost) |

## Budget recalculation (F5, F7, F9)

> **Now:** this runs on the phone, over its own copy, in one pass with no chunking or recompute job (D-45, D-46). The definition of Ready to Assign stands.

**Ready to Assign (one definition).** RTA is a single current number for today's month in the budget's time zone: all RTA inflows with a budget month up to the current month, minus all assignments in every month (future months included), minus cash overspending left uncovered at the end of each past month in every category. Inflows held in Waiting to match are excluded. Pending deposits count as RTA inflows as soon as they appear, and a reversal or changed amount adjusts RTA by the difference. Owed amounts on outflows are subtracted from RTA when paid and added back only when closed or cancelled; a payback reaches RTA once, as the matched inflow itself. Every month view shows this same number. Cached summaries store the month they were computed for; a read in a later month recomputes before answering. `computeBudget()` in `packages/domain` is the only implementation; the incremental path and the daily maintenance recompute both call it.

**Recompute in at most four queries.**

1. Read the snapshot at the end of month `dirty_from − 1`: available per category, debt per card, and the running Ready to Assign components (total RTA inflows, total assigned, total uncovered cash overspending, total open owed amounts).
2. Read activity with one grouped query by `(budget_month, category_id, card_account_id)`, where `card_account_id` is NULL for cash spending, including RTA inflows by month.
3. Read assignments from `:from` onward.
4. Run the carry-forward in JavaScript through the latest month with an assignment or the current month, applying the Money rules below. Compare to the cached cells, and write only the changed cells, the new month snapshots and RTA in one batch.

That batch starts with a version fence (the lease-guard pattern on `summary_version = :v`) and clears `summary_dirty_from` in the same batch, so a stale recompute either writes everything or nothing. On a version mismatch it retries at most 3 times, then leaves the budget dirty for the next write or the daily maintenance job.

## Write budget circuit breaker (F8)

> **Now:** counts Durable Object rows, requests and Worker requests, and stops reading at 95% (D-40).

The limits are per account, so the breaker reads account-wide usage, not just this Worker's: D1 rows read and written today come from Cloudflare's GraphQL Analytics API, which also counts the staging Worker, migrations, console queries and backup exports. Sync runs and the daily maintenance job refresh the figure at most every 10 minutes into `usage_day`; between refreshes, a run adds its own `meta.rows_written` and `meta.rows_read` in memory as an estimate. Ordinary page views write nothing. Both daily limits take the whole app offline when hit: 100,000 rows written and 5 million rows read.

| Usage today (UTC) | Behaviour |
| --- | --- |
| Under 70,000 writes and 3.5M reads | Normal |
| 70,000+ writes or 3.5M+ reads | Usage events are dropped; backfills, imports, the daily recompute and hand-offs sleep until 00:00 UTC (lease extended over the sleep); the monitor alerts |
| 90,000+ writes or 4.5M+ reads | App becomes read-only with a banner; only lease releases still write; screens check for changes every 15 minutes |
| 95% of any daily limit | The app rests (decisions.md D-40): reading stops too, except sign-in, the session and Plaid webhooks; saved screens stay on view under a banner until 00:00 UTC |

Since D-37 and D-40 the levels apply to the highest share of any daily limit: rows written (100,000), rows read (5M), Durable Object requests (100,000) and active time (13,000 GB-s), and Worker requests (100,000).

The step-8 hand-off, recompute retries and fetch restarts each have their own cap (3), so no loop is unbounded.

## Schema additions

> **Now:** the tables are in each budget's store (D-37); budget lines and month snapshots exist only in the phone's copy (migration 0006).

| Table or column | Purpose |
| --- | --- |
| `connection.sync_lock`, `lock_expires`, `resync_requested`, `days_requested` | Lease, pending request flag, history window |
| `sync_run` (`phase`, `run_start_cursor`, `restart_count`, `pages_fetched`, `applied_through`, `next_cursor`) | One row per run; adoptable |
| `sync_page` | Staged pages, pruned only for done or failed runs |
| `lease_guard` (one row: `id`, `ok NOT NULL CHECK (ok = 1)`) | Lease, watermark and version fences; ok has no default |
| `apply_counter` (one row) | Source of `apply_seq` |
| `bank_event.apply_seq`, `UNIQUE(sync_run_id, page, position)` | Replay order and idempotency |
| `budget.processed_through`, `summary_dirty_from`, `summary_version` | Post-apply watermark and recompute state; month snapshots also hold the running Ready to Assign components |
| `account.budget_from` | Later of budget start and link date; earlier rows are history |
| `txn_overlay.orphaned_at`, `txn_split.absorbs_remainder` | Held edits; split remainder line |
| `usage_day` | Account-wide rows read and written per UTC day, refreshed from Cloudflare's GraphQL Analytics API at most every 10 minutes |
| `user`, `budget_member`, `budget.time_zone`, `budget.budget_start_month` | Multi-user readiness and month boundaries |

## Money rules (exact)

Amounts are integer cents. For each category and month, transactions are processed in date order (posted date, then time added; on the same day, cash before card). `A` is the category's available at that moment; `P` is the card's payment category available.

1. **Cash outflow `x` from category C:** `A −= x`. Below zero at month end is cash overspending.
2. **Card purchase `x` in category C:** funded `f = clamp(A, 0, x)`; `A −= x`; `P += f`. The unfunded part `x − f` is credit overspending: new debt, and C resets to 0 for it at month end without touching RTA.
3. **Card refund `r` in category C:** `A += r`; `P −= g`, where `g` = the funded part of the linked purchase (capped at `r`), or `min(r, max(P, 0))` when unlinked.
4. **Payment from checking to card:** a transfer; `P −= amount`. No category is involved.
5. **Owed part `o` of a card purchase:** charged to RTA and moved to P in full, not capped by what RTA holds, so the card always stays covered; if that makes RTA negative, it shows in Needs attention. The part paid from the card's credit balance moves nothing to P (D-25).
6. **Month end:** for every category, negative cash available is added to that month's uncovered cash overspending, which RTA subtracts, and the category starts the next month at 0. Owed to you is a list, not a category, so nothing about it rolls over.
7. **Card coverage:** fully funded when `P = card bank balance + budgeted pending charges − uncategorized card spending`. Statement covered when `P ≥ statement balance`.
8. **Starting balances:** checking and savings become RTA inflows at budget start (or link). A card's starting debt never touches RTA; P starts at 0.
9. **Waiting to match:** a person-to-person inflow held for matching is excluded from RTA and categories until you choose Match (moves it to RTA and settles the owed items it pays) or Income (RTA).
10. **Identity, asserted after every recompute:** sum of cash and card working balances = sum of available in every category except card payment categories + RTA + Waiting to match + unsorted transfer sides (net) − uncategorized spending. Card payment categories are left out because each one mirrors card debt already counted in the card balances (rule 7 checks them separately).
11. **Close and Cancel:** Close charges the open owed amount to the original category in the current month and adds the same amount to RTA. Cancel removes the mark: the original category is charged the full amount in the transaction's own month (which can change that month's uncovered overspending), and RTA gets the owed amount back.
12. **Unlink and the rest of a payback:** unlinking a matched person-to-person inflow returns it to Waiting to match (RTA drops by that amount; the owed item reopens). The unmatched rest of an inflow follows your choice: Income goes to RTA; Keep waiting and I'll send it back stay in Waiting to match.
13. **Projected fronts:** for each scheduled transaction with an owed rule (e.g. rent), if current RTA is less than the owed amount, Needs attention shows the projected shortfall before the date.

Each rule is a property-based test, and rule 10 runs as an assertion in the daily recompute.

## Daily maintenance job

> **Now:** an alarm job in each store, not a Workflow (D-37): post-sync catch-up, usage roll-up, watchdog, prune. The full recompute and the identity check run on the phone (D-45); there are no backups or outside monitor to watch (D-29, D-49).

Third cron trigger, 10:20 UTC. One Workflow, steps in order, each under 10 ms of CPU:

1. Full recompute, one month per step, from budget start; any difference from the cache is fixed and recorded as drift.
2. Post-sync catch-up from `processed_through`.
3. Usage roll-up into `usage_daily`; prune raw usage events older than 90 days.
4. Read account-wide D1 usage from the GraphQL Analytics API into `usage_day`.
5. Watchdog: record last backup age, last monitor check and each connection's last sync in `health_status`; the app shows an alert on Accounts when any is overdue (backup over 36 hours, monitor over 24 hours, sync over 24 hours).

## Phase 1 measurements (go/no-go)

> **Now:** history; current figures are in `docs/measurements.md`.

Run on the free plan against Plaid Sandbox, with a simulated 36 months of history and 60 categories:

- CPU of one fetch step and one apply step at `count` 500 and 250.
- Apply of a 3,000-transaction backfill: total steps and subrequests per instance.
- An assignment edit in the first budget month: CPU, D1 queries and `rows_written`.
- The fences: an apply batch must roll back when its lease is released, expired, held by another run, or its connection row is missing; a processing batch must roll back when the watermark has moved; and a cash-plus-card month must match a full recompute.
- Money rules 1–13 as property tests, including a refund of an unfunded purchase, a front that makes RTA negative and its later payback, a pending deposit that is reversed, and a month rollover with no other writes.
- Rows read by one D1 export of the 36-month dataset, to confirm a nightly backup fits the daily read limit.

Any step or request above about 5 ms of CPU or 40 queries is redesigned before Phase 2.
