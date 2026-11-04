# Payees and categories: suggest, then OK

Status: proposal, v2, Nov 4, 2026. Nothing is built yet. This replaces v1–v1.2 of this doc (a duplicate-review
page with rule rewrites), which the owner turned down in favour of something simpler; section 12 says what was
dropped and why.

The owner's choices (Nov 3–4, 2026):

1. New transactions get a **suggested** category, and you OK it. Nothing is filled in without your OK, even for a
   payee that always gets the same category.
2. **Rules are removed.** The owner has never used them; a rule-like feature can come back if it's ever needed.
3. **Rename = merge.** Renaming a payee to a name another payee already has joins them, with Undo. No duplicate
   finder, no Review page, no multi-select.
4. **Payee names are suggested, not cleaned up behind your back.** A bank text you've named before gets your name
   automatically. A bank text the app hasn't seen comes with a suggested name that you OK or change.
5. **The Payees page leaves out payees that only have transactions from before the budget started.**

**Does this change how money is counted?** No. No Money rule changes (`docs/sync-spec.md`). Today a rule or a
remembered category could set a category with no step for you; after this, a category only ever comes from your
own tap. Removing rules and the remembered category takes away automatic categorizing, it doesn't add any.

## 1. How it works today

| Fact                        | Today                                                                                                                                                                                                                                                                                                                                                      | Where                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Payee from bank text        | Sync looks up a Plaid merchant id first, then a cleaned description key (store numbers, dates, card digits stripped). The first time it sees neither, it makes a payee and an alias, named after Plaid's clean merchant name or the cleaned text in title case. A later transaction with the same key gets the same payee, under whatever name you gave it | `apps/worker/src/sync/process.ts`, step 5; `packages/domain/src/payee.ts` |
| Automatic categories        | Rules (Settings → Rules, or **Always** in the toast after categorizing one transaction), then the payee's remembered category. The remembered category never applies: nothing in the app ever saves `payee.default_category_id`                                                                                                                            | `packages/domain/src/rules.ts`, `process.ts`                              |
| Needs category              | Each uncategorized row has **Choose**; the picker lists the categories you've used for this payee first ("Every past Lyft" or "You've used for Amazon"), in the order first used. **Select** categorizes several at once. Works offline                                                                                                                    | `apps/web/src/screens/ActivityNeeds.tsx`, `routes/activity.ts`            |
| Payees page                 | Every merge suggestion as a large card above the list; then up to 300 payees, each with a Rename button. Payees with only history are listed too                                                                                                                                                                                                           | `apps/web/src/screens/settings/Payees.tsx`, `routes/settings/payees.ts`   |
| Rename sheet                | Show as, the bank names (empty unless the payee is in a suggestion), and a drop-down to merge into another payee                                                                                                                                                                                                                                           | `components/RenamePayee.tsx`                                              |
| Renaming from a transaction | Renames the whole payee, works offline. The sheet finds the payee by name, and turns on its remembered category (`remember: true`) without saying so                                                                                                                                                                                                       | `screens/TxnSheets.tsx`, `routes/activity.ts`                             |
| Merge                       | Keeps the first id, moves aliases and transactions to it, marks the others merged. Ids aren't checked (`[X, X]` hides X). No undo                                                                                                                                                                                                                          | `POST /api/settings/payees/merge`                                         |
| Payment apps                | Plaid gives Venmo, Zelle and similar one merchant id, so every payment through one app is one payee, whoever it went to                                                                                                                                                                                                                                    | `process.ts` (merchant id looked up first)                                |
| History                     | A transaction dated before its account's budget start, and not pending when the account was linked, is history: shown, never budgeted                                                                                                                                                                                                                      | `docs/design.md`, Budget start                                            |

## 2. Categories: suggest, then OK

### 2.1 The suggestion

For each row in Needs category, the suggested category is the one **you** have used most for this payee
(transactions where `categorized_by = 'user'`, history included, splits not counted). A tie goes to the one used
most recently. Inflows count Ready to Assign as a choice, so a paycheck suggests Ready to Assign. A payee you've
never categorized has no suggestion.

