# Payees: a calmer page and merging that works

Status: proposal, v1.1, Nov 3, 2026. Nothing is built yet. The owner asked for a better Payees page because it is
overwhelming and doesn't merge payees well. v1 got an adversarial review (2 blockers, 8 major, 13 minor) and a
design critique (6 high, 5 medium, 3 low); v1.1 includes their fixes, listed in sections 13 and 14. Section 12
holds the questions for the owner.

**Does this change how money is counted?** A merge never changes the category, amount or budget month of a
transaction you already have. It can change which category **later** transactions get, because the merged payee
has one remembered category and the rules that named either payee now see one payee. So the Merge sheet always
shows that before you merge (section 7), and section 12 asks the owner how a conflict should be handled.

## 1. How it works today

| Fact                           | Today                                                                                                                                                                                                                                                            | Where                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| A payee                        | A row in `payee` (name, remember-category flag, usual category, `merged_into`). Names aren't unique. Bank rows reach a payee through `payee_alias`: a Plaid merchant id, or a cleaned description key when there's no merchant id                                | migration 0001                                               |
| Where payees come from         | Sync looks up the merchant id first, then the description key. The first time it sees neither, it makes a payee and an alias, named after Plaid's merchant name or the cleaned description in title case. So every new description variant makes a new payee     | `apps/worker/src/sync/process.ts`, step 5                    |
| The list                       | Payees not merged away, most used first, **at most 300**. Search filters those 300 on the phone                                                                                                                                                                  | `routes/settings/payees.ts`                                  |
| Suggestions                    | `clusterPayees()` groups up to 500 description/payee pairs by merchant id, then by trigram similarity ≥ 0.5 to each group's first description. Shown when a group covers 2 or more payees. Measured at about **18 ms** warm on 500 rows                          | `packages/domain/src/payee.ts`                               |
| A suggestion on screen         | A large blue card per group, all stacked above the list: the descriptions as chips, "Merge into _name_? Rules and past transactions follow", **Keep separate** and **Merge _n_** (_n_ counts descriptions, not payees)                                           | `apps/web/src/screens/settings/Payees.tsx`                   |
| The suggested name             | The current name of the payee of the group's most used description: often fine, but it's whichever payee happens to come first                                                                                                                                   | `payees.ts`, `v_transaction.payee`                           |
| Keep separate                  | Hides the card until the page reloads; nothing is saved                                                                                                                                                                                                          | `Payees.tsx`                                                 |
| Merging by hand                | Each row's **Rename** opens the Rename sheet, which ends with "Or merge into an existing payee": a drop-down of every other payee. The result takes the other payee's name                                                                                       | `RenameSheet` in `Payees.tsx`, `components/RenamePayee.tsx`  |
| What a merge does              | The first id is kept and renamed. Aliases and every transaction's `payee_id` move to it, the others get `merged_into`. One audit row. The ids aren't checked (`[X, X]` hides X). No undo, no split                                                               | `POST /api/settings/payees/merge`                            |
| Renaming from a transaction    | `PATCH /api/transactions/:key { payeeName }` renames the whole payee and works offline. The sheet finds the payee by name and also turns on its remembered category (`remember: true`) without saying so                                                         | `routes/activity.ts`, `screens/TxnSheets.tsx`, `copy.ts`     |
| Rules                          | "Payee is _X_" stores the **name** and matches by name (any case) or by id; renaming a payee stops such a rule matching. "Payee contains" matches part of the name. "Set payee" exists in the rule format but sync ignores it and the Rules screen can't make it | `packages/domain/src/rules.ts`, `screens/settings/Rules.tsx` |
| Manual transactions            | Have no `payee_id`, so they aren't in the list or in groups                                                                                                                                                                                                      | `routes/activity.ts`                                         |
| Where the screen is worked out | On the phone, by the server's own route on the local copy (D-45, D-46). Settings changes need a connection                                                                                                                                                       | `apps/worker/src/local`, `apps/web/src/api/client.ts`        |

## 2. What's wrong

1. **Too much at once.** Every suggestion is a full card, stacked before the list. With 10 groups you scroll
   through 10 blue cards to reach the first payee, and each payee row has its own Rename button.
