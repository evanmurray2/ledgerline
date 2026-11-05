# Payees and categories: suggest, then OK

Status: built, v2.2, Nov 4, 2026 (PRs #45, #46, #48 and the "New payees" PR). This replaces v1–v1.2 of this doc (a duplicate-review
page with rule rewrites), which the owner turned down in favour of something simpler; section 12 says what was
dropped and why. v2 got an adversarial review (2 blockers, 5 major, 6 minor); v2.1 includes its fixes, listed in
section 11.

The owner's choices (Nov 3–4, 2026):

1. New transactions get a **suggested** category, and you OK it. Nothing is filled in without your OK, even for a
   payee that always gets the same category.
2. **Rules are removed.** The owner has never used them; a rule-like feature can come back if it's ever needed.
3. **Rename = merge.** Renaming a payee to a name another payee already has joins them, with Undo. No duplicate
   finder, no Review page, no multi-select.
4. **Payee names are suggested, not cleaned up behind your back.** A bank text you've named before gets your name
   automatically. A bank text the app hasn't seen arrives under a suggested name that you keep or change.
5. **The Payees page leaves out payees that only have transactions from before the budget started.**

**Does this change how money is counted?** Not if the owner has no rules today. Suggestions only fill in what you
OK, and no Money rule changes (`docs/sync-spec.md`). But rules can do more than set a category: a rule can split
a transaction, mark part of it as owed to you, mark it as a transfer, or count it in the previous month (the
design's rent rule does the last two). Removing rules stops all of that for new transactions. The owner checked:
Settings → Rules shows 0 rules (section 9), so nothing changes.

## 1. How it works today

| Fact                        | Today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Where                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Payee from bank text        | Sync files a new row by Plaid's values, compared only by `payeeNameKey`: the first of its keys (Plaid's merchant id, `merchant_name`, Plaid's `name`; the bank text when neither name is there) that a payee has decides; otherwise it makes a payee named `merchant_name`, else Plaid's `name`, else the bank text exactly, and gives the payee every key no payee has yet. A filed row never moves, and sync never joins two payees. A posted row keeps the payee of the pending row it replaces. Renaming or joining gives the payee the key of its new name (`docs/payee-names.md` 4–6) | `apps/worker/src/sync/file-fresh.ts`, `sync/payee-keys.ts`; `packages/domain/src/payee.ts` |
| Automatic categories        | Rules (Settings → Rules, or **Always** in the toast after categorizing one transaction), then the payee's remembered category. The remembered category never applies: nothing in the app ever saves `payee.default_category_id`. Rules can also split, mark owed, mark a transfer, set a memo or count in the previous month                                                                                                                                                                                                                                                                | `packages/domain/src/rules.ts`, `process.ts`                                               |
| Needs category              | Each uncategorized row has **Choose** to the right of the payee; the picker lists the categories you've used for this payee first ("Every past Lyft" or "You've used for Amazon"), in the order first used. **Select** categorizes several at once. Works offline                                                                                                                                                                                                                                                                                                                           | `apps/web/src/screens/ActivityNeeds.tsx`, `routes/activity.ts`                             |
| Payees page                 | Every merge suggestion as a large card above the list; then up to 300 payees, each with a Rename button. Payees with only history are listed too                                                                                                                                                                                                                                                                                                                                                                                                                                            | `apps/web/src/screens/settings/Payees.tsx`, `routes/settings/payees.ts`                    |
| Rename sheet                | Show as, the bank names (empty unless the payee is in a suggestion), and a drop-down to merge into another payee                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `components/RenamePayee.tsx`                                                               |
| Renaming from a transaction | Finds the payee by name in the payee list, then renames it with `POST /settings/payees/:id` and `remember: true`, turning on its remembered category without saying so. That route isn't an offline edit, so offline renaming works only on the fallback `PATCH /transactions/:key { payeeName }`, which renames whatever payee the transaction has when the edit arrives                                                                                                                                                                                                                   | `screens/TxnSheets.tsx`, `routes/activity.ts`, `copy/copy.ts`                              |
| Merge                       | Keeps the first id, moves aliases and transactions to it, marks the others merged. Ids aren't checked (`[X, X]` hides X). No undo                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `POST /api/settings/payees/merge`                                                          |
| History                     | A transaction dated before its account's budget start, and not pending when the account was linked, is history: shown, never budgeted                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `docs/design.md`, Budget start; `ATTENTION_SQL` in `routes/activity.ts`                    |

## 2. Categories: suggest, then OK

**Now (Nov 4 design critique):** on screen, the suggestion reads as text with a pencil ("Shopping ✎", tap to choose another) under the row, and the OK button says what it does: **Use Shopping**; OK all reads **Use 2 suggestions**. The behaviour below is unchanged.

### 2.1 The suggestion

For each row in Needs category, the suggested category is the one **you** have used most for this payee, in the
same direction:

- Counted: transactions with `categorized_by = 'user'`, history included. Split rows aren't counted.
- Money out and money in are counted apart. For money in, Ready to Assign (`to_rta`) counts as a choice, so a
  paycheck suggests Ready to Assign; for money out it never does.
- Archived categories and card payment categories are skipped; the next most used one is suggested instead.
- A tie goes to the one set most recently (`txn_overlay.updated_at`).
- A payee you've never categorized in that direction has no suggestion.

It's one grouped query, replacing the row-by-row history read Activity does today:

```sql
SELECT payee_id, amount < 0 AS out, category_id, to_rta, count(*) AS n, max(o.updated_at) AS last
FROM txn_overlay o JOIN bank_txn b ON b.txn_key = o.txn_key   -- and the manual rows' amounts
WHERE o.budget_id = ?1 AND o.categorized_by = 'user' AND o.payee_id IN (…)
GROUP BY payee_id, out, category_id, to_rta
```

Nothing new is stored. It runs on the phone like the rest of Activity, and on the server too, where `/api/activity`
is already over the 10 ms gate at p95 (`docs/measurements.md`); measure it before and after, and keep it from
adding to that.

**Strong** suggestions: used at least twice, and for more than half of that payee's rows in that direction. Only
strong ones are included in OK all (2.2).

### 2.2 The row

The row keeps today's layout, payee and amount on top and account and date below, with one more line on the
right for the controls:

```
┌──────────────────────────────────────┐
│ NEEDS CATEGORY        4 · −$61.20    │
│                              Select  │
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
│ │ New · BLUEBOTTLE COFFEE          │ │
│ │                        [Choose]  │ │
│ └──────────────────────────────────┘ │
│ [ OK 2 suggestions                 ] │
└──────────────────────────────────────┘
```

- A row with a suggestion shows the category as an outline pill and **OK** as a filled pill (44 px tall; D-55:
  the one main step in a card). **OK** categorizes with the suggestion, exactly as if you had picked it: the same
  toast with Undo and the same overspent warning, `categorized_by = 'user'`. Tapping the category pill opens the
  picker to choose something else. Long category names truncate at 140 px.
- A row without a suggestion shows **Choose**, as now.
- **OK all** is a full-width `SecondaryButton` under the list, "OK 12 suggestions", shown when two or more rows
  have a strong suggestion. It applies only to rows shown (under the current search) with a strong suggestion,
  sends one categorize request per category, and shows one toast: "12 transactions categorized · 1 category
  now overspent" with Undo. Rows with a weaker suggestion keep their own OK.
- **Select** stays for one category for several rows.
- OK and OK all work offline, like categorizing does today (one queued edit per category).
- The server rejects `toRta` on money out (today `/transactions/categorize` accepts it) and archived categories.

### 2.3 The picker

The "Usually" list at the top lists this payee's past categories in this direction, **most used first**, with the
count: "Coffee · 14", "Dining out · 2". The title stays "You've used for _payee_". For money in, Ready to Assign
appears in the list when it has been used.

### 2.4 What goes

- **The remembered category** (`payee.remember_category`, `default_category_id`): never worked; its switch and
  "usually" text go from the Rename sheet and the payee list. The columns stay (migrations are forward-only) but
  nothing reads them. The Payees list's "usually _category_" uses the suggestion from 2.1 instead.
- **The Always offer** in the categorize toast, and `shouldOfferAlways` with it.

## 3. Removing rules

Before this PR, the owner checks Settings → Rules (section 9). If there are none, nothing below changes any
money.

- **Gone:**
  - Settings → Rules, the rule editor and its Settings row.
  - The **Always** offer.
  - The rules routes (`routes/settings/rules.ts`) and the "Rules (JSON)" export: its path in `routes/api.ts` and
    its copy in `Data.tsx` ("Full export, including rules and payee merges" becomes "…including payee merges").
  - Sync's rule step. Sync still finds the payee, transfers and Waiting to match exactly as now (`process.ts`
    step 5), then leaves the category empty; its "did a rule set a category" branch goes.
  - `evaluateRules` and the rule types from `packages/domain`. `rules-matcher.test.ts` is split, keeping the
    matcher's tests.
  - The rules part of the category-in-use check (`routes/settings/categories.ts`), which counts rules and payee
    defaults and so stops a category being deleted; it now counts neither.
  - Rules in the mock server, the dev seed (the rent rule), `engine.test.ts`'s rules route, `sync.test.ts` and
    `pending-match.test.ts` cases that use rules, and the e2e and screenshot tests for the Rules screen.
