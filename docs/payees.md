# Payees: a calmer page and merging that works

Status: proposal, v1, Nov 3, 2026. Nothing is built yet. The owner asked for a better Payees page because it is
overwhelming and doesn't merge payees well. Section 12 lists the questions for the owner. Sections 13 and 14 hold
the adversarial review and the design critique, and v1.1 will include their fixes.

Nothing here changes how money is counted. A merge or a rename only changes the payee a transaction is shown and
matched under. Categories, amounts and budget months stay the same (section 8.4 covers rules, the one place
where a payee's name can change what a later transaction gets).

## 1. How it works today

| Fact                           | Today                                                                                                                                                                                     | Where                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| A payee                        | A row in `payee` (name, remember-category flag, usual category, `merged_into`), reached from bank rows through `payee_alias` (a cleaned description key or a Plaid merchant id → payee)   | migration 0001                                               |
| Where payees come from         | Sync makes one payee and one alias the first time it sees a key, named after Plaid's merchant name or the cleaned description in title case                                               | `apps/worker/src/sync/process.ts`, step 5                    |
| The list                       | Payees that aren't merged away, most used first, **at most 300**. Search filters those 300 only                                                                                           | `routes/settings/payees.ts`                                  |
| Suggestions                    | `clusterPayees()` groups up to 500 bank descriptions by merchant id, then by trigram similarity ≥ 0.5 to each group's first description; a group is shown when it covers 2 or more payees | `packages/domain/src/payee.ts`                               |
| A suggestion on screen         | A large blue card per group, all stacked above the list: the bank descriptions as chips, "Merge into _name_?", **Keep separate** and **Merge _n_**                                        | `apps/web/src/screens/settings/Payees.tsx`                   |
| Keep separate                  | Hides the card until the page reloads; nothing is saved                                                                                                                                   | same                                                         |
| Merging by hand                | Each row's **Rename** opens the Rename sheet, which ends with "Or merge into an existing payee": a drop-down of every other payee. The merged payee takes the other payee's name          | `RenameSheet` in `Payees.tsx`, `components/RenamePayee.tsx`  |
| What a merge does              | The first id is kept and renamed. Aliases and every transaction's `payee_id` move to it, the others get `merged_into`. One audit row. No undo, no split                                   | `POST /api/settings/payees/merge`                            |
| Bank names on the Rename sheet | Taken from the suggestion the payee is in, so it's empty for almost every payee                                                                                                           | `RenameSheet`                                                |
| Rules                          | "Payee is _X_" stores the **name** _X_ and matches by name (or by id). "Payee contains" matches part of the name. "Set payee" stores an id                                                | `packages/domain/src/rules.ts`, `screens/settings/Rules.tsx` |
| Where the screen is worked out | On the phone, by the server's own route running on the local copy (D-45, D-46); payee changes need a connection (they aren't on the offline list)                                         | `apps/worker/src/local`, `apps/web/src/api/client.ts`        |

## 2. What's wrong

1. **Too much at once.** Every suggestion is a full card, stacked before the list. With 10 groups you scroll
   through 10 blue cards to reach the first payee, and each payee row has its own Rename button.
2. **A suggestion is all or nothing.** You can't take one wrong payee out of a group.
3. **The name is a guess you can't change.** The merged payee is named after the group's first description in
   title case ("Sq Blue Bottle"), not after one of the payees you already named.
4. **The card shows the wrong things.** It lists bank descriptions, but the merge acts on payees. You don't see
   which payees are combined, how many transactions each has, or which usual category wins.
5. **"Keep separate" doesn't stick.** It's back after a reload.
6. **Merging by hand is buried and slow.** It's the last field of the Rename sheet, a drop-down of up to 299
   names (hard on an iPhone), one payee at a time, and the result always takes the other payee's name.
7. **No undo and no split.** A wrong merge can't be taken back. The design (`docs/design.md`, Payee
   normalization) promises merge, split and rename; split was never built.
8. **Rules can quietly stop matching.** "Payee is Lyft" stores the name. Merge Lyft into "Rideshare", or rename it,
   and the rule no longer matches new Lyft rides. The sheet says "Rules follow the new name", which is not true
   for these rules.
9. **Payees past 300 can't be found.** Search only filters the 300 most used.
10. **Wrong or empty facts on the Rename sheet.** "Bank names that become this payee" is empty unless the payee is
    in a suggestion.