2. **A suggestion is all or nothing.** You can't take one wrong payee out of a group.
3. **You can't choose the name.** It's whichever payee comes first in the group.
4. **The card shows the wrong things.** It lists descriptions, but the merge acts on payees: you don't see which
   payees combine, how many transactions each has, or which remembered category wins. "Merge 5" counts
   descriptions.
5. **"Keep separate" doesn't stick.** It's back after a reload.
6. **Merging by hand is buried and slow.** The last field of the Rename sheet, a drop-down of up to 299 names,
   one payee at a time, always taking the other payee's name.
7. **No undo and no split.** The design (`docs/design.md`, Payee normalization) promises merge, split and rename;
   split was never built.
8. **Rules quietly change.** "Payee is Lyft" stores the name, so a rename or merge stops it matching. Both the
   card ("Rules and past transactions follow") and the Rename sheet ("Rules follow the new name") say the
   opposite.
9. **Payees past 300 can't be found.**
10. **The Rename sheet's facts are wrong or missing.** "Bank names that become this payee" is empty unless the
    payee is in a suggestion, and renaming from a transaction turns on the remembered category.
11. **Duplicates keep coming.** Each new description variant makes a new payee. The page can't fix that, but it
    should make the next merge quick.

## 3. Goals and non-goals

Goals:

1. The page opens on the list, with duplicates as one line you act on when you choose.
2. A merge shows exactly which payees combine, lets you take any out, and lets you pick the name and the
   remembered category.
3. Before merging, you see what changes for later transactions (rules, remembered category).
4. A merge can be undone right after it. A bank description can be made its own payee again at any time.
5. "Not the same" is remembered.
6. Renaming never stops a rule matching.
7. One-handed on an iPhone; the same on a computer (D-55).

Non-goals: machine-learned matching (the design rules it out); merging transactions; editing bank descriptions;
deleting payees; offline merges; stopping sync from making new payees for new variants (a later change could
match them to merged payees, but that changes categorization and needs its own decision); payees for manual
transactions.

## 4. The Payees page

`/settings/payees`, a page (D-54: a list you work through). `BackHeader` "Payees", no header action.

```
┌──────────────────────────────────────┐
│ ‹ Settings   Payees                  │
│ [🔍 Search payees                  ] │
│ ┌──────────────────────────────────┐ │
│ │ ⓘ 8 possible duplicate payees    │ │
│ │                        Review ›  │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ Blue Bottle Coffee               │ │
│ │ 23 transactions · usually Coffee │ │
│ ├──────────────────────────────────┤ │
│ │ Trader Joe's                     │ │
│ │ 19 transactions · usually Groc…  │ │
│ └──────────────────────────────────┘ │
│ The bank's own description is always │
│ kept on each transaction.            │
└──────────────────────────────────────┘
```

- **Duplicates banner.** One info `Banner`, "_n_ possible duplicate payees", with a **Review** link to the
  Review page (section 5). Hidden when there are none, and while searching.
- **Rows.** Name (wraps; never truncated); "_n_ transaction(s) · usually _category_". Tapping a row opens the
  payee sheet (section 6), so no chevron (D-55). No buttons on rows.
- **Search** matches every payee (no 300 limit) and the bank descriptions behind each one, so "SQ \*BLUE" finds
  Blue Bottle Coffee; a description match shows under the row in mono type.
- **States.** `Loading` while loading; `EmptyNote` "No payee matches." or "No payees yet."; `ErrorNote` on
  failure.

There is no multi-select. To merge by hand you open the payee you want to keep and choose **Merge other payees
into this one** (section 6). This is the only way to merge by hand, so there's one to learn.

## 5. Review duplicates

`/settings/payees/duplicates`, a page (a list you work through), one group at a time.