- **Kept:** the `rule` table and `txn_overlay.rule_id` (forward-only migrations). Transactions a rule already
  categorized keep their category, and their "set by rule" chip still shows.
- **Rules you may have:** a rule made with Always stops applying to new transactions. The suggestion (2.1) takes
  over, since the category you made the rule from is the payee's most used one.
- **Docs:** a new decision (`docs/decisions/D-67-no-rules.md`), and entries in `docs/whats-true-now.md` (D-59) for
  `docs/design.md` (Categorization rules; rule-made paybacks such as the rent rule; the Rules settings screen)
  and `docs/sync-spec.md` (rule results in the processing batch). Money rule 13 (projected fronts) still applies
  to owed items you mark yourself.

## 4. Payee names: automatic when known, suggested when new

### 4.1 Known bank text

Unchanged: a transaction whose key matches an alias gets that payee, under your name for it. Once you rename a
payee, every later transaction with the same key shows your name. Nothing to OK.

### 4.2 New bank text

Sync makes a payee for it, named after Plaid's merchant name, else Plaid's name, else the bank text exactly as sent
(no tidy step; `docs/payee-names.md` 5). That name is the suggestion.

A payee is **new** while sync named it (`payee.named_by = 'sync'`) and you haven't categorized any of its
transactions (no `categorized_by = 'user'` rows; it falls out of the 2.1 query). A new payee's row says **New** and
shows the bank text in its second line, so you can see where the name came from (2.2). While it's new, its name
follows the row that made it (its earliest transaction) when Plaid sends that row again with a better name, unless
another payee has that name (`docs/payee-names.md` 6).