## 3. Goals and non-goals

Goals:

1. The page opens on the list, with duplicates as one line you can act on when you choose.
2. A merge shows exactly which payees combine, lets you take any out, and lets you pick the name and the usual
   category.
3. Any merge can be undone, right away or later (split a bank name back out).
4. Rules keep doing what they did before a merge or rename.
5. "Not the same" is remembered.
6. Works one-handed on an iPhone; the same on a computer (D-55).

Non-goals: smarter matching with machine learning (the design rules it out); merging transactions; editing bank
descriptions; deleting payees (an unused payee does no harm, and sync would make it again); offline payee edits.

## 4. The Payees page

`/settings/payees`, a page (D-54: a list you work through). `BackHeader` "Payees", header action **Select**.

```
┌──────────────────────────────────────┐
│ ‹ Settings   Payees          [Select]│
│ [🔍 Search payees                  ] │
│ ┌──────────────────────────────────┐ │
│ │ ⓘ 8 groups look like the same    │ │
│ │   payee                Review ›  │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ Blue Bottle Coffee            ›  │ │
│ │ 23 transactions · usually Coffee │ │
│ ├──────────────────────────────────┤ │
│ │ Trader Joe's                  ›  │ │
│ │ 19 transactions · usually Groc.. │ │
│ └──────────────────────────────────┘ │
│ The bank's own description is always │
│ kept on each transaction.            │
└──────────────────────────────────────┘
```

- **Duplicates banner.** One `Banner` (info tone) with a count and a **Review** link to the Review page (section
  5). Hidden when there are none, and while searching.
- **Rows.** Name; "_n_ transactions · usually _category_". Tapping a row opens that payee (section 6). No
  buttons on rows.
- **Search** matches every payee (not only the 300 most used) and also the bank descriptions behind each one, so
  searching "SQ \*BLUE" finds Blue Bottle Coffee. A match on a description shows it under the row in mono type.
- **Select mode.** Select turns each row into a checkbox row and the header action into **Cancel**. A footer
  appears once two or more are ticked: **Merge 3 payees**, which opens the Merge sheet (section 7). Search still
  works in Select mode, and ticks survive a new search, so you can find "Lyft" and then "Uber" and tick both.

## 5. Review duplicates

`/settings/payees/duplicates`, a page (a list you work through), one group at a time.

```
┌──────────────────────────────────────┐
│ ‹ Payees   Review duplicates   2 of 8│
│ Same payee?                          │
│ ┌──────────────────────────────────┐ │
│ │ ☑ Blue Bottle Coffee      23     │ │
│ │   SQ *BLUE BOTTLE 0123 OAKLAND   │ │
│ ├──────────────────────────────────┤ │
│ │ ☑ Bluebottle Coffee        4     │ │
│ │   BLUEBOTTLE COFFEE              │ │
│ ├──────────────────────────────────┤ │
│ │ ☐ Blue Shield              2     │ │
│ │   BLUE SHIELD CA PREM            │ │
│ └──────────────────────────────────┘ │
│ Show as                              │
│ (•) Blue Bottle Coffee               │
│ ( ) Bluebottle Coffee                │
│ ( ) Another name… [            ]     │
│                                      │
│ [ Merge 2 payees                   ] │
│ [ Not the same                     ] │
│              Skip                    │
└──────────────────────────────────────┘
```

- Each row is a **payee**, with its transaction count and one example bank description (the most used one).
  All start ticked. Untick any that don't belong; at least two must stay ticked to merge.
- **Show as** offers each ticked payee's own name, most used first and chosen, plus "Another name". The names
  come from your payees, never from a cleaned description, so a name you already set is kept.
- **Usually** appears only when the ticked payees remember different categories: "Usually: Coffee or Dining
  out?", one choice each, plus "Don't remember".
- **Merge _n_ payees** merges and moves to the next group; a toast says "Merged into Blue Bottle Coffee" with
  **Undo** (section 8.3).
- **Not the same** remembers that these payees are different (section 8.2) and moves on. If you unticked some
  first, it remembers only the unticked ones as different from the rest, and offers the rest again.
- **Skip** moves on without saving anything; a skipped group comes back next time.
- After the last group: "All reviewed" with **Back to payees**.

