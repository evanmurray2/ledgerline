# Ledgerline — Zero-Based Budgeting App Design Doc

Oct 31, 2026 · @Evan


## What's true now

This doc is the Oct 31 design, kept as written. What later decisions replaced is listed in [`docs/whats-true-now.md`](whats-true-now.md); each replaced section here starts with a **Now** note. The Money rules and the budgeting model are unchanged.

## Summary and constraints

Ledgerline is a single-user, zero-based budgeting app (every dollar gets a job) that runs entirely on a free Cloudflare account, pulls cleared data from Plaid, and treats the bank feed as an immutable source of truth that the budget is derived from. "Ledgerline" is a working name.

**Goals**

- Every dollar on budget accounts is assigned to a category; Ready to Assign (RTA) is the only unassigned pool.
- Bank-posted data is never edited. User intent (categories, splits, notes, pending estimates) lives in a separate overlay layer keyed to bank records.
- Pending spend is visible and editable so the current month reflects reality before transactions post.
- Net worth from linked bank and card accounts, with money sent to investments shown as Invested rather than spending.
- Two swappable seams: the bank-data provider and the cloud runtime.

**Non-goals for v1**

- Shared-budget UI (data model and auth are multi-user ready; one user at launch), mobile native apps, an installed phone app (web first), bill pay, investment performance analytics (cost basis, returns), tax reporting.

**Hard constraints**

| Constraint | Implication |
| --- | --- |
| $0 to build, host, and use | Cloudflare Workers Free plan only, with no paid fallback if limits bite; no Workers Paid features (Queues, Durable Object SQLite beyond free limits, etc. must be checked); GitHub Free; no paid SaaS. |
| Plaid free access | Limited real-data Items; budget the Item count (see Bank data layer). |
| Personal financial data | Defense in depth: Cloudflare Access in front of everything, encrypted Plaid tokens, least-privilege CI. |
| Single user | Users and memberships exist from day one; every row carries a `budget_id` and every query is scoped by it in one data-access layer, so more users or budgets need no schema change. |

## Architecture

> **Now:** one Worker serves the app and API; data lives in Durable Objects (D-37), sign-in is passkeys (D-27), and the phone works out the budget (D-45). See the table at the top.

One Cloudflare Worker behind Access serves the app and API; a Workflow pulls bank data from Plaid into D1, where provider data is append-only and your edits live in a separate overlay. Two ports keep it swappable: `BankDataProvider` for the bank feed and a small set of platform ports (runtime, database, jobs, secrets, auth) for Cloudflare.

&#91;embedded content: system architecture · 8 components\]

Requests from you pass Access and are re-checked in the Worker; Plaid webhooks only start a sync, and all bank writes happen inside the sync Workflow, never from the UI.

## Cloudflare platform (free tier)

> **Now:** Durable Objects with SQLite instead of D1, alarm jobs instead of Workflows, one cron, no Access and no R2 (D-26, D-27, D-29, D-37, D-38). SQLite runs in-process, so its CPU counts toward the 10 ms (`docs/measurements.md`).

One Worker serves both the React SPA (as static assets) and the JSON API, backed by one D1 database, with Workflows for bank syncs and Access for login. Everything fits the Workers Free plan for a single user; the binding constraint is **10 ms of CPU per invocation**, not request or storage volume.