It is worked out when Activity is shown (the route already reads each payee's past categories), so nothing new
is stored, and it runs on the phone like the rest of Activity.

### 2.2 The row

```
┌──────────────────────────────────────┐
│ NEEDS CATEGORY      4 · −$61.20  OK all│
│ ┌──────────────────────────────────┐ │
│ │ Blue Bottle Coffee       −$6.50  │ │
│ │ Chase Sapphire · Nov 3           │ │
│ │                 [Coffee] [ ✓ OK ]│ │
│ ├──────────────────────────────────┤ │
│ │ Amazon                  −$34.20  │ │
│ │ Amex · Nov 3                     │ │
│ │              [Household] [ ✓ OK ]│ │
│ ├──────────────────────────────────┤ │
│ │ Bluebottle Coffee        −$5.75  │ │
│ │ New payee · BLUEBOTTLE COFFEE    │ │
│ │                        [Choose]  │ │
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

- A row with a suggestion shows it as a pill (outline tone) and an **OK** button (soft, 44 px). **OK** categorizes
  with the suggestion, exactly as if you had picked it: the same toast with Undo, `categorized_by = 'user'`.
  Tapping the pill opens the picker to choose something else.
- A row without a suggestion shows **Choose**, as now.
- **OK all** (a `TextButton` in the section title, shown when two or more rows have a suggestion) categorizes
  every row that has one, with one toast: "12 transactions categorized" · Undo. Rows without a suggestion stay.
- **Select** stays for choosing one category for several rows.
- OK and OK all work offline, like categorizing does today.

### 2.3 The picker

The "Usually" list at the top lists this payee's past categories **most used first**, with the count: "Coffee ·
14", "Dining out · 2". The title stays "You've used for _payee_".

### 2.4 What goes

- **The remembered category** (`payee.remember_category`, `default_category_id`): never worked; its switch and
  "usually" text go from the Rename sheet and the payee list. The columns stay (migrations are forward-only) but
  nothing reads them. The Payees list's "usually _category_" uses the suggestion from 2.1 instead.
- **The Always offer** in the categorize toast.

## 3. Removing rules

- **Gone:** Settings → Rules and the rule editor; the Settings row; the **Always** offer; the rules routes
  (`routes/settings/rules.ts`); the "Rules (JSON)" export; sync's rule step. Sync still finds the payee,
  transfers and Waiting to match exactly as now (`process.ts` step 5), then leaves the category empty.
- **Kept:** the `rule` table and `txn_overlay.rule_id` (forward-only migrations). Transactions a rule already
  categorized keep their category, and their "set by rule" chip still shows.
- **Rules you may have:** any rule made with Always stops applying to new transactions. The suggestion (2.1)
  takes over, since the category you made the rule from is the payee's most used one.
- **Domain code:** `evaluateRules` and the rule types go from `packages/domain`, with their tests. The matcher
  file keeps what it shares with matching.
- A new decision (`docs/decisions/D-?-no-rules.md`) records this and the "What's true now" tables in
  `docs/design.md` and `docs/sync-spec.md` get a row: the design's rules, rule preview, rule-made splits,
  transfers and paybacks ("2/3 of rent") are replaced by suggest-then-OK; Money rule 13 (projected fronts) still
  applies to owed items you mark yourself.

## 4. Payee names: automatic when known, suggested when new

### 4.1 Known bank text

Unchanged: a transaction whose key matches an alias gets that payee, under your name for it. Once you rename a
payee, every later transaction with the same key shows your name. Nothing to OK.

### 4.2 New bank text

Sync makes a payee for it, as now, named after Plaid's clean merchant name or the tidied text. The row shows
**New payee** and the bank text in its second line, so you can see what it was (2.2).

- **OK, Choose or Select** on the row categorizes it; the name stands as it is.
- **To change the name,** open the transaction and tap Rename payee (section 5). Picking or typing an existing
  payee's name joins them.

### 4.3 Suggested join

When a new payee's name is the same as an existing payee's name (any case, spaces trimmed), the row says so
instead of "New payee":

```
│ │ Blue Bottle Coffee       −$5.75  │ │
│ │ Same as your Blue Bottle Coffee? │ │
│ │ BLUEBOTTLE COFFEE                │ │
│ │                 [Coffee] [ ✓ OK ]│ │
```

The suggested category is the existing payee's (2.1). **OK** joins the two payees (rename = merge, section 5)
and categorizes the row, with one toast and one Undo. Choosing a different category from the pill also joins.
To keep them apart, open the transaction and rename the payee. Offline, OK categorizes but doesn't join: the
"Same as" line stays until there's a connection.

Only exact names are suggested. Similar names ("Bluebottle Coffee" and "Blue Bottle Coffee") aren't, so a
suggestion is never a guess between two different stores; you join those by renaming.

### 4.4 Payment apps

For Venmo, Zelle, Cash App, PayPal and Apple Cash, sync stops using Plaid's merchant id and uses the cleaned bank
text, so each person you pay becomes their own payee when the bank text names them. When it doesn't (some banks
show only a reference number), every payment through that app still lands on one payee, as now. Existing
payees aren't touched; only new transactions follow this. The list of apps lives in `packages/domain/src/payee.ts`
and matches Plaid's merchant name or the start of the bank text.

## 5. Rename = merge

### 5.1 The Rename sheet

One sheet, opened from a transaction (Rename payee) or from the Payees page (a row).

```
┌──────────────────────────────────────┐
│ Rename payee                       ✕ │
│ Show as [Blue Bottle Coffee        ] │
│ You have a payee named Blue Bottle   │
│ Coffee. Saving joins them.           │
│                                      │
│ BANK NAMES                           │
│ ┌──────────────────────────────────┐ │
│ │ BLUEBOTTLE COFFEE              4 │ │
│ └──────────────────────────────────┘ │
│ The bank's own text stays on each    │
│ transaction.                         │
│ ─────────────────────────────────────│
│ [ Join payees                      ] │
└──────────────────────────────────────┘
```

- **Show as.** Typing a name another payee already has (any case, spaces trimmed) shows "You have a payee named
  _X_. Saving joins them." and the button becomes **Join payees**. Otherwise it's **Save name**.
- Under the field, as you type, up to 3 existing payees whose names start with what you've typed, as tappable
  chips, so joining doesn't depend on spelling the name exactly.
- **Bank names:** this payee's aliases, each with its transaction count and the most common raw text behind it.
  Always filled in (today it's usually empty).
- The merge drop-down and the remember switch go.
- After **Join payees**: the toast "Joined into Blue Bottle Coffee" · Undo.
- Offline: a plain rename works as today; joining needs a connection, so the button reads "Joining needs a
  connection" and is disabled.

### 5.2 What a join does

`POST /api/settings/payees/merge { keep, ids }`, where `keep` is the existing payee whose name you chose:

1. Checks `keep` is in `ids`, the ids are distinct, exist, and none is merged away; otherwise 409 ("This payee
   changed. Pull to refresh.").
2. Moves aliases and transactions to `keep`, marks the others merged, and keeps `keep`'s name.
3. Writes the audit row with a `before`: each payee's name and the aliases that moved.

**Undo** (`POST /api/settings/payees/merge/:auditId/undo`, from the toast) works while neither payee changed
since. It puts the names and aliases back, then sends each of `keep`'s transactions back to the payee its key now
resolves to, with the same lookup sync uses (shared as one function). So transactions that synced in between go
back too. If something changed, it says "Can't undo now: this payee changed since."

The old `{ ids, name }` body is accepted for one release so an app that hasn't reloaded keeps working.

### 5.3 Fixes on the way

- The Rename-from-transaction sheet finds the payee by id, not by name, and no longer sends `remember: true`.
- A rename queued offline that reaches the server after its payee was merged away gets 409 instead of renaming
  the payee it was merged into; the phone drops it and says so, as for other refused offline edits.

## 6. The Payees page

`/settings/payees`, a page with `BackHeader` "Payees".

```
┌──────────────────────────────────────┐
│ ‹ Settings   Payees                  │
│ [🔍 Search payees                  ] │
│ ┌──────────────────────────────────┐ │
│ │ Blue Bottle Coffee               │ │
│ │ 23 transactions · usually Coffee │ │
│ ├──────────────────────────────────┤ │
│ │ Trader Joe's                     │ │
│ │ 19 transactions · usually Groc…  │ │
│ └──────────────────────────────────┘ │
│ Rename a payee to another payee's    │
│ name to join them.                   │
└──────────────────────────────────────┘
```

- **Which payees:** those with at least one transaction from the budget onward. A payee whose transactions are
  all history (before its account's budget start, and not pending at link) isn't listed. It comes back by itself
  if a new transaction arrives for it.
- **Rows:** name; "_n_ transaction(s)", counting only budget transactions; "usually _category_" from 2.1, left
  out when there is none. Tapping a row opens the Rename sheet (a sheet, so no chevron, D-55). No buttons on rows.
- **Search** covers every listed payee (no 300 limit) and the bank text behind each, so "SQ \*BLUE" finds Blue
  Bottle Coffee.
- **Gone:** the suggestion cards, Keep separate, and the duplicate finder behind them (`clusterPayees`), which
  also measured about 18 ms per run, over the 10 ms rule.
- **States:** `Loading`; `EmptyNote` "No payee matches." or "No payees yet."; `ErrorNote`.

`GET /api/settings/payees` returns `payees[]` only (`id`, `name`, `transactions`, `usual`); `suggestions` goes
from the contract. The Rename sheet reads `GET /api/settings/payees/:id` (aliases with counts and an example).

## 7. Limits

- **CPU (10 ms).** Activity already reads past categories per payee; counting them adds no query. The Payees view
  becomes two grouped counts (budget transactions, user categories) with no clustering. The per-payee route reads
  one payee's rows. Measure Activity and Payees with the measurement set and record them in
  `docs/measurements.md`.
- **Phone.** Every read here runs on the local copy; `engine.test.ts` already compares `/api/settings/payees` and
  Activity, and gains cases for suggestions, a join and its undo. No new synced tables, no migration.
- **Usage events.** Fixed ids only: `activity.category.ok`, `activity.category.ok_all`, `payee.join`,
  `payee.join.undo`; never names.
- **Accessibility.** OK's label names the row: "OK Coffee for Blue Bottle Coffee −$6.50". OK all's toast is
  `role="status"`.

## 8. Plan

Four PRs, none with a migration:

1. **Remove rules** (section 3), with the decision and the "What's true now" rows.
2. **Suggest, then OK** (section 2): the suggestion, OK, OK all, the picker order; the remembered category goes.
3. **Payees page and rename = merge** (sections 5 and 6): the plain list without history, search across bank
   text, the Rename sheet with joining and Undo, the fixes in 5.3.
4. **New payees** (section 4): "New payee" and the bank text on rows, the suggested join, payment apps.

Tests: domain tests for the suggestion (most used, tie by date, inflows, splits ignored) and the payment-app list;
API tests for merge validation, undo after a sync added rows, undo refused after a change, the Payees view
leaving out history-only payees; `engine.test.ts` as above; e2e (mock) for OK, OK all with Undo, and joining by
rename on an iPhone-sized viewport. Existing rules tests and e2e go with the feature.

## 9. Questions for the owner

1. **OK all:** keep it? It confirms every suggested row in one tap (with Undo). Proposal: keep.
2. **Payment apps (4.4):** okay to treat each person you pay through Venmo or Zelle as their own payee, when the
   bank text names them?

## 10. Not in this change

Similar-name join suggestions; categories suggested from the amount or account; payees for manual transactions;
merging past history-only payees; deleting payees.

## 11. Review

_To be added._

## 12. What v1 proposed, and why it was dropped

v1–v1.2 kept rules and built a duplicate finder: a Review page that grouped similar payees, merges with a
chosen name and category, "Not the same", rules rewritten on every merge, and a split. Its adversarial review
found that rewriting rules on a merge changes which category later transactions get, and that the duplicate
finder already runs over the 10 ms rule. The owner then chose a simpler model: no rules, categories suggested
and OK'd, duplicates joined by renaming. That removes both problems and most of the new code.