```
┌──────────────────────────────────────┐
│ ‹ Payees   Review duplicates         │
│ Same payee?            Group 2 of 8  │
│ ┌──────────────────────────────────┐ │
│ │ ☑ Blue Bottle Coffee             │ │
│ │   23 transactions                │ │
│ │   SQ *BLUE BOTTLE 0123 OAKLAND   │ │
│ ├──────────────────────────────────┤ │
│ │ ☑ Bluebottle Coffee              │ │
│ │   4 transactions                 │ │
│ │   BLUEBOTTLE COFFEE              │ │
│ ├──────────────────────────────────┤ │
│ │ ☐ Blue Shield                    │ │
│ │   2 transactions                 │ │
│ │   BLUE SHIELD CA PREM            │ │
│ └──────────────────────────────────┘ │
│ Blue Shield will stay separate.      │
│ Show as [Blue Bottle Coffee        ] │
│ (Blue Bottle Coffee) (Bluebottle Co…)│
│ Coffee shops → Coffee: also applies  │
│ to Bluebottle Coffee.                │
│ ─────────────────────────────────────│
│ [ Merge 2 payees                   ] │
│   Not the same          Skip         │
└──────────────────────────────────────┘
```

- **Rows** are payees: a whole-row checkbox (`<label>`, 56 px tall, 22 px box, like `ActivityMatch.tsx`), the
  name, "_n_ transactions", and the most used bank description. Only strong matches start ticked: the same
  merchant id, or similarity ≥ 0.7. A row that only passed the 0.5 threshold starts unticked.
- Under the list, one line names what stays separate: "Blue Shield will stay separate."
- **Show as** is one text field, filled with the most used ticked payee's name. Each ticked payee's name is a
  chip under it; tapping one fills the field. The kept payee (the one whose id survives) is the one whose name
  is in the field, or the most used if you typed a new name.
- **What changes later** (section 7.2), when anything does: one line per change, in plain words.
- **Footer** (D-55): **Merge _n_ payees** (disabled with "Tick at least 2" below 2), and under it, on one row,
  two `TextButton`s: **Not the same** and **Skip**.
- **Merge** merges, marks the unticked payees as not the same as the kept one, and moves on. A toast says
  "Merged into Blue Bottle Coffee" with **Undo** (section 8.3).