| Service | Use in Ledgerline | Free-plan limit that matters | Headroom for one user |
| --- | --- | --- | --- |
| Workers (+ Static Assets) | API (Hono) and SPA hosting on `*.workers.dev` | 100,000 requests/day; 10 ms CPU per request and per cron; 50 external subrequests per invocation; static asset requests free and unlimited | Large. CPU is the real limit: keep handlers thin and push aggregation into SQL. |
| D1 | All app data | 5M rows read/day, 100k rows written/day, 500 MB per DB, 10 DBs, 7-day Time Travel, 50 queries per request (a batch counts as one), 100 bound parameters per statement; hard-enforced since Sep 1, 2026 | A heavy day is roughly 10k reads and 2k writes. Index every query path. |
| Workflows | Durable, retryable Plaid sync per Item (one step per page) | 3,000 steps/day; 10 ms CPU per step; state kept 3 days; step result up to 1 MiB; default retries and timeouts overridden (see the spec tab) | 10 Items x 4 syncs x \~5 steps = \~200 steps/day. |
| Cron Triggers | Backstop sync (every 4 hours), stale-pending scan, and the daily maintenance job (backups run in GitHub Actions) | 5 per account | Use 3. |
| Cloudflare Access (Zero Trust Free) | Login, MFA, session in front of the whole Worker | Free plan | One user. |
| R2 | Nightly encrypted backup export (beyond D1's 7-day Time Travel) | Free allowance (verify current numbers before relying on it) | A few MB per night. |

Not used: KV (D1 covers config; avoids eventual-consistency bugs), Queues and Durable Objects (Workflows covers orchestration), custom domain (a registrar fee would break the $0 rule; `workers.dev` plus Access is enough).

**Living within 10 ms CPU.** Waiting on fetch() and D1 does not count toward CPU time, so network-bound work is fine. Rules: page Plaid sync at 500 transactions per call (Plaid's maximum; 250 if Phase 1 shows a step over budget) and run each page as its own Workflow step; compute month summaries with GROUP BY in SQL rather than JS loops; precompute the per-month category snapshot on write and read it on the Budget page; avoid heavy libraries on the hot path (no ORM runtime reflection, no big date libraries).

**Daily maintenance job (decided Oct 31, 2026).** The third cron trigger starts one Workflow a day at 10:20 UTC (about 3 a.m. Pacific). Its steps, each sized for 10 ms of CPU: (1) a full recompute from budget start, one month per step, compared with the cached summaries, fixing and reporting any drift; (2) post-sync catch-up from the watermark; (3) usage roll-up into `usage_daily` and pruning of raw events older than 90 days; (4) account-wide D1 usage read from Cloudflare's GraphQL Analytics API for the write circuit breaker; (5) a watchdog that records the age of the last backup, the last monitor check and each connection's last sync, which the app shows on Accounts when any is overdue. About 40 steps a day, far under the 3,000-step daily limit.

**Portability.** Cloudflare is one adapter behind five ports, so the app can move to Node (Fly, a VPS, a home server) or another edge host:

| Port | Cloudflare adapter | Portable alternative |
| --- | --- | --- |
| HTTP runtime | Hono on Workers | Hono on Node/Bun/Deno (same routes) |
| Database | Drizzle + D1 (SQLite dialect) | Drizzle + libSQL/SQLite, or Postgres with a dialect switch |
| Jobs/scheduler | Workflows + Cron Triggers | A job table + node-cron, or pg-boss |
| Secrets | Worker secrets | Env vars / Doppler / SOPS |
| Auth | Access JWT verification (`ctx.access` / `Cf-Access-Jwt-Assertion`) | App-level passkeys (WebAuthn) or OIDC |

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 free-tier enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/), [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/).

## Bank data layer

> **Now:** raw pages are stored in SQLite, not R2 (D-26); 100 transactions per Plaid page and 25 events per step (D-6, D-38). Everything else here stands.

Bank data enters through a provider-agnostic port, is stored as an append-only event log that nothing in the app can edit, and every screen reads a projection of that log plus a separate user overlay. Plaid is the first adapter; a CSV/OFX importer and a fake provider (for tests) are the second and third.

**Plaid on the Trial plan.** The Trial plan is free real-data access capped at 10 Production Items for the life of the team; `/item/remove` does not give a slot back. It includes Transactions, Investments, Liabilities, Balance, Auth, Identity, Assets and Statements. Your Plaid team (Individual account of Evan Murray) shows no Production usage in Aug–Oct 2026 via the Plaid MCP, but that covers only three months, and the cap counts every Item ever created, including removed ones. Before the first link: confirm on the Plaid Dashboard that the team is on the Trial plan, that its lifetime Item count is 0, and that it has never had a Production or Limited Production plan (Trial eligibility depends on that).

Item budget rules:

- One Item per institution login (an Item covers every account at that bank), so 10 Items is roughly 10 institutions.
- All development, CI and preview environments use **Sandbox only**. Production credentials exist only in the production Worker.
- Broken connections are repaired with Link **update mode**, which reuses the Item instead of creating a new one.
- The Connections screen shows a "7 of 10 Items used" meter and a confirm step before opening Link in Production.
- Avoid per-request products: use `/accounts/get` (free) for cached balances, not `/accounts/balance/get`, and `/transactions/sync` rather than `/transactions/refresh`.

**The port.** Every adapter implements one interface and emits normalized types; nothing outside the adapter sees Plaid field names.

```ts
interface BankDataProvider {
  readonly id: 'plaid' | 'csv' | 'fake';
  createLinkSession(opts: { mode: 'new' | 'repair'; connectionId?: string }): Promise<LinkSession>;
  completeLink(publicToken: string): Promise<Connection>;            // returns encrypted credential ref
  syncTransactions(conn: Connection, cursor: string | null): Promise<SyncPage>; // added / modified / removed + nextCursor + hasMore
  getAccounts(conn: Connection): Promise<ProviderAccount[]>;         // includes current/available balances + as-of
  getHoldings?(conn: Connection): Promise<ProviderHolding[]>;        // brokerage, IRA, 401k
  getLiabilities?(conn: Connection): Promise<ProviderLiability[]>;   // card statement, APR, min payment; loans
  verifyWebhook(req: Request): Promise<ProviderWebhookEvent | null>;  // signature check + parse
}
```

Normalized amounts are signed integers in minor units (cents) with **outflow negative**. Plaid reports outflows as positive, so the adapter flips the sign; this is the single most common bug in Plaid budgeting apps and gets its own unit test.

**Immutable source of truth.** Three tables, in order of authority:

1. `bank_event` (append-only): one row per `added`, `modified` or `removed` record received, with the full normalized payload, the provider's raw JSON, a SHA-256 of the payload, and the sync run id. Never updated or deleted, enforced by a SQLite trigger that raises on `UPDATE`/`DELETE`.
2. `bank_txn` (projection): the current state of each provider transaction, rebuilt from events. A `removed` event tombstones the row rather than deleting it.
3. `txn_overlay` (user intent): category, splits, memo, payee override, budget-month override, links. Keyed by a stable `txn_key` so it survives pending-to-posted transitions (next section).

Because the projection is derived, it can be rebuilt from events at any time, which is also how schema changes to it are migrated.

**History window (set once per Item).** Plaid's `days_requested` is fixed when an Item is created, and changing it means a new Item, which the 10-Item cap makes expensive. Decision: **180 days**, enough for payee learning, rule previews and drift checks; older history comes from the CSV history import. The value lives in config and a test asserts it is passed to every Production Link session.

**When data updates.** Plaid checks each bank on its own schedule, one to four times a day depending on the bank and account type. When it finds changes, it sends a `SYNC_UPDATES_AVAILABLE` webhook, and the Worker syncs that connection within a minute. A cron backstop runs every 4 hours and syncs any connection without a successful sync in the last 4 hours, in case a webhook is missed or a sync failed. Pull-to-refresh (or Refresh on desktop) syncs right away, but it only fetches what Plaid has already collected. Forcing Plaid to contact the bank (`/transactions/refresh`) is not used: Plaid's own checks are frequent enough for a budget, and each forced refresh adds API calls and sync work. Balances come from the same sync via `/accounts/get`, so they are as fresh as the last check. Each account shows its "synced" time.

**Sync guarantees.** Each bank login syncs one run at a time, under a lease the run must keep renewing. A sync fetches every page from Plaid before applying any, applies them in order, and moves the bank position only at the end, so it never goes backwards or skips data, and a run that has lost its lease cannot write. Retries add nothing; matching, rules and budget updates resume from a saved position if a run crashes; background work stops before the free plan's daily database-write limit. Mechanics, limits and schema are in Sync and recalculation spec.

**Pending vs posted in Plaid.** Plaid does not update a pending transaction into a posted one. It removes the pending record and adds a new posted record whose `pending_transaction_id` points at the old one; occasionally it fails to link them and the field is empty. The matcher in Pending transactions handles both cases.

**Will cleared balances always match the bank?** The balance shown for an account is the bank-reported balance, so yes, it matches by definition. Separately, Ledgerline computes `opening anchor + sum(posted transactions)` and shows a **drift badge** if the two disagree, which catches missed or duplicated imports. Expect occasional benign drift: some banks include pending items in the "current" balance, and Plaid returns only the history window requested at link time (180 days here), so the opening anchor is set at link time as reported balance minus imported posted history. Only the pending layer can differ from the bank by design.

Sources: [Plaid pricing and billing (Trial plan)](https://plaid.com/docs/account/billing/), [Plaid plan comparison](https://support.plaid.com/hc/en-us/articles/16110110883479-How-are-Sandbox-Production-Trial-plan-and-Limited-Production-different), [Plaid transaction states](https://plaid.com/docs/transactions/transactions-data/), [Plaid transactions webhooks](https://plaid.com/docs/transactions/webhooks/).

## Budgeting model

> **Now:** the model and Money rules stand; the numbers are worked out on the phone, not on the server (D-45, D-46).

Accounts are either **budget** accounts (cash you assign: checking, savings, credit cards) or **tracking** accounts (counted in net worth only: linked brokerage, IRA or loan accounts; none in v1, and there are no manual assets). Savings accounts are budget accounts (decided Oct 31, 2026): every dollar in them is assigned to a category, such as Emergency fund. Money crossing between the two groups is what needs a rule; money moving within either group never touches categories. The budget always balances: cash and card working balances (counting pending you've budgeted) = every category except the card payment categories + Ready to Assign + Waiting to match + transfer sides not yet sorted − spending not yet categorized. Card payment categories are left out because each one mirrors card debt that's already in the card balances.

**Ready to Assign.** RTA is one current number, computed for today's month in Pacific time: inflows categorized to RTA with a budget month up to the current month, minus everything assigned in every month (future months included), minus cash overspending left uncovered at the end of each past month. Money held in Waiting to match is not included. Pending deposits count as soon as they appear (decided Oct 31, 2026); if the bank reverses one or it posts for a different amount, RTA changes by the difference, and if that makes RTA negative it shows in Needs attention. Money you front for others comes out of RTA when you pay and comes back when it's paid back (see Reimbursement links). Cached figures record the month they were computed for, and the first read in a new month recomputes them, so month rollover never waits for an unrelated change. Every month view shows the same number. RTA can go negative when you assign more than you have, when money you front is more than what's unassigned, or when a pending deposit is reversed. The Assign sheet warns before over-assigning, a negative RTA is always a Needs attention item, and a scheduled front (like rent) that RTA can't cover shows there ahead of its date. One shared function computes RTA for live updates and the daily recompute.

**Budget start (decided: start fresh).** Budgeting begins at `budget_start_month`, your go-live month; nothing dated earlier ever enters category or RTA math.

- On the start date, each checking and savings account's bank-reported balance becomes a **Starting balance** inflow to RTA.
- A credit card's balance never touches RTA. It becomes card debt held against the card's payment category, which starts at $0, so the debt shows as underfunded until you assign to it. Counting it as a negative RTA inflow as well would charge it twice.
- Transactions dated before the start are history (never listed since D-61 and D-62; see `docs/whats-true-now.md`): counted in analytics, used for payee learning and drift checks, never placed in a budget month. Imported history rows are always history.
- Each account budgets from the later of the budget start and the date it was linked; its transactions before that date are history. Its starting balance is Plaid's current balance at link, treated as already excluding pending transactions (true for most banks), dated at the link. Because banks differ, the link screen shows the computed starting balance and asks you to confirm or correct it, and a drift check a week later compares the bank balance with starting balance plus posted transactions and offers a one-tap correction dated at the link. Every transaction pending at link, and the posted transaction it becomes, is budgeted even if its date is earlier; only transactions already posted before the link are history. Without this, a card linked three months after go-live would count those three months twice.

**Category kinds.** Every category has a kind, which decides how analytics labels its outflows:

| Kind | Examples (your own names) | Shown in analytics as |
| --- | --- | --- |
| Spending | Groceries, Rent, Dining | Spent (your share only) |
| Saving | Investments, Emergency fund (when moved to an account outside the budget), House down payment | Saved / invested (not spent) |
| Credit card payment (system) | One per card | Neither; created automatically |

**Marking money as invested.** You choose the kind when you create or edit a category ("In reports, money out of it counts as: Spending / Saving or investing"). Then any transaction categorized to a Saving category, by hand or by a rule such as "description contains VANGUARD → Investments", shows as invested. Kind is separate from group: a Vacation or Car insurance sinking fund can sit in a "Savings" group but stays Spending, because the money is spent when you use it.

You create, name, group and archive every category yourself. The app creates only the credit card payment categories (one per card), because the card math needs them. Money you front for others is not a category: it's tracked on the Owed to you list (see Reimbursement links).

**Transfers and investments.** This resolves the "not Ready to Assign, but not spent either" tension: contributions leave the budget through a Saving category, so they need assigned money (not RTA) and appear as invested rather than spent.

| Money moves from → to | Category needed? | Budget effect | Example |
| --- | --- | --- | --- |
| Budget → budget | No | None | Checking to savings; paying a card from checking (uses the card's payment category) |
| Budget → tracking | Yes, usually a Saving category | Leaves the budget; reduces that category's available | Checking to brokerage or IRA contribution |
| Tracking → budget | Inflow: RTA by default, or a chosen category | Enters the budget | Brokerage withdrawal to checking; labeled "Investment withdrawal", not income |
| Tracking → tracking | No | None | IRA rollover, brokerage cash sweep |
| Outside → tracking | No | None | 401k payroll deferral and employer match; never pass through checking |
| Market gains/losses | No | None | Recorded as a valuation change on the tracking account |

So your current "Investments" category keeps working: assign to it monthly, and the transfer to the brokerage spends from it. The only difference from ordinary spending is in reporting, where it counts as invested.

**v1 scope (decided Oct 31, 2026):** investment accounts are not linked in v1. Transfers to a brokerage or IRA are recorded as checking outflows to the Investments saving category: they count as invested in analytics. There are no manual assets (decided Oct 31, 2026), so net worth covers only linked bank and card accounts and drops when you invest; Reports shows Invested separately, which explains the drop. When they are linked, transfers count as budget-to-tracking only from the link date; earlier outflows stay as Saving outflows, so past months never change.

**Transfer detection** (revised Oct 31, 2026). When an outflow in one of your accounts has exactly one matching inflow of the same amount in another of your accounts within 5 days, the two are paired automatically and shown as a Transfer you can unpair. You're asked only when it's unclear: two or more possible other sides, or none. A short sheet then asks which account got the money, or whether it was a payment. Until you pick, the outflow and its candidate deposits count in no category and not in Ready to Assign; the budget check holds them aside the same way as Waiting to match. Both sides stay as separate bank rows that never change; the pairing lives in the overlay. A transaction can also be marked as a transfer by hand from its category picker, for example to an account that isn't linked, such as Venmo.

**Credit cards.** Exact rules are written as formulas under Money rules in Sync and recalculation spec and are property-tested. Each category's transactions are processed in date order, with cash before card on the same day. A card purchase categorized to a category moves the part that category can cover at that moment (the funded part) into the card's payment category; the rest is **credit overspending**, which becomes new card debt and flags the category. Payments from checking to the card are budget-to-budget transfers that draw down the payment category. The payment category is fully funded when its available equals the card's working balance: the bank balance plus pending charges you've budgeted, minus card spending that has no category yet (it hasn't been funded). Any gap shows on the card in Needs Attention. You pay cards in full every month, so each card row leads with whether its latest statement balance is covered (payment available ≥ statement balance) and when it's due.

**Which month a transaction counts in.** Each transaction has a budget month, defaulting to the month of its date (authorized date for card purchases when the bank provides it, otherwise posted date). It can be overridden (see Special cases).

**Pending in the budget.** Pending transactions (bank pending and your manual ones) count in category activity immediately, so the month reflects what you have committed. They do not count in the cleared balance. Each account shows three numbers: cleared (bank), pending, and working = cleared + pending, excluding anything marked won't-clear.

**Net worth.** Sum of every linked account balance (checking, savings and cards), valued as of each day. There are no manual assets or loans (decided Oct 31, 2026). Money owed to you is not counted until it's paid back; Accounts shows it on its own line under the total.

## Pending transactions

Pending is the one layer you can shape: add expected transactions, override a bank pending amount, or mark something won't-clear. The moment a posted bank transaction arrives, its amount wins, and any difference from what you entered is surfaced rather than silently replaced.

**Kinds of pending row**

| Kind | Created by | You can edit | Counts in category activity |
| --- | --- | --- | --- |
| Bank pending | Provider | Estimated amount (stored in overlay; bank amount kept), category, won't-clear | Yes, at your estimate if set, else bank amount |
| Manual pending ("expected") | You | Everything | Yes |
| Won't-clear (either kind) | You | Toggle off | No |

Typical uses: a $50 restaurant pre-auth you override to $61 with tip; a hotel hold you mark won't-clear; a check you wrote that hasn't hit the bank yet, entered as manual pending.

**Stable identity across posting.** Every transaction gets a `txn_key` at first sight. When a posted row arrives, it inherits the `txn_key` (and therefore the overlay: category, memo, splits, estimate) of the pending row it matches. Matching order:

1. **Provider link.** Posted row's `pending_transaction_id` names a bank pending row: inherit, done.
2. **Manual pending.** Candidates in the same account, not yet matched, dated 0–14 days before the posted date (Plaid says posting can rarely take up to 14 days), with amount within tolerance (default: max($5, 25%) for card purchases to cover tips and fuel holds; exact for ACH/checks). Score by amount closeness, date gap and payee similarity. One clear winner: auto-match. Two or more close candidates: queue for you to pick.
3. **Orphan recovery.** A bank pending row removed without a provider link: try rule 2 against unmatched posted rows in the same account from the last 14 days, whichever arrived first. If a posted row arrives first with no link, a live bank pending row with the same amount is shown as a likely match. When both rows carry your edits, the most recent edit wins (as in the Sync spec) and the conflict is flagged.
4. **No match.** Posted row starts fresh and goes through categorization rules.

**Re-issued posted transactions.** Plaid can also delete a posted transaction and add a replacement with a new id when the bank changes its details. The matcher treats any removed row and any row added in the same account, in the same sync or within the following 14 days, as candidates:

- Same amount, dates within 3 days, and exactly one candidate on each side: the replacement inherits the old `txn_key` (category, splits, links) automatically.
- Amount or date differs more than that: queued as "Possible re-issue" for you to confirm.
- A posted row in a month before the current one that is removed, re-issued or changes amount raises a **History changed** alert naming the month and the RTA impact.

A removed row keeps its edits on hold for 14 days, so a replacement that arrives in a later sync is matched by the same rules.

**Splits when the amount changes.** If an inherited transaction's posted amount differs from its split total (a tip, a currency adjustment), the difference goes to the split line marked "absorbs remainder" (default: the largest line) and the transaction is flagged for review. Fixed-amount rule splits, such as the rent split, mark their own remainder line.

**Alerts** (all appear in Activity's Needs attention filter and count toward the Activity badge)

| Alert | Trigger | Resolution |
| --- | --- | --- |
| Amount changed on clearing | Posted amount differs from your estimate or manual amount | Acknowledge; budget already uses the posted amount |
| Cleared despite won't-clear | A won't-clear row matched a posted row | Acknowledge; it now counts as normal spend |
| Stale manual pending | Manual pending unmatched after N days (default 7 days, checks included; you can set a longer wait per account). The alert offers Keep waiting (asks again 14 days later), Fix the amount or date, Match by hand, or Delete | Keep waiting, edit, match by hand, or delete |
| Vanished pending | Bank pending removed with no posted successor after 5 days | Usually a released hold; confirm and dismiss |
| Ambiguous match | Two or more equally good candidates | Pick the right one |

Every match records who made it (provider, auto, or you) and can be undone, which re-splits the pair.

## Categorization rules and payee cleanup

> **Now:** there are no rules and no remembered category; Needs category suggests the payee's most used category and you OK it (D-60, `docs/payees.md`). Payee normalization below still stands.

Categorization is deterministic: an ordered rule list, then the payee's remembered category, then nothing. Anything unmatched lands in an Uncategorized inbox for you. No ML; Plaid's own category is available only as a rule condition, never applied automatically.

**Evaluation order for each new transaction**

1. Payee resolution: raw description → payee via the alias table (below).
2. Explicit rules, top to bottom, **first match wins**.
3. Payee default: the category you last used for this payee, if you turned on "remember" for it (opt-in per payee to avoid wrong carry-overs like Amazon).
4. Otherwise uncategorized.

**Rule shape**

| Part | Options |
| --- | --- |
| Conditions (AND, with optional OR groups) | Payee is / contains; raw description contains / matches regex; account is; amount equals / between; direction in / out; Plaid category is; day of month between |
| Actions | Set category; set payee; set memo; split by fixed amounts or percentages; mark as transfer to account; mark part as expecting a payback; count in the previous month if it posts in the first N days of a month; flag for review |
| Options | Apply to pending too (default yes); stop after this rule (default yes) |

Each categorized transaction records which rule (or payee default, or you) set the category, shown as a small chip. Rules are never created silently. When you categorize a payee the same way every time (at least twice, never differently), the undo toast offers **Always**, which makes a rule in one tap. Payees with mixed history, like Amazon, get no offer, but their past categories appear at the top of the picker. Saving a rule shows a live preview of the last 90 days of matches and offers to apply it to uncategorized history. Rules never overwrite a category you set by hand. Rules are exportable as JSON.

**Payee normalization and merge**

Raw bank descriptions are noisy (`SQ *BLUE BOTTLE 0123 OAKLAND CA`, `TST* BLUE BOTTLE`, `BLUEBOTTLE COFFEE`). Pipeline:

1. **Clean**: uppercase, strip processor prefixes (`SQ *`, `TST*`, `PAYPAL *`, `POS DEBIT`, `ACH`), store and reference numbers, dates, card last-4, trailing city/state.
2. **Key**: the cleaned string, plus Plaid's `merchant_name` and `merchant_entity_id` when present.
3. **Cluster**: group keys by exact merchant id first, then trigram similarity above a threshold.
4. **Suggest**: a Payees screen lists clusters ("6 raw names look like Blue Bottle Coffee, 23 transactions") with merge, split and rename.
5. **Remember**: a merge writes alias rows (raw pattern → payee). Future imports resolve through aliases before rules run.

Renaming or merging payees changes the overlay only; raw bank descriptions stay visible in a transaction's detail panel.

## Targets

Four target types cover everything you listed; each produces one number per month, **needed this month**, which drives funding status and the auto-assign button. All money is in cents; when an amount doesn't divide evenly, the remainder goes to the last month of the period.

| Type | Plain meaning | Rolls over | Example |
| --- | --- | --- | --- |
| Refill (monthly / quarterly / yearly) | Have A available for each period; top up only what's missing; spread quarterly and yearly over monthly installments | Yes; leftover reduces the next period's need | Groceries refill $600/month; car insurance $540/quarter = $180/month |
| Set aside | Assign N every month regardless of balance | Yes; balance keeps growing | $200/month to Gifts |
| Balance by date | Reach B by a date, in even monthly steps | Yes | $3,000 vacation by Jun 2027 |
| Balance, no date | Reach B eventually; optional monthly contribution C | Yes | Emergency fund $15,000, $500/month |

**Math.** Notation: S = available at the start of the current period (rollover), P = assigned earlier in this period, a = assigned so far this month, r = months left in the period including this one, M = months left before the target month, counting this one ("$3,000 by Jun 2027" means funded by the start of June, so in November M = 7: Nov through May), X = available at the start of this month.

Refill (monthly is the case r = 1, P = 0):

```latex
\text{need} = \max\left(0,\ \left\lceil \frac{A - S - P}{r} \right\rceil - a\right)
```

Spending during the period does not raise the need; that money was meant to be used. Leftover at period end becomes the next period's S.

Set aside: need = max(0, N − a).

Balance by date:

```latex
\text{need} = \max\left(0,\ \left\lceil \frac{B - X}{M} \right\rceil - a\right)
```

Balance, no date: need = max(0, min(C, B − X) − a) when C is set; with no C there is no monthly need, only a progress bar.

**Funding statuses** (used by Needs Attention)

| Status | Rule |
| --- | --- |
| Overspent | Available < 0 |
| Underfunded | Need > 0 |
| Funded | Need = 0 and not overfunded |
| Overfunded | Refill: available > A. Set aside: a > N. Balance targets: available > B |
| Low | Spending categories only (decided Oct 31, 2026): bills, meaning categories in a bills group or with a due date, are never Low, since paying them early is normal. Low means less than 20% of the period amount left (or a per-category amount), or month-to-date spending running more than 30 points ahead of the month's elapsed share. |
| Covered / Short | Card payment categories only: Covered when the category holds at least the card's balance plus budgeted pending minus uncategorized card spending; Short by the difference otherwise. |
| Invested | A Saving or investing category whose money has left the budget this month as planned (e.g. the monthly Vanguard transfer). |
| Late / Tracking | The Owed to you row on Budget: Late when any payback is past its expect-by date (also a Needs attention item), otherwise Tracking. It holds no money. |

Targets are versioned: editing one starts a new version from the current month, so past months keep the target they were budgeted against.

## Special cases

**Reimbursement links (revised Oct 31, 2026 after an independent review).** Any outgoing transaction, in any category, can have part or all of it marked as **owed to you**. Incoming money is then **matched** to it, and once matched in full it's **paid back**. Those three words are used everywhere. Tracking is by amount per transaction, not by person; the transaction's memo can say who.

| Step | What happens |
| --- | --- |
| Owed to you list | Not a category (decided Oct 31, 2026, replacing the funded category): a list of what you've fronted, holding no money. The owed part of a transaction comes out of Ready to Assign when you pay. A payback goes to Ready to Assign and marks what it pays back as settled. If Ready to Assign can't cover a front, it goes negative and shows in Needs attention, so keep enough unassigned before a known front like rent. A payback past its expect-by date shows in Budget's Needs attention under Owed to you. |
| Mark | On an outflow (or one of its split lines), set what's owed: Half, Even split across N, All, a fraction, or a fixed amount, plus an "expect by" date. Fractions follow the transaction if its amount changes when it posts. A rule can mark automatically, e.g. 2/3 of the rent payee's payments over $2,500, never more than the transaction. |
| Until paid back | The owed part comes out of Ready to Assign, not the transaction's category, so the category and reports show only your share. On a credit card purchase, the owed part also moves from Ready to Assign into that card's payment category, so the card stays covered. |
| Match | Suggestions come only from person-to-person payments (Zelle, Venmo cash-outs, transfers from others) and look both forward and back about 10 days, so money that arrives before the expense is caught. The Match sheet splits one inflow across several owed items and handles the rest as income, extra paid back, or part of a paycheck (a work reimbursement). Buttons: Match, Not this. A 5-second Undo follows, and Unlink is on both transactions. Unlinking a person-to-person payback returns it to Waiting to match; unlinking part of a paycheck returns that part to Ready to Assign. "I'll send it back" keeps that part in Waiting to match until an outgoing payment to that person is matched to it. |
| Possible payback, not yet matched | Held in Waiting to match (decided Oct 31, 2026): not in Ready to Assign and not in any category, so it can't be spent and then disappear when matched. Activity lists it in Needs attention, under Money to match. Match moves it to Ready to Assign and marks what it pays back as settled; Income moves it to Ready to Assign without settling anything; both have Undo. |
| Marked at payback time | On an inflow, "Money back for…" picks a recent outflow and creates the owed amount and its match in one step. |
| Close out | When someone pays short or never pays, **Close** charges what's left to the original category in the current month and gives the same amount back to Ready to Assign, which had fronted it; if that overspends the category, Needs attention offers to cover it. **Cancel** removes a mark made by mistake. You can also move the expect-by date. |
| Reports | Spending uses your share; amounts closed out are added to the category in the month they're closed. A "still owed to you" line shows what's open. |
| Overdue | An item past its expect-by date (rent rule: the 15th; work expenses: 45 days) appears in Needs attention. |
| Where you see it | The Owed to you row on Budget (not a category; it shows the amount out and Late if anything is overdue) opens the list, with Match and Close on each. Accounts shows it under net worth, not in the total. |

Worked example: rent of $3,000 posts Nov 1 and counts in October (rule: first 5 days). The rule marks 2/3, so Rent is charged $1,000 and $2,000 comes out of Ready to Assign. A $1,000 Zelle on Nov 3 is matched: Ready to Assign gets $1,000 back and $1,000 is still owed. On Nov 14 a $1,018 Venmo cash-out waits to match; matching it as $1,000 for the rent plus $18 for a dinner you'd marked Half settles both and adds $1,018 to Ready to Assign. The Nov 30 rent then takes $2,000 out again.

**Payments that post after the month ends.** You pay rent at the end of every month, but a transfer sent on the 31st can post on the 1st, which would put two payments in one month and none in the other. Any rule can carry the option "count in the previous month if it posts in the first N days" (N = 5 for rent). Any transaction's budget month can still be changed by hand, and changed transactions show a small "counted in Oct" chip.

**Credit card refunds.** A refund is an inflow on the card. Categorize it to the original purchase's category (a rule suggests this when the payee matches a purchase in the last 90 days, and you can link the two). The category gets the full amount back. The card's payment category gives back what it had set aside for that purchase: the funded part of the linked purchase, or, if unlinked, as much as it holds up to the refund amount. So the payment category keeps matching the card's debt and no money is created. Spending analytics nets it against the category, so a $100 purchase and a $100 return show $0 spent.

**Rewards and cash back.**

| Form | Treatment |
| --- | --- |
| Statement credit on the card | Inflow to Ready to Assign, tagged "Rewards" (reported separately from income) |
| Cash back deposited to checking | Same: Ready to Assign, tagged "Rewards" |
| Points used to cover a specific purchase (e.g. travel credit) | Categorize the credit to the same category as the purchase so it nets out |
| Points transferred to an airline or hotel | No transaction; not tracked in v1 |

## Data model

> **Now:** the tables live in each budget's `BudgetStore` and the `Directory` (D-37). Budget lines, month snapshots and month totals exist only in the phone's copy (D-45; server migration 0006).

SQLite (D1) schema in four layers: provider data you can't edit, the overlay you can, budget structure, and derived caches. Conventions: ULID primary keys; money as `INTEGER` cents; dates as ISO `TEXT` (`YYYY-MM-DD`), budget months as `YYYY-MM` in your configured time zone; every table has `budget_id`, `created_at`, `updated_at`; soft delete via `archived_at` where history matters.

| Layer | Table | Purpose and key columns |
| --- | --- | --- |
| Provider (immutable) | `connection` | One per Plaid Item: provider, institution, encrypted access token + key version, cursor, status, last\_synced\_at, error\_code |
| Provider | `provider_account` | Provider account id, type/subtype, mask, name, current/available balance + as\_of |
| Provider | `bank_event` | Append-only: kind (added/modified/removed), provider\_txn\_id, payload JSON, raw JSON, sha256, sync\_run\_id. UPDATE/DELETE blocked by trigger |
| Provider | `bank_txn` | Projection: provider\_txn\_id, account, amount, date, authorized\_date, pending, pending\_provider\_txn\_id, raw\_name, merchant\_name, provider\_category, removed\_at, txn\_key |
| Provider | `holding_snapshot`, `liability_snapshot` | Dated snapshots for investment and loan/card detail |
| Core | `account` | Your view of an account: role (budget/tracking), kind (checking, savings, credit, brokerage, ira, 401k, loan, asset), linked provider\_account, opening\_anchor, on/off budget, closed\_at |
| Overlay | `txn_overlay` | Keyed by txn\_key: payee\_id, category\_id or splits, memo, budget\_month override, estimated\_amount, wont\_clear, categorized\_by (rule id / payee default / user), reviewed\_at |
| Overlay | `manual_pending` | Your expected transactions: account, date, amount, payee, category, matched\_txn\_key, matched\_by |
| Overlay | `txn_split` | Split lines: txn\_key, category\_id, amount, memo |
| Overlay | `txn_link` | Typed links between transactions: transfer, refund\_of, reimbursement\_of; amount\_cents (for reimbursement\_of: how much of the inflow pays this owed item, so one inflow can pay several items and one item can be paid by several inflows); created\_by |
| Overlay | `expected_reimbursement` | Payback expected on an outflow: txn\_key, amount expected, expect-by date, optional memo. Repayments attach through txn\_link (reimbursement\_of) with an amount each; still owed = amount expected minus the sum of those links, and the item counts as paid back when that reaches zero. |
| Budget | `category_group`, `category` | Name, sort order, kind (spending/saving/cc\_payment; cc\_payment is the only kind the app creates), linked account for cc\_payment, low\_threshold, archived\_at |
| Budget | `assignment` | (category, month) → assigned amount; history of edits in audit log |
| Budget | `target` | Category, type, amount, period, due date, monthly contribution, effective\_from month (versioned) |
| Rules | `rule`, `rule_condition`, `rule_action` | Ordered rules; JSON condition tree; actions |
| Payees | `payee`, `payee_alias` | Display name, remember-category flag, default category; alias = raw pattern or merchant id → payee |
| Derived | `month_category_summary` | (month, category) → assigned, activity, available; rebuilt on write for affected months |
| Ops | `sync_run`, `alert`, `audit_log`, `setting` | Sync history; open alerts with type and ack state; every mutation (who, what, before/after); preferences |

Further tables and columns for leases, staging, the post-apply watermark, multi-user membership and write tracking are listed in Sync and recalculation spec.

Read model for transactions is a SQL view, `v_transaction`, joining `bank_txn` (not removed), `manual_pending` (unmatched) and `txn_overlay`, exposing one row per logical transaction with status (pending, posted, wont\_clear), effective amount and effective budget month. Every screen queries the view, never the raw tables.

Category available chains forward month to month (carryover, cash overspending, credit overspending), so a change in one month changes every later month and Ready to Assign. Month summaries are a cache: your edits update them before the page responds, syncs update them after applying, each recompute uses at most four database queries however long the history, and the daily maintenance job's full recompute repairs and reports any drift. Mechanics are in Sync and recalculation spec.

## UI

A responsive web app, used in the browser first (installing it as a phone app comes later). Four tabs: **Budget, Activity, Accounts, Reports**, with Settings behind a gear in Accounts. Ready to Assign and its Assign button sit in a bar just above the tabs, in thumb reach. Mockups (v2, after an independent review): [Ledgerline mobile mockups](https://claude.ai/artifact/2h8daG7G5NgTg1QbryBZjd).

| Screen | What's on it | Key actions |
| --- | --- | --- |
| Budget (home) | Month switcher; sync problems shown in the header; All / **Needs attention** filter; card payment categories pinned first, leading with "statement covered"; collapsible groups with totals; every row ends in a status word (Funded, Low, Overspent, Underfunded, Overfunded, No target, Invested; Covered or Short for card payments; Late or Tracking for the Owed to you row); bars mean only "money left this month" | Tap a category for its sheet; Assign from the bottom bar |
| Needs attention (Budget filter) | Overspent, Underfunded, Low and Overfunded categories, with card overspending explained; Short cards under Card payments (Fund puts in the card debt that covering an overspent category won't); plus late paybacks under Owed to you | One-tap fixes with amounts: Cover, Fund, Move |
| Category sheet | Assigned, spent, available; target; recent transactions | Set assigned, move money, edit target |
| Assign sheet | Suggested amounts (cover overspending, fund targets) with checkboxes; any category | Assign the selected total |
| Activity | Search; three filters (decided Oct 31, 2026): **All**, **Needs attention** and **Not posted yet**. Needs attention holds everything waiting on you, in groups: Money to match (Waiting to match), Transfers to sort out (unclear other side), Needs category (one row per transaction, with Select several for bulk), and Check these (amounts that changed from your estimate, stale entries). Under All the same groups sit at the top, then Pending, Upcoming (counts on its date) and the posted register. The Activity badge is the Needs attention count. Matched transactions don't count, since nothing is left to decide; there is no Owed to you filter because the Owed to you screen on Budget covers that. | Categorize in place (a category button on each row; Select to give several the same category; Split from the picker), link paybacks, add an expected transaction |
| Transaction sheet | Bank amount and your estimate with tip shortcuts; category and split; expecting to be paid back; counts-in month; won't clear; raw bank name | Edit, split, mark payback, rename payee |
| Accounts | Net worth; repair prompt for broken connections; cash and cards (statement due, covered); Owed to you under the total. Bank connections live in Settings | Open an account's transactions, repair a connection, settings |
| Reports | Month to date by default; Spent, Invested, Income, Rewards; spending by category, net of paybacks | Change month, drill into transactions |
| Settings | Categories and groups (archive), budget start, rules, payees (merge), connections, import, export, sign-in | Edit each |

Auto-categorized transactions count immediately with a small badge saying which rule set them; there is no approval step. Uncategorized transactions don't count in any category until you categorize them, which Activity's Needs attention shows.

Archived categories disappear from every picker but keep their history in Budget (shown under a collapsed "Archived" group in months where they had activity) and in Analytics.

**Things you didn't list that I'd include**

- Undo and an audit trail for every change (cheap given the audit log, and essential with automation acting on your data).
- Search across transactions (payee, memo, amount, date range).
- Split transactions (needed for the rent rule anyway).
- Scheduled / recurring transactions (rent, subscriptions, paychecks) shown as Upcoming. They count in the budget from their date, then match the bank transaction like a manual pending entry.
- CSV/OFX import as a fallback provider, for banks Plaid can't reach or once the 10 Items are used.
- Full data export (JSON + CSV) and a CSV import of past transactions from your previous budgeting tool, so you start with years of analytics.
- Notifications: no app email. Cloudflare can only send email from a domain you own, which the $0 rule excludes, so Needs attention and the badges on Activity and Accounts are the in-app signals, and GitHub's failure emails cover infrastructure problems.
- Age of money and "days of buffer" as optional metrics.
- Month close: lock a month after reconciliation so later edits require confirmation.

Every screen above is in the clickable prototype on the mockups canvas (Prototype page). It also covers:

- first-run setup
- rules, payee merging and rename
- category editing
- bank connections and import/export
- each kind of transaction sheet: pending, posted, income, card refund, and paid back with Unlink
- the problem states
- a desktop layout

Banners stay on the tab they belong to: uncategorized transactions are handled only in Activity, and connection repair only in Accounts.

**States and layouts** (decided Oct 31, 2026):

- **Offline:** view only. The last loaded data stays visible and browsable, but anything that changes data is greyed out, so nothing is saved twice or lost. Nothing is queued offline.
- **Daily D1 limit reached:** Cloudflare refuses every database query until midnight UTC (shown in Pacific time), so the app can show only what it already has loaded, read-only, with a banner giving the reset time. Bank syncs wait until the reset.
- **Failed sync** (not a login problem): shown on Accounts with the last good sync time, the next automatic retry, and a Try now button. The budget is unaffected.
- **Wrong account signed in:** blocked by Cloudflare Access before the app loads.
- **Income for next month:** an income transaction can be set to count in the next month ("Save for December") using the existing budget-month override.
- **Wide screens:** a left sidebar replaces the tab bar, the budget becomes a table with Assigned, Spent and Available columns, and sheets open in a right-hand side panel.

**Appearance.** Light, Dark, or Match device (the default), set in Settings and saved per device. All colors come from one set of named tokens with a light and a dark value, so every screen switches together. Dark mode uses a near-black background (#0E1014) and slightly raised surfaces, lighter status colors that keep 4.5:1 contrast, and a lighter accent blue with dark text on filled buttons.

## Usage tracking

The app keeps a private log of how you use it, so you can see which screens and features earn their place, where tasks take too long, and what to change next. It is first-party only: events go to your own D1 database through your own Worker. There is no third-party analytics script, nothing leaves your Cloudflare account, and it costs nothing.

**What is recorded.** Each event has a time, a session id (random per app open), the app version, the screen, an event name, a target id and at most one number.

| Event | Example | Answers |
| --- | --- | --- |
| Screen view | `activity`, `budget.attention` | Which screens you use, and how often |
| Tap on a named control | `activity.category.choose`, `txn.split` | Which features you use, and which you never touch |
| Task completed, with duration | `categorize` 4 s, `assign` 22 s, `match` 9 s | Which flows are slow and worth simplifying |
| Undo or back-out | `undo.categorize`, closing a sheet without saving | Where the app guessed wrong or confused you |
| Repeated taps on the same spot | 3+ taps in 1 s on a non-control | Things that look tappable but aren't |
| Search with no results | result count and query length only | Missing filters or payee names |
| Error shown | error code | Bugs you hit but didn't report |
| Suggestion outcome | rule offer: Always / ignored; transfer pair: kept / unpaired | Whether the app's guesses are trusted |

**What is never recorded.** No amounts, payee names, memos, category names you typed, search text, or account numbers. Controls are tagged with fixed ids in code (for example `data-track="activity.select"`), so the log can't capture what's on screen by accident.

**How it is stored.** The browser keeps events in memory and sends them in one batch every 30 seconds, and when the app is hidden (with `fetch(..., {keepalive: true})`, which keeps the CSRF header that `sendBeacon` can't send). That's one D1 batch per flush into a `usage_event` table. Expected volume is a few hundred rows a day, well under the 100,000-row daily write limit. Usage writes have the lowest priority: the write circuit breaker drops them first, from its 70% tier, and a hard cap of 2,000 events a day applies. The daily maintenance job rolls raw events into a `usage_daily` summary (date, screen, event, target, count, median duration) and deletes raw events older than 90 days. The summary is kept indefinitely.

**How you use it.** There is no usage screen in the app. To review, use **Export usage (JSON)** in Import and export, and hand the file to a review session (for example with Claude). The review ranks screens and features by use, finds features you never touch, compares task times with the previous version, and lists the flows with the most undos and back-outs.

A **Note** button can be switched on in Settings. It sits in the corner of every screen and saves a short note tagged with the current screen and the last few events, for "this was annoying" moments. Notes are included in the export. Tracking can be turned off in Settings; turning it off stops collection and offers to delete the stored log.

**Release comparison.** Every event carries the app version, so a change can be checked against the version before it: did categorizing get faster, did undo rates drop. This is the main way to decide whether a UI change worked.

## Security and authentication

> **Now:** passkey sign-in in the Worker instead of Access (D-27); no off-site backups (D-29); the outside monitor was removed (D-49). `docs/threat-model.md` is current.

**You authenticate with Cloudflare Access, and the Worker independently verifies every request.** Access sits in front of the whole `workers.dev` hostname (and all preview URLs), so an unauthenticated request never reaches app code. Inside the Worker, middleware rejects any request without a valid Access identity (`ctx.access`, or verifying the `Cf-Access-Jwt-Assertion` JWT against your team's public keys with the expected audience). This double check protects against a misconfigured Access policy.

Access setup:

- Policy: allow only the GitHub accounts listed as budget members (just yours at launch); deny everything else. Adding a person means adding them to both the Access policy and the budget's members.
- Identity provider: GitHub, protected by your passkey (set up Oct 31, 2026). Access's one-time email PIN is turned off.
- Session length 24 hours; re-authentication required for Connections and Export.
- One bypass: `POST /api/webhooks/plaid`, which instead requires a valid Plaid webhook signature (below) and does nothing except start a sync.
- Portable fallback (if you leave Cloudflare): the same auth port with an app-level passkey (WebAuthn) adapter.

**Controls**

| Area | Control |
| --- | --- |
| Plaid webhooks | Verify the `Plaid-Verification` JWT (ES256): fetch the key by `kid` from `/webhook_verification_key/get` and cache it, reject if `iat` is older than 5 minutes, compare the SHA-256 of the raw body to the `request_body_sha256` claim. Handler only enqueues a sync for a known Item id. |
| Plaid access tokens | AES-256-GCM encrypted in D1 with a key-encryption key held as a Worker secret; key version stored per row for rotation; decrypted only inside the sync Workflow; never returned by any API |
| Secrets | Plaid client id/secret and the encryption key are Worker secrets, set per environment; never in the repo, CI logs or the SPA bundle |
| Data at rest | D1 is encrypted at rest by Cloudflare; field-level encryption only for credentials (encrypting amounts would break SQL aggregation) |
| Transport and browser | HTTPS only; HSTS; strict CSP allowing only self plus Plaid Link's script and frame origins; `frame-ancestors 'none'`; `Referrer-Policy: no-referrer`; no third-party analytics or fonts |
| CSRF | Mutations require JSON content type and a custom header, plus an Origin check |
| Input and queries | Zod validation on every request and every provider payload; parameterized queries only; all queries go through one data-access layer that requires a budget id and checks it against the caller's membership, so a query can't skip the check |
| Logging | Structured logs with an allowlist of fields; no amounts, names, descriptions or tokens in logs; request ids for tracing |
| Integrity | Immutable bank event log (DB trigger); audit log of every mutation with before/after |
| Backups | D1 Time Travel gives 7 days of point-in-time restore. A nightly GitHub Actions job (not a Worker, which can't fit a full export in 10 ms of CPU) calls D1's export API with a read-only token, encrypts the dump with an age **public** key and uploads it to R2 with 90-day retention, plus a small manifest (size, checksum, row counts) that the job checks. The private key never goes into GitHub: it lives on your computer and in your password manager, so a compromised CI can't read backups. A monthly restore drill is done by hand on your computer into a local D1. Phase 1 measures how many rows an export reads, since it may count toward the daily read limit. Two safeguards keep backups from stopping silently: a monthly keepalive workflow commits a timestamp so GitHub never disables scheduled workflows for inactivity (it does after 60 days in public repos), and the Worker's daily watchdog shows an alert on Accounts if the last backup is more than 36 hours old. Backups must be running before the first Production bank link. |
| Accounts | Cloudflare, GitHub and Plaid accounts all with hardware-key 2FA; CI uses a Cloudflare API token scoped to Workers + D1 on one account only |
| Supply chain | Lockfile with integrity, minimal dependencies, Dependabot, OSV-Scanner, actions pinned to commit SHAs |

**Monitoring from both sides.** A scheduled GitHub Actions job every 6 hours calls `/api/health` using an Access service token. The endpoint returns only statuses: last successful sync per connection, the last backup time and today's account-wide D1 usage, no financial data. The job fails, and GitHub emails you, if any connection is more than 24 hours stale, the last backup is more than 36 hours old, or usage passes 70% of a daily limit. Each call is recorded, and the Worker's daily watchdog shows "Monitoring stopped" on Accounts if no check has arrived for 24 hours, so a disabled or broken GitHub job is visible in the app.

Threats this design accepts: a compromise of your Cloudflare account or your identity provider account exposes the data. Hardware-key 2FA on both is the main mitigation.

## Repository and CI/CD

> **Now:** no staging (D-36); every merge to `main` deploys after its `ci` passes (D-30, D-49); release, nightly and monitor workflows are gone (D-49); sessions merge without rebasing (D-51). `docs/build-plan.md` lists open work; `docs/whats-true-now.md` lists the rest.

A TypeScript pnpm monorepo whose core budgeting logic is a pure package with no I/O, so the hardest logic is the most tested and the least tied to Cloudflare.

```
ledgerline/
  apps/
    web/            React + Vite SPA (TanStack Router + Query, Tailwind)
    worker/         Hono API, Workflows, cron handlers; serves web/dist as static assets; wrangler.jsonc
  packages/
    domain/         Pure TS: money, RTA, targets, rules engine, pending matcher, payee normalizer
    contracts/      Zod schemas shared by API and SPA
    db/             Drizzle schema, SQL migrations, repositories, v_transaction view
    bank-provider/  BankDataProvider port + plaid, csv, fake adapters
    platform/       Ports (auth, secrets, jobs, clock) + cloudflare and node adapters
  e2e/              Playwright tests
  docs/             ADRs (architecture decision records), threat model, runbooks
  .github/          workflows, CODEOWNERS, dependabot.yml, PR template
```

**Engineering standards**

- TypeScript `strict` everywhere; typescript-eslint strict config; Prettier; no `any` at package boundaries.
- Money is a branded integer type; no floating point in `domain` (lint rule bans `parseFloat` and `/` on money).
- Tests: Vitest unit tests for `domain` with property-based tests (fast-check) for money and target math, aiming for full branch coverage there; integration tests run the real Worker and a local D1 via `@cloudflare/vitest-pool-workers`; Playwright end-to-end against `wrangler dev` with the fake provider, plus a nightly run against Plaid Sandbox.
- Migrations: forward-only SQL files, expand-then-contract for breaking changes, checked in CI by applying them to a fresh DB and to a copy of the previous schema.
- Conventional Commits; ADR for every significant decision (the first ones are the choices in this doc).

**GitHub settings**

- Make the repo **public**: the code holds no secrets or data, and public repos get CodeQL code scanning, secret scanning with push protection and dependency review at no cost; on a free private repo most of these are not available. If you prefer private, drop CodeQL and rely on Semgrep and Gitleaks.
- Protect `main` with a ruleset: PR required, all checks green, linear history, signed commits, no force pushes, CODEOWNERS review (you).
- Dependabot for npm and GitHub Actions, grouped weekly; Renovate is an alternative.

**Pipelines (GitHub Actions)**

| Workflow | Trigger | Steps |
| --- | --- | --- |
| ci.yml | Every PR and push to main | Install with frozen lockfile → lint, typecheck, format check → unit tests → integration tests on a local D1 → build → migration check → bundle size budget → Playwright against local `wrangler dev` with the fake provider. No Cloudflare token. |
| security.yml | PR, push, weekly | CodeQL; Gitleaks; OSV-Scanner; dependency review; zizmor + actionlint to lint the workflows themselves |
| deploy.yml | Merge to main, after your approval | Deploy to the `ledgerline-staging` Worker (own secrets, own D1, Plaid Sandbox, behind Access) → migrations + smoke tests there → apply D1 migrations to production → `wrangler deploy` → smoke test (health, auth rejection without Access, a read query) → automatic `wrangler rollback` on failure |
| release.yml | Merge to main | release-please for version tags and changelog |
| nightly.yml | Schedule | Encrypted backup export to R2 with a manifest check (no decryption key in GitHub); E2E against Plaid Sandbox on local wrangler dev. A separate monthly keepalive workflow prevents GitHub from disabling schedules. |
| monitor.yml | Every 6 hours | Health check (see Security) |

**One Cloudflare account (decided).** Since Sep 15, 2026, Cloudflare API tokens can be limited to specific Workers. Deploys use two tokens: a staging token limited to the staging Worker, and a production token limited to the production Worker, stored in a GitHub environment that needs your approval. Check in Phase 0 whether D1 permissions can be limited the same way; if not, database migrations run as their own approved step with their own token. PR workflows still never receive a token: PRs are tested entirely locally, and the first remote deployment happens after merge and your approval. Staging is a separate Worker rather than a version of the production Worker, because Worker secrets are shared across versions; this keeps production Plaid keys and the encryption key out of unreviewed code. Accepted trade-off: staging shares the account's daily request, D1 and cron limits, so it runs only on deploy and its data stays small.

Workflow hardening: default `permissions: contents: read`, elevated per job only where needed; every third-party action pinned to a full commit SHA; `CLOUDFLARE_API_TOKEN` and Plaid production secrets stored only in the production Environment; no `pull_request_target`; concurrency groups so deploys never overlap.

D1 databases used: production and staging (2 of the 10 free); CI and nightly jobs use local D1 only. Cron triggers used: 3 of the 5 (sync backstop, stale-pending scan, daily maintenance); backups and the outside monitor run in GitHub Actions. Plaid environments: Sandbox for local, CI and staging; Production only in the production Worker. During setup, check whether R2 or Zero Trust asks for a payment method; if one is on file, add R2 lifecycle rules and a $0 budget alert so going over a free allowance can't be billed silently.

## Risks, open questions and plan

> **Now:** open work is listed in `docs/build-plan.md`, work up to Nov 4, 2026 in `docs/build-history.md`; measurements are in `docs/measurements.md`.

**Risks**

| Risk | Impact | Mitigation |
| --- | --- | --- |
| 10 lifetime Plaid Items | A mistake (linking in preview, re-linking instead of repairing) permanently burns a slot | Sandbox everywhere except production; update mode for repairs; confirm dialog with Item meter; CSV fallback provider |
| Plaid Trial terms change | Could lose free real-data access | Provider port keeps the app working on CSV/OFX import; the immutable log keeps all history already pulled |
| 10 ms CPU per invocation | Sync or budget recompute times out | One page per Workflow step; SQL aggregation; precomputed month summaries; CPU profiling in integration tests; a phase 1 go/no-go measurement on the free plan, since there is no paid fallback |
| D1 daily limits now hard-enforced | App errors until midnight UTC | Indexes on every query path; account-wide usage from Cloudflare's analytics; alert at 70% of daily limits |
| Institutions without pending data | Pending view empty for that bank | Manual pending entries still work; documented per account |
| Only 7 days of D1 Time Travel on Free | Older mistakes not recoverable from Time Travel | Nightly encrypted R2 export with 90-day retention; monthly restore drill by hand; the app warns if the last backup is more than 36 hours old |

**Decisions (Oct 31, 2026)**

| Question | Decision | Effect on the design |
| --- | --- | --- |
| Bank logins | 6–8, all banks and cards | 2–4 Plaid slots spare for later investment logins; the slot meter and confirm dialog stay in v1 |
| Investment accounts | Not in v1 | Contributions are outflows to the Investments saving category; no retroactive changes when accounts are added later |
| Venmo | Cashed out immediately | No Venmo account; repayments matched on the bank deposit |
| Sign-in | GitHub with a passkey (set up) | Access uses GitHub; email PIN off |
| Repo | Public | CodeQL, secret scanning and dependency review on |
| Past history import | Import it | Imported rows are history only (see Budget start); volume to be sized once the export is available |
| Time zone | US Pacific (America/Los\_Angeles) | Month boundaries and "today" |
| Plaid personal use | Assumed permitted | No change; CSV fallback stays |
| Budget start | Start fresh at the go-live month | Budget start section; pre-start rows never enter budget math |
| Paid services | None, including Workers Paid | 10 ms CPU is a hard ceiling; phase 1 go/no-go measurement |
| Phone | Web first | Installable phone app later; link banks from a desktop browser |
| Users | One at launch, multi-user ready | `user` and `budget_member` tables; budget-scoped data access |
| Cloudflare accounts | One | No PR previews; PR CI gets no Cloudflare token; separate staging Worker |
| Plaid history window | 180 days per Item (proposed) | Confirm before the first Production link; can't be changed afterwards |

**UI decisions (Oct 31, 2026)**

| Question | Decision |
| --- | --- |
| Navigation | Budget, Activity, Accounts, Reports; Settings in Accounts |
| Needs attention | A filter on Budget, not its own tab |
| Rule-categorized transactions | Count right away; no approval step |
| Credit cards | Paid in full monthly; card rows lead with whether the statement is covered |
| Roommate rent | General reimbursement links; fronted money comes out of Ready to Assign and paybacks return to it (no Owed to you category); tracked by amount, not person; short or unpaid amounts close out to the original category |
| Rent posting late | Rule option: count in the previous month if it posts in the first 5 days |
| Investment accounts | Not linked in v1 and not tracked; money sent to them counts as Invested |

**Design review (Oct 31, 2026)**

An adversarial review found 1 blocker, 8 major and 5 minor issues. All are fixed in this revision except where marked.

| # | Finding | Severity | Resolution |
| --- | --- | --- | --- |
| 1 | Backfilled history corrupted Ready to Assign; the history import would double-count | Blocker | Fixed: budget start month, history rows excluded from budget math |
| 2 | Plaid history window fixed at link time | Major | Fixed: 180 days, set once in config and test-enforced |
| 3 | Cursor committed per page broke Plaid's restart rule | Major | Fixed: staged pages, restart from `run_start_cursor` |
| 4 | Overlapping syncs and duplicate webhooks | Major | Fixed: per-connection lease and unique event key |
| 5 | Re-issued posted transactions lost your edits | Major | Fixed: re-issue matcher and History changed alert |
| 6 | Summary rebuilt only the changed month | Major | Fixed: forward recompute and nightly consistency check |
| 7 | Preview builds shared production secrets and token | Major | Mitigated in one account: no PR previews or PR tokens, separate staging Worker. Accepted: staging shares account-wide limits |
| 8 | Plaid Trial terms unvalidated | Major | Accepted: personal use assumed permitted; whether the Trial has a time limit is still unconfirmed |
| 9 | Backup job couldn't fit the CPU limit | Major | Fixed: backup runs in GitHub Actions |
| 10 | Onboarding could exceed D1's daily writes | Minor | Fixed: daily write tally; backfills pause until the next UTC day |
| 11 | Linking investments later would rewrite past months | Minor | Fixed: no retroactive reclassification |
| 12 | Split totals break when posted amount changes | Minor | Fixed: remainder line |
| 13 | Sign-in redirects in an installed iPhone app | Minor | Deferred: web first |
| 14 | No alert when syncing stalls | Minor | Fixed: GitHub Actions health monitor |

**Re-review of sync and recalculation (Oct 31, 2026).** A focused second pass found 3 major and 6 minor issues in the revised sections; all are fixed in this revision. Majors: an expired lease could let a stale run overwrite newer data (fixed with lease renewal and fencing); applying a whole run in one step would exceed the CPU limit (fixed with page-by-page apply); recalculation could lose concurrent changes or show stale numbers after an edit (fixed with a version counter and same-request recompute). Minors: lost sync request at release, content-based dedupe dropping repeats, cross-run re-issues, future-month assignments, account-wide write tally, unbounded restarts. Reviewer caveat: this pass was done by the doc's author, not an independent reviewer.

**Independent review (Oct 31, 2026).** A reviewer with no access to this conversation checked the sync and recalculation sections against Cloudflare, Plaid and SQLite documentation. It found 6 major and 6 minor issues, including bugs in the previous round's fixes:

- the lease check passed once a lease was released;
- work after applying a sync wasn't crash-safe;
- a posted row arriving before its pending removal lost your edits;
- recompute could exceed 50 database queries per request;
- accounts linked after go-live double-counted their backfill;
- Ready to Assign had two conflicting definitions.

All 12 are fixed in this revision, and the mechanics moved to Sync and recalculation spec. The review confirmed that D1 batches are all-or-nothing, that restarting from the run's first cursor is what Plaid requires, and that staged page sizes, cursor lifetime, the 180-day window and pausing until midnight all work as planned.

**Final check (Oct 31, 2026).** The same reviewer re-checked this revision and judged it ready to build Phase 1 with changes. It tested the lease fence in SQLite against every lease state. Its 3 major findings are now fixed: concurrent post-sync processors could match a row twice (fixed with a watermark fence), the four-query recompute couldn't handle credit cards or Ready to Assign's earlier totals (fixed by grouping by card account and storing running totals in month snapshots), and transactions pending at link were never budgeted (fixed by deciding by transaction rather than date). Smaller fixes covered the fence's missing-row case, a retry-safe hand-off, leases held through sleeps, releasing failed runs, and tracking D1 row reads as well as writes.

**Mockup review (Oct 31, 2026).** An independent design review of the first five mobile screens found 5 blockers: no list of past transactions, no settings, no way to assign or move money, card overspending looking the same as cash overspending, and uncategorized spending invisible on Budget. It recommended restructuring into four tabs. The v2 mockups and this revision adopt that, with Needs attention kept as a Budget filter. The owner also replaced the "Owed by roommates" category with general reimbursement links.

**Reimbursement review (Oct 31, 2026).** An independent review of reimbursement links found 3 blockers: taking fronted money from Ready to Assign made it go negative every month for a zero-based budget; an unmatched repayment could be counted twice; and short or unpaid amounts could never be closed. It also found 12 major gaps, including mixed Venmo cash-outs, card fronting, refunds mistaken for repayments, and no undo. The owner chose the reviewer's fix (an app-made Owed to you category), tracking by amount only, and closing unpaid amounts to the original category. The revised section above covers all of it.

**Full design and prototype review (Oct 31, 2026).** Two independent reviewers, one on this doc and one on the prototype, both said Revise. Fixed in this revision:

- **Money rules.** They are now exact formulas (Money rules in the spec tab): card starting balances no longer touch Ready to Assign; the starting balance at link is confirmed by you and drift-checked; Owed to you was exempt from the month-end overspending rule (later replaced: see the third review below); refunds give back only what was set aside; the funded split follows date order; month rollover recomputes on first read.
- **Daily maintenance job.** It now has a real scheduler, the third cron trigger.
- **Backups and monitoring.** They are watched from both sides (keepalive workflow plus an in-app watchdog), and the backup key is kept offline.
- **D1 usage.** It is read account-wide from Cloudflare's analytics.
- **Smaller fixes.** The email digest is removed (it needed a domain); Plaid slot checks are tightened; deploy tokens are limited to one Worker each; the stale thresholds and text are fixed.

Your decisions: unmatched person-to-person money is held in Waiting to match until you choose; savings accounts are inside the budget.

**Third review and follow-up decisions (Oct 31, 2026).** A third independent review found the prototype breaking several money rules (card debt subtracted from starting Ready to Assign, the Dining shortfall on the wrong card under date order, Low statuses that didn't follow the Low rule) and gaps the doc left open. Fixed in both. The owner then decided: Owed to you is no longer a funded category; fronted money comes out of Ready to Assign and paybacks go back to it. This knowingly accepts the dip the earlier reimbursement review warned about (Ready to Assign drops by the fronted amount until it's paid back), in exchange for one less category and a Ready to Assign that always matches spendable cash. Other decisions: pending deposits count in Ready to Assign immediately; bills are never Low; rewards go to Ready to Assign; late paybacks show in Budget's Needs attention; there are no manual assets; bank connections are managed only in Settings.

**Build plan**

1. Foundations: repo, CI, security workflows, Access-protected Worker with GitHub sign-in, D1 migrations, budget-scoped data layer, health monitor. **Go/no-go:** run one Sandbox sync step, the page-by-page apply of a 3,000-transaction backfill, and an edit to the first budget month after 36 simulated months (CPU, D1 queries and rows written), all on the free plan; if anything exceeds about 5 ms of CPU or 40 queries, redesign that part before continuing.
2. Domain core: money, budget start, RTA, forward summary recompute, targets, rules engine, pending and re-issue matcher, payee normalizer, all as pure tested code.
3. Bank layer: provider port, fake and Plaid Sandbox adapters, event log, staged sync with leases, webhooks.
4. Budget UI: Budget, Inbox, Pending, Accounts; then Needs Attention.
5. Go live: backups and monitoring running first; confirm the history window; link the first 1–2 Items in Production from a desktop browser; run beside your current budgeting tool for a month and reconcile.
6. Analytics, net worth, reimbursements, payee merge, past history import.

**MCPs and tools for the design and build**

| Tool | Used here? | What it's for |
| --- | --- | --- |
| Cloudflare Developer Platform MCP | Yes: docs search for free-tier limits, Access and D1 | Later: create D1 databases, inspect Workers and bindings |
| Plaid Developer Tools MCP | Yes: confirmed your team and that no Production Items are in use | Later: `plaid_debug_item` for broken connections, usage checks against the 10-Item cap |
| Plaid Sandbox MCP and docs assistant ([ai-coding-toolkit](https://github.com/plaid/ai-coding-toolkit/tree/main/sandbox)) | Recommended | Generate Sandbox Items and test transactions while building the adapter |
| GitHub MCP | Recommended | Create the repo, rulesets, environments and secrets from the design |
| Playwright MCP | Recommended | Drive and screenshot the UI during development |
| Claude Design | Recommended | Clickable mockups of the views before frontend work |

Sources: [Plaid Trial plan](https://plaid.com/docs/account/billing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
