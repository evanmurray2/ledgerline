# What's true now

`docs/design.md` (Oct 31 design) and `docs/sync-spec.md` are kept as written. The system has moved on in the places below. Where a section there disagrees, the decision named wins (`docs/decisions.md`, `docs/decisions/`); each replaced section starts with a **Now** note. The Money rules, the budgeting model and the matching mechanics are unchanged.

One line per entry; add yours at the end of its list. This file merges with `merge=union` (`.gitattributes`, D-59): after a local merge, check for an entry listed twice.

## Design (`docs/design.md`)

- **Data:** the design said one D1 database. Now SQLite in Durable Objects: a `Directory` (users, sessions, routing) and one `BudgetStore` per budget (`docs/multi-user.md`). D-37, D-38.
- **Background work:** the design said Workflows and three crons. Now alarm jobs inside each store (sync, 4-hour backstop, daily scan at 5:00 AM and maintenance at 2:20 AM in the budget's time zone); one cron at 10:20 UTC wakes the Directory. D-37, D-38.
- **Who works out the budget:** the design said the Worker, on every request, with cached month summaries. Now the phone: it keeps an encrypted copy (`GET /api/sync`) and works out every screen with the same code; the server stores what was entered and imported, and keeps nothing derived. D-45, D-46, D-53; `docs/phone-budget.md`.
- **Sign-in:** the design said Cloudflare Access. Now passkeys in the Worker. D-27.
- **Raw Plaid pages and backups:** the design said R2 and a nightly encrypted export. Now raw pages in SQLite; no off-site backup; Cloudflare's 30-day point-in-time recovery, plus a full backup download from Settings. D-26, D-29, D-37.
- **Sync sizes:** the design said 500 per Plaid page, a Workflow step per page. Now 100 per page; 25 events per apply or processing step. D-6, D-38.
- **Environments and deploys:** the design said staging, then production after approval, with release, nightly and monitor workflows. Now no staging; every merge to `main` deploys after its `ci` passes; only `ci`, `deploy` and `security` workflows. D-30, D-36, D-49, D-51.
- **Database layer:** the design said Drizzle over D1. Now the app's own small interface over SQLite (`packages/db/src/sql.ts`). Nov 3 cleanup.
- **Tabs and their header:** the design said Budget, Activity, Accounts, Reports, each with its own title and Budget with its own month. Now Budget, Activity, Reports, Accounts; one `‹ November 2026 ›` bar in the same place on Budget, Activity and Reports with one month for the three, Activity by month (`docs/month-header.md`). D-58.
- **Progress tracking:** `docs/build-plan.md` lists open work only; work up to Nov 4, 2026 is in `docs/build-history.md`. D-59.
- **Rows before the budget start:** the design said they're used for payee learning and editable like any row. Now read-only (no category, note or Owed to you), left out of Activity's lists and Settings → Payees, still in registers, searches and Reports. D-61.
- **Categorization:** the design said an ordered rule list, then the payee's remembered category. Now no rules and no remembered category: Needs category suggests the category you've used most for the payee and you OK it (`docs/payees.md`). D-60.

## Sync spec (`docs/sync-spec.md`)

- **Storage and jobs:** SQLite in Durable Objects instead of D1, and alarm jobs in each budget's store instead of Workflows (D-37, D-38; `apps/worker/src/store/jobs.ts`). A failed step backs off and is tried up to 6 times.
- **Recalculation:** the phone works out budget lines, month snapshots and Ready to Assign from its own copy, with the same `computeBudget()`; the server keeps nothing derived and has no recompute (D-45, D-46). The guarantee in point 3 holds on the phone (`apps/worker/test/engine.test.ts`).
- **Limits:** D1's limits no longer apply; Durable Object rows read and written, requests and Worker requests do, and SQLite's CPU counts toward the 10 ms (D-40; `docs/measurements.md`).
- **Rules:** processing writes no rule results; it finds the payee, transfers and Waiting to match, and sets no category. D-60.