- **Not the same** always means the whole group: no two of these payees are the same. It moves on.
- **Skip** saves nothing; the group comes back next time.
- After each step the groups are worked out again (a merge can change a later group), and the count updates.
  Focus moves to the "Same payee?" heading, and a polite live region says what happened ("Merged into Blue
  Bottle Coffee. Group 3 of 8").
- **End and empty:** "Nothing to review" with **Back to payees**, also when opened from a link with no groups.
- **Offline:** the page shows the groups (they come from the local copy), but the buttons need a connection:
  `mutates` disables them, with "Merging needs a connection." above the footer.
- **Errors:** an `ErrorNote` in the footer; the page stays on the same group.

## 6. A payee

Opens as a sheet over the list (D-54: one thing you edit), from a row or from search. On a computer, in the side
panel beside the list. `SheetTitle` "Payee", tag line "23 transactions".

```
┌──────────────────────────────────────┐
│ Payee · 23 transactions            ✕ │
│ Show as [Blue Bottle Coffee        ] │
│ Remember category                [●] │
│ Category                    Coffee › │
│                                      │
│ BANK DESCRIPTIONS                    │
│ ┌──────────────────────────────────┐ │
│ │ SQ *BLUE BOTTLE 0123 OAKLAND  19 │ │
│ ├──────────────────────────────────┤ │
│ │ BLUEBOTTLE COFFEE              4 │ │
│ └──────────────────────────────────┘ │
│ RULES                                │
│ Coffee shops → Coffee              › │
│ See 23 transactions                › │
│ Merge other payees into this one     │
│ ─────────────────────────────────────│
│ [ Save                             ] │
└──────────────────────────────────────┘
```

- **Show as**, **Remember category** and **Category** (a row that opens `CategoryPicker`) save with the footer's
  **Save**. While any of them is unsaved, the actions below are disabled with "Save first".
- **Same name as another payee.** If Show as matches another payee's name (any case), a line appears under the
  field: "There's already a payee named Lyft." with a soft **Merge into it** button, which opens the merge step
  with both payees ticked. Save is still allowed (names don't have to be unique), but this is the usual way people
  merge, so it is offered.
- **Bank descriptions:** one row per alias, with its transaction count and the most common description behind
  it. When there are two or more, tapping a row opens it in place with **Make its own payee** and Cancel (a
  neutral card, not the red `ConfirmInline`): "SQ \*BLUE BOTTLE becomes its own payee. 19 transactions move. Rule
  Coffee shops → Coffee won't apply to them." (section 8.5).
- **Rules:** the rules that name this payee, each opening the rule (a page, so a chevron).
- **See transactions** opens Activity filtered to this payee's id (not a name search, so the count matches).
- **Merge other payees into this one** (`TextButton`) replaces the sheet's body with a step: a search list of
  other payees with whole-row checkboxes, then the merge step (section 7) with this payee's name in Show as.
  Back returns to the payee. No sheet stacks on another, so it works in the computer's side panel.
- A link to a merged-away payee opens the payee it was merged into.

The Rename sheet opened from a transaction stays a quick rename. It drops the merge drop-down and the hidden
`remember: true`, finds the payee by id, lists the payee's real bank descriptions, and shows the same "There's
already a payee named …" line and **Merge into it**, which opens the payee sheet's merge step.

## 7. The merge step

### 7.1 What it shows

The same body as the Review page (section 5): ticked payees with counts and an example description, **Show as**
with name chips, what changes later, and **Merge _n_ payees** in the footer. Shared as one component.

### 7.2 What changes later

The server works this out (`GET /api/settings/payees/merge-preview?keep=…&ids=…`) and the step shows it before
you merge:

- **Remembered category.** If the payees remember different categories (or only some remember one), a
  "Category to remember" choice appears: each one, or "Don't remember". It starts on the kept payee's.
- **Rules.** For each rule that names one of the payees (section 8.4): "Coffee shops → Coffee: also applies to
  Bluebottle Coffee." When two rules disagree, the step says so plainly: "Lyft → Work travel and Uber →
  Personal: after merging, both go to Work travel (that rule comes first)." What happens then is the owner's
  choice (section 12, question 1).
- **Rules that match part of a name** ("Payee contains") are listed as links: "Check rule: Payee contains
  'Blue'".

Nothing here touches past transactions.

## 8. Data and API

No migration is needed: "Not the same" lives in the existing `setting` table, and undo uses the existing
`audit_log` row.

### 8.1 The view

`GET /api/settings/payees` (contracts `PayeesView`) changes to:

- `payees[]`: every payee not merged away (no 300 limit): `id`, `name`, `transactions`, `remember`,
  `defaultCategory`.
- `groups[]` in place of `suggestions[]`: each a list of `{ payeeId, transactions, example, strong }`, `strong`
  deciding the default tick.

A payee's aliases, counts and rules are read only when its sheet opens (`GET /api/settings/payees/:id`), so the
list stays cheap. Per-alias counts work out each of that payee's transactions' key with the same two-step lookup
as sync (merchant id, then description key), shared as one function with `process.ts` so they can't drift.
Description search is a SQL `LIKE` on bank descriptions, mapped to payee ids.

**Clustering, rewritten (the CPU fix).** Today's 500-row run takes about 18 ms because `similarity()` rebuilds
both trigram sets on every comparison. The new `clusterPayees()`:

1. Works on **one row per alias** (a merchant id or a description key), not per description: far fewer rows.
2. Builds each row's trigram set once.
3. Compares only rows that share their first word (blocking), so "UBER" is never compared with "TRADER JOE".
4. Joins a row to a group when its **average** similarity to the group's members is ≥ 0.5 (average linkage), so
   a row like "UBER" can't chain "UBER EATS" and "UBER TRIP" together (measured: 0.50, 0.50, but 0.33 between
   the two).
5. Gives the same groups whatever the order of rows (a test shuffles them).
6. Drops any group where every pair of payees is marked Not the same, and removes marked pairs' payees from
   each other's groups.

Measure it with the measurement set before PR 1 ships and record it in `docs/measurements.md`; the target is
under 3 ms in workerd for the owner's data.

### 8.2 Not the same

Stored in `setting` under the key `payee_not_same`: a JSON list of `[a, b]` payee id pairs with `a < b`. The
`setting` table already syncs to the phone, so no sync change is needed. `POST
/api/settings/payees/not-same { ids }` adds every pair between `ids` (registered before `/:id` in the route
file, and in the mock server). A merge re-points the merged payees' pairs to the kept payee, drops pairs that
would become `[K, K]`, and removes duplicates.

### 8.3 Merge and undo

`POST /api/settings/payees/merge { keep, ids, name, defaultCategoryId, remember, notSame? }`:

1. Checks: `keep` is in `ids`, the ids are distinct and exist, and none is merged away. Otherwise 409 ("This
   payee was already merged. Pull to refresh.").
2. Renames `keep` and sets its remembered category as chosen.
3. Moves aliases and `txn_overlay.payee_id` from the others to `keep`, and sets `merged_into` on the others.
4. Updates rules (8.4) and Not the same pairs (8.2), adding `notSame` pairs (the unticked payees).
5. Writes the `audit_log` row with a `before` holding: each payee's name, remembered category and flag; each
   moved alias and the payee it pointed at; each changed rule's previous JSON and `updated_at`.

`POST /api/settings/payees/merge/:auditId/undo` is the toast's Undo. It works only while nothing has changed
since: the payees' and rules' `updated_at` match the merge, and no later merge involved `keep`. Otherwise it
says "Can't undo now: this payee changed since." and the payee sheet's Make its own payee is the way back. Undo
puts back names, settings, aliases and rules, then **re-resolves** `keep`'s transactions through the restored
aliases with the shared lookup (8.1). So rows that synced after the merge, and pending rows that became posted,
go back to the right payee too; no list of transaction keys is stored.

The old `{ ids, name }` body is accepted for one release, treated as `keep = ids[0]`, so an app that hasn't
reloaded keeps working.

### 8.4 Rules name payees by id

"Payee is _X_" conditions store the payee's **id**, not its name. The matcher already accepts an id
(`rules.ts`), and the Rules screen shows the payee's current name. Then:

- **A rename changes no rule**, and two payees with the same name don't share rules.
- **A merge** points conditions naming a merged id at `keep` (removing duplicates in OR groups, so no "Chevron
  or Chevron"). The step (7.2) shows each one first.
- **"Payee contains"** stays a name match and is never rewritten.

Existing rules: a one-time conversion (an alarm job, the way other background work runs) changes each "Payee is
_name_" to the id of the payee with that name when exactly one payee has it, and leaves it alone otherwise. A
rule's own name is left as it is. The Rules screen also stops turning "contains" into "is" when a rule is opened
and saved. Whether to run the conversion is section 12, question 2.

"Set payee" is unused (sync ignores it), so nothing here changes it.

### 8.5 Make its own payee (split)

`POST /api/settings/payees/:id/split { aliasId, name? }` makes a new payee (named after Plaid's merchant name or
the cleaned description, or a name you type), points the alias at it, and moves this payee's transactions whose
key resolves through that alias (the shared lookup). Rules aren't changed; the confirm says which won't apply
any more. It needs at least two aliases on the payee.

### 8.6 Merges and the phone

- Every write here needs a connection.
- A queued offline rename from a transaction (`PATCH … { payeeName }`) that reaches the server after its payee
  was merged away is refused with 409 rather than renaming the kept payee. The phone drops it and says so, the
  way other refused offline edits do.
- A merge moves many `txn_overlay` rows, and today every overlay change makes the phone rebuild budget lines
  (`engine.ts`). Changes that touch only `payee_id` skip that rebuild; `engine.test.ts` checks the numbers still
  match.
- `engine.test.ts` already compares `/api/settings/payees`; it gains cases for groups after a merge and after Not
  the same, and for the payee route.

## 9. Copy

| Where           | Text                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Banner          | "8 possible duplicate payees" · Review                                                                                                        |
| Review heading  | "Same payee?" · "Group 2 of 8"                                                                                                                |
| Unticked        | "Blue Shield will stay separate."                                                                                                             |
| Merge button    | "Merge 2 payees" · below 2: "Tick at least 2"                                                                                                 |
| Toast           | "Merged into Blue Bottle Coffee" · Undo                                                                                                       |
| Can't undo      | "Can't undo now: this payee changed since."                                                                                                   |
| Rules line      | "Coffee shops → Coffee: also applies to Bluebottle Coffee."                                                                                   |
| Rules conflict  | "Lyft → Work travel and Uber → Personal: after merging, both go to Work travel."                                                              |
| Contains rule   | "Check rule: Payee contains 'Blue'"                                                                                                           |
| Category choice | "Category to remember"                                                                                                                        |
| Same name       | "There's already a payee named Lyft." · Merge into it                                                                                         |
| Split confirm   | "SQ \*BLUE BOTTLE becomes its own payee. 19 transactions move. Rule Coffee shops → Coffee won't apply to them." · Make its own payee · Cancel |
| Offline         | "Merging needs a connection."                                                                                                                 |
| End             | "Nothing to review" · Back to payees                                                                                                          |
| List footnote   | "The bank's own description is always kept on each transaction."                                                                              |

Counts use the singular for one ("1 transaction"). The Rename sheet's "Rules follow the new name" is removed:
with rules naming ids (8.4), a rename needs no note.

## 10. Limits and checks

- **CPU (10 ms rule).** Clustering is measured before PR 1 (section 8.1). The payee route reads one payee's rows.
  A merge of a payee with thousands of transactions is one `UPDATE` per table plus their `change_log` rows;
  measure the largest payee in the measurement set.
- **Audit row size.** `before` holds aliases and rules, not transaction keys: a few KB.
- **Usage events.** Fixed ids only (`payees.review.merge`, `payees.review.not_same`, `payees.review.skip`,
  `payee.merge_into`, `payee.split`, `payees.merge.undo`); never names (design: what is never recorded).
- **Accessibility.** Whole-row labels for checkboxes; counts read as "23 transactions"; focus and a live region
  after each Review step; the Undo toast is `role="status"` and stays while it has focus.

## 11. Plan

Four PRs, each shippable, none with a migration:

1. **Groundwork.** The new clustering, measured; merge validation; the Rename-from-transaction fixes (find by id,
   no hidden `remember: true`); the Rules screen keeping "contains"; rules naming payees by id and the one-time
   conversion (if the owner says yes, section 12).
2. **The calm list and the payee sheet.** Banner instead of cards, plain rows, search across all payees and
   descriptions, the payee sheet with Merge other payees into this one, the merge step with what changes later,
   the same-name offer, Undo.
3. **Review duplicates.** The Review page and Not the same.
4. **Make its own payee.**

Tests: domain tests for clustering (shuffled order gives the same groups; no chaining; blocking); API tests for
merge validation, a chosen keep, rules re-pointed, undo after a sync that added rows, undo refused after a later
change, Not the same pairs after a merge, split; `engine.test.ts` as in 8.6; e2e (mock) for open payee → merge →
Undo and for Review at iPhone size.

## 12. Questions for the owner

1. **Rules that disagree.** Lyft has "→ Work travel" and Uber "→ Personal". If you merge them, later rides all go
   to whichever rule comes first. Should the merge step (a) show it and let you merge anyway, or (b) not allow
   the merge until you change a rule? Proposal: (a), with the warning in plain words.
2. **Rules name payees by id (8.4).** A one-time change to your saved rules so a rename never stops one
   matching. Each rule matches the same transactions as before. Okay to run it?
3. **No multi-select.** You merge by hand by opening the payee to keep, and Review handles groups. Okay to drop
   the Select mode from v1 of this doc?

## 13. Adversarial review (v1 → v1.1)

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Change                                                                                       |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Blocker  | Rewriting "Payee is Lyft" to the merged name widens it to all of the merged payee, and two disagreeing rules collapse to the first. The intro's "nothing changes" was wrong                                                                                                                                                                                                                                                                                                                                 | Intro corrected; the merge step shows every rule change and conflict (7.2); owner question 1 |
| 2   | Blocker  | A new synced table: an older app skips its rows but still moves its sync position, and never gets them                                                                                                                                                                                                                                                                                                                                                                                                      | No new table: Not the same goes in `setting`, which already syncs (8.2)                      |
| 3   | Major    | Undo from a stored list of transaction keys misses rows synced after the merge and pending rows that posted                                                                                                                                                                                                                                                                                                                                                                                                 | Undo re-resolves through the restored aliases (8.3)                                          |
| 4   | Major    | Undo after later merges or rule edits restores the wrong state                                                                                                                                                                                                                                                                                                                                                                                                                                              | Undo only while nothing changed since; otherwise Make its own payee (8.3)                    |
| 5   | Major    | No stored link from a transaction to its alias; working out per-alias counts for every row is slow                                                                                                                                                                                                                                                                                                                                                                                                          | Counts only for one payee, on its sheet, with the shared lookup (8.1)                        |
| 6   | Major    | Clustering is already about 18 ms; comparing with every member without caching took about 1.2 s                                                                                                                                                                                                                                                                                                                                                                                                             | Rewritten: per alias, cached trigrams, blocking, measured before PR 1 (8.1)                  |
| 7   | Major    | Comparing with every member chains Uber Eats and Uber Trip together                                                                                                                                                                                                                                                                                                                                                                                                                                         | Average linkage, order-independent (8.1)                                                     |
| 8   | Major    | The rename-from-transaction path works offline; names aren't unique, so rewriting by name hits other payees                                                                                                                                                                                                                                                                                                                                                                                                 | Rules name ids (8.4); a late offline rename of a merged payee is refused (8.6)               |
| 9   | Major    | PR 1 shipped irreversible rule rewrites with no undo                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Rule JSON is in the audit row's `before`; undo puts it back (8.3)                            |
| 10  | Major    | The merge route doesn't check its ids                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Validation and 409 (8.3)                                                                     |
| —   | Minor    | "Set payee" unused; the suggested name described wrongly; hidden `remember: true` and find-by-name on the Rename-from-transaction sheet; one description with two payees drops one; OR groups duplicate; Rules screen turns "contains" into "is"; route order; pair edge cases; audit size; overlay changes rebuild budget lines; `engine.test.ts` already covers the view; manual transactions; See transactions by name; "Merge _n_" counts descriptions; new variants keep making payees; stacked sheets | Sections 1, 2, 6, 8.1–8.6, 10, 11                                                            |

## 14. Design critique (v1 → v1.1)

| #   | Impact | Finding                                                                                                    | Change                                                                                            |
| --- | ------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | High   | Four ways to merge; Select mode merges payees you can't see after a new search, its button is out of reach | Select mode cut; one hand-merge path from the payee (4, 6); question 3                            |
| 2   | High   | "Not the same" meant two things depending on ticks                                                         | Always the whole group; unticked payees are marked by Merge, with a line saying so (5)            |
| 3   | High   | Review crowded: radio lists repeat the rows; Merge and Not the same stacked                                | One Show as field with name chips; Merge in the footer, Not the same and Skip as text buttons (5) |
| 4   | High   | Everything ticked by default, so a weak match (Blue Shield) merges with one tap                            | Only strong matches start ticked (5)                                                              |
| 5   | High   | Payee sheet mixed Save with actions that act at once, and stacked sheets                                   | Actions disabled while unsaved; merge is a step inside the sheet (6)                              |
| 6   | High   | Renaming to an existing name, the commonest merge, wasn't covered                                          | "There's already a payee named …" with Merge into it (6)                                          |
| 7   | Medium | "Move out…" on every description row; red confirm for something that isn't a removal                       | Tap a row to open it in place, neutral card, "Make its own payee" (6)                             |
| 8   | Medium | Missing states: offline, failure, empty, shifting groups, merged-away links, one tick, long names          | Added (4, 5, 6)                                                                                   |
| 9   | Medium | "2 of 8" in the header's action slot                                                                       | In the heading (5)                                                                                |
| 10  | Medium | Accessibility: row labels, counts read aloud, focus after a step, toast timing                             | Added (5, 10)                                                                                     |
| 11  | Medium | "Undo later" overpromised                                                                                  | Undo right after a merge; Make its own payee later (3, 8.3)                                       |
| 12  | Low    | Copy: banner wording, "Move out", missing rules sentence, "Another name…", "check it", singulars           | Section 9                                                                                         |
| 13  | Low    | Sheet title repeated the name                                                                              | `SheetTitle` "Payee" with the count (6)                                                           |
| 14  | Low    | Merge into this one shouldn't be a chevron row                                                             | `TextButton` (6)                                                                                  |