The Review page and the Merge sheet (section 7) share one component: the Review page is the Merge sheet's body
laid out on a page, with Not the same and Skip added.

## 6. A payee

Opens as a sheet over the list (D-54: one thing you edit), from a row or from search. On a computer, in the side
panel beside the list.

```
┌──────────────────────────────────────┐
│ Blue Bottle Coffee                 ✕ │
│ Show as [Blue Bottle Coffee        ] │
│ Remember category       [on]  Coffee │
│                                      │
│ BANK DESCRIPTIONS                    │
│ ┌──────────────────────────────────┐ │
│ │ SQ *BLUE BOTTLE 0123 OAKLAND  19 │ │
│ │                   Move out…      │ │
│ │ BLUEBOTTLE COFFEE              4 │ │
│ │                   Move out…      │ │
│ └──────────────────────────────────┘ │
│ RULES                                │
│ Coffee shops → Coffee              › │
│                                      │
│ Merge other payees into this one…    │
│ See 23 transactions                › │
│ [ Save                             ] │
└──────────────────────────────────────┘
```

- **Show as** and **Remember category** are edited here and saved with the footer's **Save** (D-55: main button
  in the footer).
- **Bank descriptions** come from this payee's aliases, each with its transaction count and the most common raw
  description behind it. **Move out…** (section 8.5) is offered when the payee has two or more aliases; it asks
  first in an inline card: "Make _description_ its own payee? 4 transactions move. Rules that name Blue Bottle
  Coffee won't match them."
- **Rules** lists the rules that name this payee (by name or id), each opening the rule.
- **Merge other payees into this one…** opens a search picker (multi-select, the same rows as Select mode), then
  the Merge sheet with this payee's name chosen.
- **See transactions** opens Activity searching this payee.

The Rename sheet opened from a transaction (`components/RenamePayee.tsx`) stays a quick rename. Its merge
drop-down is replaced by **Same as another payee…**, which opens the same search picker and then the Merge sheet.
Its "Bank descriptions" list uses the aliases too, so it is never empty.

## 7. The Merge sheet

Opened from Select mode, from a payee, or from the transaction's Rename sheet. The same body as the Review page
(section 5): ticked payees with counts and an example description, **Show as**, **Usually** when the categories
differ, and one line when rules are affected: "2 rules name these payees. They'll name Blue Bottle Coffee
instead." Footer: **Merge _n_ payees**.

## 8. Data and API

### 8.1 The view

`GET /api/settings/payees` (contracts `PayeesView`) changes to:

- `payees[]`: every payee not merged away (no 300 limit), each with `aliases` (`{ id, label, example, count }`),
  `rules` (ids) and `transactions`.
- `groups[]` instead of `suggestions[]`: groups of **payee ids** (not descriptions), each with the payees' ids in
  the order shown, minus pairs marked Not the same (8.2). A group is built by running `clusterPayees()` over the
  aliases' descriptions as now, mapping descriptions to their payees, and dropping a group whose payees are all
  marked as different from one another.

Clustering stays the same in v1 except for one fix: compare against every description already in a group, not
only the first, so the order of rows doesn't change the groups. (Trigrams on the cleaned key; 500 rows today.)
Section 10 has the CPU check.

### 8.2 Not the same

New table (migration 0007):

```sql
CREATE TABLE payee_not_same (
  budget_id TEXT NOT NULL,
  a TEXT NOT NULL,          -- payee id, a < b
  b TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (budget_id, a, b)
);
```

`POST /api/settings/payees/not-same { ids: string[] }` writes every pair. A group drops any edge between a
marked pair. When a payee is merged away, its pairs follow the kept payee.

### 8.3 Merge and undo

`POST /api/settings/payees/merge { keep, ids, name, defaultCategoryId? , remember? }`: `keep` is the payee whose
id survives (the one whose name was chosen, or the most used for "Another name"). The server, in one batch:

1. Renames `keep` and sets its usual category and remember flag as chosen.
2. Moves aliases and `txn_overlay.payee_id` from the others to `keep`, and sets `merged_into` on the others.
3. Rewrites rules (8.4).
4. Writes a `payee_merge` row with what it changed, so it can be undone.

```sql
CREATE TABLE payee_merge (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  keep TEXT NOT NULL,
  before TEXT NOT NULL,     -- JSON: each payee's name, category, remember; aliases and txn_keys per merged id; rule versions
  undone_at INTEGER,
  created_at INTEGER NOT NULL
);
```