- **OK, Choose or Select** categorizes the row and keeps the name; sync never changes it again.
- **To change the name,** open the transaction and tap Rename payee (section 5). Picking or typing an existing
  payee's name joins them. A rename or join also fixes the name.

### 4.3 Suggested join

When a new payee's name is the same as the name of a payee you **have** categorized (any case, spaces trimmed,
curly and straight apostrophes treated the same), the row says so, with its own action:

```
│ │ Blue Bottle Coffee       −$5.75  │ │
│ │ Same as your Blue Bottle Coffee? │ │
│ │ Join · BLUEBOTTLE COFFEE         │ │
│ │                 [Coffee] [ ✓ OK ]│ │
```

- **Join** (a `TextButton`) joins the new payee into yours (section 5.2), with its own toast and Undo. It needs a
  connection; offline, the "Same as" line isn't shown.
- **OK** only categorizes. Its suggestion is your payee's (2.1), since that's the likely one.
- After a join, Activity is fetched again, so other rows of the same new payee show your payee too.
- If you OK without joining, the payee stops being new and the line goes; you can still join later by renaming.
- Rows with a "Same as" line aren't included in OK all.

Only exact names are suggested. Similar names ("Bluebottle Coffee" and "Blue Bottle Coffee") aren't, so a
suggestion is never a guess between two different stores; you join those by renaming.

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

- **Show as.** Typing a name another payee already has (any case, spaces trimmed, apostrophes alike) shows "You
  have a payee named _X_. Saving joins them." and the button becomes **Join payees**. Otherwise it's **Save
  name**. The check covers every payee that isn't merged away, including history-only ones the Payees page
  doesn't list, and the server checks again on save.
- Under the field, as you type, up to 3 existing payees whose names start with what you've typed, as tappable
  chips, so joining doesn't depend on spelling the name exactly.
- **Bank names:** the bank's own texts behind this payee's budget transactions (up to 10, most used first), each
  with its transaction count. Rows before the budget start ("Before your budget") don't count, as on the Payees
  page. Always filled in (it used to be empty for most payees).
- The merge drop-down and the remember switch go.
- After **Join payees**: the toast "Joined into Blue Bottle Coffee" · Undo.
- Offline: a plain rename works (5.3); joining needs a connection, so the button reads "Joining needs a
  connection" and is disabled.

### 5.2 What a join does

`POST /api/settings/payees/merge { keep, ids }`, where `keep` is the existing payee whose name you chose:

1. Checks `keep` is in `ids`, the ids are distinct, exist, and none is merged away; otherwise 409 ("This payee
   changed. Pull to refresh.").
2. Moves aliases and transactions to `keep`, marks the others merged, and keeps `keep`'s name.
3. Writes the audit row. Its `before` lists each payee's name and `updated_at`, the ids of the aliases that moved
   and which payee each pointed at, and the `txn_key`s that moved from each payee. The audit log isn't synced to
   the phone, so its size (up to some 100 KB for a payee with thousands of transactions) stays on the server.

**Undo** (`POST /api/settings/payees/merge/:auditId/undo`, from the toast) works while nothing changed since: no
payee in the join has a later `updated_at` or a later join, and `keep` wasn't joined into another payee.
Otherwise it says "Can't undo now: this payee changed since." When it works it:

1. Puts back the names, `merged_into = NULL` and each moved alias's payee.
2. Moves exactly the listed `txn_key`s back to their payees.
3. For rows that synced in after the join, it works out their key and, if it matches one of the moved aliases,
   moves them to that alias's payee; any other row stays on `keep`.

The old `{ ids, name }` body is accepted for one release, treated as `keep = ids[0]`, so an app that hasn't
reloaded keeps working.

### 5.3 Renaming offline, and other fixes

- `TxnSheet` gains `payeeId`, and the Rename-from-transaction sheet uses it instead of finding the payee by name.
  It no longer sends `remember: true`.
- The payee rename route joins the offline edits (`OFFLINE_EDITS` in `copy.ts`), so renaming from a transaction
  works offline through one path. Its body names the payee id, so a rename queued before a join that reaches the
  server after it gets 409 instead of renaming the payee it was joined into; the phone drops it and says so, as
  for other refused offline edits. `PATCH … { payeeName }` stays for manual entries, which have no payee.

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

- **Which payees:** those with at least one transaction from the budget onward. History is decided by the same
  test Activity uses (`ATTENTION_SQL`: dated before the account's budget start and not pending at link); a payee
  whose transactions are all history isn't listed. It comes back by itself if a new transaction arrives for it.
  Payees with no transactions at all (left behind when a bank row is processed again) aren't listed either.
- **Rows:** name; "_n_ transaction(s)", counting only budget transactions; "usually _category_" for money out from
  2.1, left out when there is none. Tapping a row opens the Rename sheet (a sheet, so no chevron, D-55). No
  buttons on rows.
- **Search** covers every listed payee (no 300 limit) and the bank text behind each, so "SQ \*BLUE" finds Blue
  Bottle Coffee.
- **Gone:** the suggestion cards, Keep separate, and the duplicate finder behind them (`clusterPayees`), which
  also measured about 18 ms per run, over the 10 ms rule.
- **States:** `Loading`; `EmptyNote` "No payee matches." or "No payees yet."; `ErrorNote`.

`GET /api/settings/payees` returns `payees[]` (`id`, `name`, `transactions`, `usual`). `suggestions` and
`remember` stay in the contract as optional for one release (always empty), so an app that hasn't reloaded keeps
working. The Rename sheet reads `GET /api/settings/payees/:id`: its aliases, each with a count and an example,
worked out by grouping the payee's distinct bank texts in SQL first and cleaning each distinct text once.

## 7. Limits

- **CPU (10 ms).** Activity's past-category read becomes one grouped query (2.1), plus one read of the categorized
  payees' names for "Same as". The Payees view is two grouped counts with no clustering. The per-payee route reads
  one payee's rows. Measure Activity (already over the gate on the server) and Payees with the measurement set and
  record them in `docs/measurements.md`.
- **Phone.** Every read here runs on the local copy; `engine.test.ts` already compares `/api/settings/payees` and
  Activity, and gains cases for suggestions (both directions, archived skipped), a join and its undo. No new
  synced tables, no migration.
- **Usage events.** Fixed ids only: `activity.category.ok`, `activity.category.ok_all`, `activity.payee.join`,
  `payee.join`, `payee.join.undo`; never names.
- **Accessibility.** OK's label names the row: "OK Coffee for Blue Bottle Coffee −$6.50". Join's label names
  both payees. Toasts are `role="status"`.

## 8. Plan

Four PRs, none with a migration, in this order so there's never a stretch with neither rules nor suggestions:

1. **Suggest, then OK** (section 2): the grouped query, OK, OK all, the picker order, the server checks; the
   remembered category and the Always offer go.
2. **Remove rules** (section 3), after the owner's check, with the decision and the `docs/whats-true-now.md` entries.
3. **Payees page and rename = merge** (sections 5 and 6): the plain list without history, search across bank
   text, the Rename sheet with joining and Undo, offline renaming by payee id.
4. **New payees** (section 4): "New" and the bank text on rows, the suggested join.

Tests: domain tests for the suggestion (most used, tie by date, directions, Ready to Assign only for money in,
archived and card payment skipped, splits ignored, strong vs weak); API tests for merge validation, undo of the
listed rows plus rows synced since, undo refused after a change, the server's name check including history-only
payees, the Payees view leaving out history-only payees, `toRta` refused on money out; `engine.test.ts` as above;
e2e (mock) for OK, OK all with Undo, Join, and joining by rename at iPhone size. Rules tests and e2e go with the
feature.

## 9. The owner's answers (Nov 4, 2026)

1. **Rules:** Settings → Rules shows 0 rules, so removing them changes nothing about any money.
2. **OK all:** keep it.

## 10. Not in this change

- **Payment apps** (Venmo, Zelle, Cash App, PayPal): today every payment through one app is one payee, whoever it
  went to, because Plaid gives the app one merchant id. Splitting them per person needs sync to stop using that
  id, name the payee from the bank text, and keep the existing app payee for payments that don't name a person,
  without the suggested join pulling them back together. It's left for its own change.
- Similar-name join suggestions; categories suggested from the amount or account; payees for manual transactions;
  merging past history-only payees; deleting payees.

## 11. Review (v2 → v2.1)

| #   | Severity | Finding                                                                                                                                                                                                                                                                                         | Change                                                                                                                                                             |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Blocker  | Payment apps per person: sync names new payees after Plaid's merchant name ("Venmo"), so the exact-name join would join them all back; new aliases would also take over the app's merchant id                                                                                                   | Payment apps left for their own change (10)                                                                                                                        |
| 2   | Blocker  | Removing rules also stops splits, owed marks, transfers and previous-month counting that rules can do; "nothing changes how money is counted" wasn't checked                                                                                                                                    | The owner checks Settings → Rules first (intro, 3, 9)                                                                                                              |
| 3   | Major    | Joining on OK: lost offline, two requests behind one Undo, stale rows after a join, consent hidden in a tap                                                                                                                                                                                     | A separate Join action; OK only categorizes; Activity refetched after a join (4.3)                                                                                 |
| 4   | Major    | The suggestion as described couldn't be computed (no Ready to Assign, date or direction in today's query); archived and card payment categories; `toRta` accepted on money out; Activity already over the CPU gate                                                                              | One grouped query by direction with recency; skips; server checks; measure (2.1, 2.2, 7)                                                                           |
| 5   | Major    | Offline rename: the payee route isn't an offline edit, the PATCH renames whatever payee the row has when it arrives, and `TxnSheet` has no payee id                                                                                                                                             | `payeeId` on `TxnSheet`, payee rename as the offline edit, 409 by id; server name check over all payees (1, 5.1, 5.3)                                              |
| 6   | Major    | Undo by re-resolving keys lands rows on the wrong payee (merchant-id aliases, posted rows that keep a pending row's payee)                                                                                                                                                                      | The audit row lists moved keys and aliases; undo restores exactly those, plus rows synced since through the moved aliases (5.2)                                    |
| 7   | Major    | OK all: one category per request, a single toast loses the overspent warning, next to Select, weak suggestions confirmed in bulk                                                                                                                                                                | One request per category, overspent count in the toast, full-width button under the list, only strong suggestions, only visible rows, no "Same as" rows (2.1, 2.2) |
| —   | Minor    | Rules leftovers (category delete check, export path and copy, seed, mock, tests); matcher shares nothing with rules; "new payee" undefined; apostrophes; row layout and pill tone; history test to reuse; orphan payees; cleaning bank text per row; PR order; contract fields dropped too soon | 2.2, 3, 4.2, 6, 8                                                                                                                                                  |

## 12. What v1 proposed, and why it was dropped

v1–v1.2 kept rules and built a duplicate finder: a Review page that grouped similar payees, merges with a chosen
name and category, "Not the same", rules rewritten on every merge, and a split. Its adversarial review found that
rewriting rules on a merge changes which category later transactions get, and that the duplicate finder already
runs over the 10 ms rule. The owner then chose a simpler model: no rules, categories suggested and OK'd,
duplicates joined by renaming. That removes both problems and most of the new code.