`POST /api/settings/payees/merge/:id/undo` puts back what `before` lists, except transactions whose payee you
changed after the merge, and marks the row undone. The toast's Undo calls it. Later, Move out (8.5) is the way
back.

The old `{ ids, name }` body is accepted for one release so an app that hasn't reloaded keeps working.

### 8.4 Rules follow merges and renames

On a merge, every rule condition "Payee is _X_" where _X_ is a merged payee's name (case-insensitive) or id
becomes "Payee is _kept name_", and every "Set payee" pointing at a merged id points at `keep`. On a rename, "Payee
is _old name_" becomes "Payee is _new name_". "Payee contains" conditions are left alone and named on the sheet
("1 rule matches part of a name: check it"), since rewriting part of a name could widen what it matches.

This keeps categorization the same: a transaction that a rule caught before the merge is caught after it. It
does not re-run rules on past transactions.

### 8.5 Move out (split)

`POST /api/settings/payees/:id/move-out { aliasId, name }` makes a new payee named after the description (or a
name you type), points the alias at it, and moves the transactions whose bank description resolves through that
alias and whose payee is still this one. Transactions you set to this payee by hand stay. Rules aren't changed;
the confirm says so.

### 8.6 On the phone

These routes run on the server only; the phone needs a connection for them, like every settings change today.
`GET /api/settings/payees` runs on the local copy as now, so `engine.test.ts` gets a case comparing the phone's
view with the server's, and the two new tables join the sync list (`sync-tables.ts`) and the change-log triggers.

## 9. Copy

| Where            | Text                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| Banner           | "8 groups look like the same payee" · Review                          |
| Review title     | "Same payee?"                                                         |
| Merge button     | "Merge 2 payees"                                                      |
| Toast            | "Merged into Blue Bottle Coffee" · Undo                               |
| Not the same     | "Not the same"                                                        |
| Move out confirm | "Make SQ \*BLUE BOTTLE its own payee? 4 transactions move."           |
| Footnote (list)  | "The bank's own description is always kept on each transaction."      |
| Rules line       | "2 rules name these payees. They'll name Blue Bottle Coffee instead." |

Replace the Rename sheet's "Rules follow the new name" with the rules line above when rules are affected, and
drop it otherwise.

## 10. Limits

- **CPU (10 ms rule).** The view runs on the phone, but the server route must still fit. Clustering 500 rows
  against all members of each group is up to ~125,000 trigram comparisons worst case. Measure it with the
  measurement set (`docs/measurements.md`); if it's over, cap the rows or cluster on the alias keys (one per alias,
  far fewer than descriptions).
- **Merge size.** Moving overlays for a payee with thousands of transactions is one `UPDATE` each; the `before`
  JSON holds their keys (a few KB). Fine for one person's budget.
- **Usage events.** New fixed ids only (`payees.select`, `payees.review.merge`, `payees.review.not_same`,
  `payees.review.skip`, `payee.move_out`, `payees.merge.undo`); no names (design: what is never recorded).

## 11. Plan

Three PRs, each shippable:

1. **The calm list.** Banner instead of cards, rows that open the payee sheet, search across all payees and
   descriptions, Select mode and the Merge sheet (name and category choice), rules follow merges and renames,
   aliases on the sheet. No migration.
2. **Review and undo.** The Review page, `payee_not_same` and `payee_merge`, the Undo toast. Adds migration 0007:
   asks the owner before merging.
3. **Move out.** The split, and the transaction sheet's Same as another payee.

Tests: domain tests for the clustering fix; API tests for merge with a chosen keep, rule rewrites, undo after a
later edit, not-same pairs following a merge, and move out; `engine.test.ts` for the view; e2e for Select → Merge
→ Undo and for Review on a phone-sized viewport.

## 12. Questions for the owner

1. Rules follow merges and renames (8.4). Okay to rewrite "Payee is" rules automatically, or would you rather be
   asked on the sheet each time?
2. Migration 0007 adds two tables (8.2, 8.3). Okay to add them in PR 2?
3. Should Review open by itself after a sync finds new duplicates, or only from the banner? (Proposal: banner
   only.)

## 13. Adversarial review

_To be added._

## 14. Design critique

_To be added._
