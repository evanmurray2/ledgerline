# Payee names from Plaid, and no cleanup of bank text

Status: approved, v7, Nov 5, 2026. Built: PRs #61–#63 and PR 4 of section 11. Asked by the owner after a Hulu charge arrived as "Hlu Huluplus Hulu".
v5 followed an adversarial review of v4 and is simpler: two keys instead of five, no stop list, no name ranks, and
a pending matcher with three plain rules. v6 added the owner's answers of Nov 5 and a fix for an entry and the bank's
pending row counting twice. v7 follows a second review: the app pairs only on exact evidence and asks "Same
purchase?" otherwise, and an entry covers the bank's pending row instead of moving onto it (9). Reviews are in
section 14. The owner's answers are in section 13. This changes section 4 of
`docs/payees.md`, the Payee normalization steps in `docs/design.md`, and one row of Matching mechanics in
`docs/sync-spec.md` (D-47, D-50).

**Does this change how money is counted?** Payee names and keys (sections 3–8): no. The pending matcher (section
9): yes. It changes which bank pending row a posted charge replaces when the bank sends no link, and it pairs a
manual entry with the bank's pending row so the two stop counting twice. The owner OK'd both, and v7's version of
them, on Nov 5 (13). Every posted
charge still counts exactly once.

## 1. What happened to Hulu

From the owner's backup:

1. **Nov 1, first link.** Plaid sent the Amex history without merchant names (its enrichment wasn't done yet). Sync
   made two payees from the cleaned bank text: "Hlu Huluplus Hulu" (`HLU*HULUPLUS HULU.COM/BILL CA`) and "Hulu"
   (`HULU SANTA MONICA CA`).
2. **Nov 2, six hours later.** Plaid sent the same rows again as `modified`, now with `merchant_name` "Hulu" and a
   merchant id. Sync never names or re-files a row after it's filed (`payee_id = coalesce(...)` in `process.ts`
   step 5), so nothing changed.
3. **Nov 2, a merge.** The old Payees page's suggestion card (since removed) offered to merge the two under the name
   the app had made, "Hlu Huluplus Hulu", and the merge was accepted with that name.

Today's import also keeps only one of Plaid's texts (`rawName: t.original_description ?? t.name`,
`packages/bank-provider/src/plaid.ts`), so Plaid's short `name` is lost.

## 2. The principle

**Dropped:** the app cleans up the bank's raw text and decides from it who the payee is, what it's called, and which
pending row a posted charge replaces.

**New:** the app never edits, cleans or scores bank text. It uses Plaid's values as sent and compares them only for
**equality**, by `payeeNameKey` (case, outer spaces and curly or straight apostrophes ignored, nothing else): "Hulu"
equals "HULU"; "Shell" doesn't equal "Shell Oil". When Plaid gives no name, the payee is the bank's text exactly as
sent. A payee's name changes only when the owner renames it, or while it's new (6).

**Deleted:** `cleanDescription`, `titleCase`, `trigrams`, `similarity`, `jaccard`, `clusterPayees` and `payeeKey`
(`packages/domain/src/payee.ts`), and `storeNumbers` and the trigram cache (`matcher.ts`), with their tests.

**Stays:** `samePayeeName` and `payeeNameKey`, and two word tests that read the raw text and change nothing:
`channel()` (`CHK`, `CHECK`, `ACH` set the amount tolerance) and `P2P` (payment-app money in waits to match).

## 3. What we store

One budget migration:

- `bank_txn.plaid_name`: Plaid's `name` (on 751 of 751 rows in the backup).
- `payee.named_by`: `user` or `sync`, default `user`. Only sync's own new payees and the job (8) write `sync`.

Plaid's `counterparties` aren't stored: on every row that has a merchant counterparty, its name equals
`merchant_name` (503 of 503), so it adds nothing.

`payee`, `payee_alias` and `bank_txn` are synced tables (`apps/worker/src/sync-tables.ts`), so the new columns reach
the phone. Rename, join and the `payeeName` edit run in the phone engine too and set `named_by = 'user'` there;
`engine.test.ts` gains those cases.

## 4. Who the payee is

Each bank row has up to three keys:

| Key                      | From                               |
| ------------------------ | ---------------------------------- |
| `m:<merchant_entity_id>` | Plaid's merchant id                |
| `n:<name>`               | `merchant_name`, by `payeeNameKey` |
| `n:<name>`               | `plaid_name`, by `payeeNameKey`    |

Both names share one `n:` space. A row with neither name (none in the backup) uses `n:<raw_name>`.

**Filing a new row:**

1. Look up its keys, in the order above. The first key that belongs to a payee decides the payee.
2. If none does, make a payee (5).
3. Give the payee every key of the row that no payee has yet.

**Rules that make it predictable:**

- **A filed row never moves.** Sync files a row once, when it first arrives. A `modified` row, a posted row that
  takes over its pending row, or a row you categorized keeps its payee, as today. A row that takes over an overlay
  with no payee (an entry's, which has none today) is filed then.
- **Sync never joins two payees.** If a row's keys belong to two payees, the first decides and the other key stays
  where it is. Only the owner joins payees (rename to an existing name, or **Join** on "Same as your …?",
  `docs/payees.md` 4.3, 5).
- **Keys follow the owner.** A rename or join also gives the payee the key `n:<its new name>`, so a later row whose
  Plaid name is that name finds it. A join moves all keys to the kept payee, and Undo moves them back.
- **Keys point at the payee's id,** so renaming keeps every key.

**Accepted:** the result can depend on arrival order. When a row's keys belong to two payees, which one gets it
depends on which keys came first. The re-file job (8) files in date order; live sync files as rows arrive. In the
backup this affects 1 payee (305 payees filed oldest first, 306 newest first).

**Known, and left as it is:** some Plaid names carry digits that change every month (card payments, some ACH rows),
so each makes a new payee: 40 payees in 8 such groups in the backup. 59 of their 61 rows are from before the budget
start, which the Payees page and Activity don't show (D-62); the other 2 are paired transfers, which need no category.
So the owner sees no difference, and transfers don't change.

`n:` keys go in `payee_alias.pattern` with the prefix; `m:` stays in `merchant_entity_id`. No new table. Sync looks
up only the batch's keys (`WHERE pattern IN (…) OR merchant_entity_id IN (…)`, indexed), not every alias.

## 5. What a new payee is called

The first that is present: `merchant_name`, then `plaid_name`, then `raw_name` exactly as sent. No tidy step. The
payee gets `named_by = 'sync'`.

## 6. While a payee is new, its name follows Plaid

A payee is **new** while `named_by = 'sync'` and you haven't categorized any of its transactions (`docs/payees.md`
4.2). While it's new, its name is the name (5) of the row that made it, as Plaid sends that row now: when the row
comes again as `modified` with a better name, the payee takes it. Other rows don't change it. This fixes the Hulu case: the `modified` rows of Nov 2 would have renamed "Hlu Huluplus Hulu" to "Hulu".

- Not when that name belongs to another payee (by `payeeNameKey`): the name stays, and Activity offers **Same as
  your …? Join** (`docs/payees.md` 4.3), so the owner decides.
- Once you categorize one of its transactions, rename it or join it, the name is fixed. Sync never renames it
  again.

## 7. Payment apps

No special case. Plaid's names in the backup give one Venmo payee, and one Zelle payee per person and direction (67
rows, 6 payees). Per-person Venmo payees stay for later (`docs/payees.md` 10): Plaid's Venmo rows don't name the
person.

## 8. Existing payees and transactions

The owner chose (13): every existing transaction follows the new rules, at once, with no button or note. One alarm
job, run once after the migration.

1. **Fill `plaid_name`.** For each row, the job reads the page its last `bank_event` came from (`raw_ref`, page and
   index) and takes `name`. One page per step (up to about 220 KB); measured against 10 ms.
2. **Tell which names the owner chose.** All payees start as `user` (the column's default). The job sets `sync` on
   a payee unless an audit row shows a name you chose: a `payee.rename`, or a `payee.merge` whose name wasn't the
   name of one of the payees joined. In the backup that's 1 rename; Hulu's merge kept the app's name, so Hulu is
   `sync`. Renames through the transaction `payeeName` edit leave no audit row; the backup has none (every other
   payee's name is one the old rules made from its own rows). From then on, that edit sets `named_by = 'user'`.
3. **Re-file.** Behind the `processed_through` fence of every connection, as `healPending` is, so no sync of any
   connection runs at the same time:
   - A `user` payee keeps its name, its transactions and their keys.
   - Every other transaction is filed again by section 4, in date order, and each new payee is named by 5, then 6.
     Its category, memo, owed mark and every other part stay; a transaction's money never changes.
   - A `sync` payee left with no transactions is marked merged into the payee most of its rows went to, so links to
     it still resolve.
   - Old `d:` aliases stay until PR 3, so a code rollback of PR 2 still finds payees.
   - One audit row records the job. An Undo of a join made before the job is refused ("Can't undo now: this payee
     changed since.").

The phone downloads the changed payees, aliases and overlays once. In the backup: Hulu becomes one payee named
"Hulu".

## 9. The pending matcher without text

One rule for every pairing below: **the app pairs two rows by itself only on exact evidence. Otherwise it asks you
"Same purchase?"** and leaves both rows as they are until you answer. Nothing is paired from a look-alike text or
from an amount that is only close.

**Exact evidence** is one of:

- **Plaid's link** (`pending_transaction_id`), as now.
- **Same merchant:** the two rows share a key from section 4 (merchant id, or a Plaid name equal to a Plaid name).
  For your entry, its typed name equal to one of the bank row's Plaid names.
- **Same amount, same day:** equal amounts, and the same authorization day (else the same date).

**Candidates** (as now): same account and sign, amount within tolerance (exact for checks and ACH; for card
purchases within $5 or 25% either way, for tips and fuel holds), and dates that fit (a bank pending row authorized
the same day as the posted row or the day before, else dated 0–14 days before; an entry dated 0–14 days before, or
1 day after, the bank row).

### 9.1 "Same purchase?"

When a row has candidates but none with exact evidence, Activity's Needs attention shows one card per row: "Same
purchase? _your entry or the pending row_ and _the bank row_", with **Yes** and **No** (and the other candidates, if
there are several). Yes pairs them exactly as an automatic pair would; No remembers the answer for that pair, so it's
never asked again. Until you answer, both rows count, as they do today when nothing pairs. The existing
`ambiguous_match` alert (several rows with exact evidence and different edits) uses the same card.

Every pair, automatic or by Yes, has **Not the same** in the transaction's sheet, which undoes it and remembers No.
A pair made by Plaid's link has none: the link wins, and the next sync would pair them again. For a posted row and
the bank's pending row, the pending row keeps what you set on the pair and the posted row is filed as a new row
(D-65).

### 9.2 Your entry and the bank's pending row

**Today:** an entry (Add pending, or an Upcoming row) pairs only with a **posted** charge. When the bank also sends a
pending row, both count until the charge posts, and the bank's row keeps counting after that until the bank removes
it (hours or days at Bank of America).

**New:** when a bank pending row has exact evidence with an unmatched entry (or you answer Yes), the bank row is
**covered** by the entry:

- The bank row is hidden and stops counting. **Your entry keeps counting**, with your amount, category, memo,
  splits and owed marks. Nothing moves between rows, so nothing is lost.
- When the charge posts, the posted row pairs as today: with the bank row (by link or 9.3) or with the entry (step
  2). Either way it takes the **entry's** key (`inherit()` from the entry, as step 2 does now), and the covered bank
  row is claimed with it.
- If the bank removes its row before the charge posts, the entry is still there and still counts. If the bank sends
  a new pending row instead (an amount change), the entry can cover that one.

So each charge counts once: the entry until it posts, then the posted row.

**Order within a batch:** (1) Plaid's link; (2) posted rows and bank pending rows (9.3), where a posted row that
claims a covered row takes its entry's key; (3) posted rows and entries (step 2, today); (4) new bank pending rows
and entries (cover). Each step skips rows an earlier step claimed in the same batch. A posted row tries bank pending
rows before entries, so a leftover entry never takes a charge whose pending row is still counting.

Storage: `manual_pending.covers_provider_txn_id`, set on cover and cleared on Not the same, and a `not_same` table
(two row keys) for No answers. The views hide a bank
pending row that an unmatched entry covers. The heal step checks covers for the pending rows it already reads (one
connection, last 44 days).

### 9.3 A posted charge and the bank's pending row

Plaid's link decides when there is one. Bank of America almost never sends it (5 links in 181 posted rows). Without
the link, a candidate pairs on exact evidence (same merchant, or same amount and day); otherwise "Same purchase?"
(9.1). When several candidates have exact evidence, today's pairing stays: best score first (amount 50%, day 20%,
same merchant 30%), each row once, twins with nothing set paired without asking, and a close alternative with
different edits asked.

**Gone:** text likeness, store numbers, and the weighted score for entries (an entry pairs only on exact evidence or
your Yes).

**Backup check:** Bank of America's 5 unlinked pairs pair again by themselves: 3 by the same merchant name (two with a
tip), 2 by the same amount and day. A tipped charge whose pending row's Plaid name differs from its posted row's
(6 of 11 pairs in the backup have different names) would ask "Same purchase?"; the backup has no such case. No entry
in the backup met a bank pending row (1 of 5 entries matched a posted row; 3 were deleted by hand), so 9.2 isn't
checked against real data.

## 10. Backup check (Nov 4, 2026)

The owner's full backup (751 bank rows, 184 Plaid pages, 310 payees), read in a scratch session; nothing from it is
in the repo.

| Bank             | Rows (pending) | `merchant_name` | merchant id | `location.store_number` | `authorized_datetime` |
| ---------------- | -------------- | --------------- | ----------- | ----------------------- | --------------------- |
| Bank of America  | 194 (13)       | 185             | 46          | 9                       | 0                     |
| Wells Fargo      | 220 (0)        | 196             | 135         | 35                      | 0                     |
| Charles Schwab   | 181 (0)        | 45              | 28          | 0                       | 0                     |
| Citibank         | 78 (1)         | 56              | 24          | 35                      | 0                     |
| American Express | 57 (2)         | 32              | 25          | 0                       | 57                    |
| Chase            | 8 (0)          | 1               | 1           | 0                       | 5                     |
| SoFi             | 13 (0)         | 0               | 0           | 0                       | 0                     |

- Plaid's `name` is on every row, and equals the bank text on 297.
- No other field is worth adding: Bank of America sends no `authorized_datetime` and a store number on 1 of 13
  pending rows; `check_number` is on 1 row, `payment_meta` on none.
- A pending row's bank text never equals its posted row's (0 of 11 pairs).

## 11. Plan

Four PRs, in this order. Only the first has a migration, so the owner OKs one merge:

1. **Storage and Plaid's name** (3, 9.2, migration): `bank_txn.plaid_name`, `payee.named_by`,
   `manual_pending.covers_provider_txn_id`, the `not_same` table; `NormalizedTxn` and the import; part 1 of the job
   (8.1). No change on screen.
2. **Payees from Plaid** (4–8): keys, names, the new-payee rule, rename and join keys, the re-file job (parts 2 and
   3). `cleanDescription` stays only inside the matcher until PR 4.
3. **"Same purchase?" and covering** (9.1, 9.2): the card, Yes, No, Not the same, covering and the batch order.
4. **Pending matcher** (9.3): exact evidence only, the card for the rest; delete the cleanup code, the old `d:`
   aliases and their lookup.

Docs: decisions (`D-63-payee-names-from-plaid.md`, `D-65-pending-match-without-text.md`,
`D-64-entry-covers-bank-pending.md`) and entries in
`docs/whats-true-now.md` for `docs/design.md`, `docs/payees.md` (4) and `docs/sync-spec.md`. Delete the build-plan
line.

Tests:

- Domain: the keys of a row; the first key decides; the new-payee name follows the latest row and stops at the
  first categorization or rename; no rename into another payee's name; exact evidence only; several candidates; twins; an entry's
  typed name.
- Sync (`sync.test.ts`, `pending-match.test.ts`): the Hulu story ends as one payee named "Hulu"; a filed row never
  moves; a rename adds `n:<name>`, so the next row with that Plaid name finds it; Venmo rows are one payee and Zelle
  rows one per person; a tipped pending row with a different Plaid name asks "Same purchase?"; the D-47 and D-50 cases
  rewritten with Plaid fields; an entry covers the bank's pending row and the posted row takes the entry's key, in every
  order (posted with or without link, bank row removed first, a new pending id); a leftover entry never takes a
  posted row whose pending row still counts; Yes, No and Not the same.
- Phone (`engine.test.ts`): rename, join and the `payeeName` edit set `named_by`.
- The job: restart after a failed step; runs under the sync lock; a renamed payee keeps its rows and name; Hulu's
  merge counts as `sync`; categories, memos and owed marks unchanged on every moved row; old Undo refused; CPU per
  step.

## 12. Limits, and what's not in this change

- **CPU (10 ms).** Payee lookup reads only the batch's keys. The matcher compares keys instead of building trigrams.
  The job reads one page per step and is measured.
- **Plaid.** No new calls, links or products.
- **Not in this change:** per-person Venmo payees; splitting a joined payee; merchant logos; Plaid's category as a
  suggestion; payees for transfers and card payments (4, known gap).

## 13. The owner's answers (Nov 4, 2026)

1. **No cleanup** of bank text anywhere: payees and the pending matcher.
2. **Existing payees:** move every existing transaction to the new rules, at once, with no button or note (8).
3. **Joining:** a row joins a payee when any of its Plaid names equals one of the payee's keys exactly; no fuzzy
   joins (4).
4. **Plaid fields:** add none until checked against real data. Checked (10): only `name`.
5. **Pending matcher:** no test week. v6's three rules: OK (Nov 5). v7's rules (9): OK (Nov 5).
6. **Renames from a transaction's sheet:** none in the data (8).
7. **Payees with monthly names:** left as they are; no change to transfers (4).
8. **A manual entry and the bank's pending row:** fix the double count: OK (Nov 5). Covering (9.2): OK (Nov 5).

## 14. Reviews

### 14.1 v4 → v5

| #   | Severity | Finding                                                                                                                   | Change                                                                                                |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Blocker  | Live sync never re-files a row, so the Hulu story ended with two payees named "Hulu"                                      | A filed row never moves; a new payee's name follows Plaid but never takes another payee's name (4, 6) |
| 2   | Major    | The name-upgrade paths are skipped today (posted rows that take over a pending row, categorized rows)                     | Name upgrade only for new payees, from their own rows (6)                                             |
| 3   | Major    | Filing depends on arrival order (305 vs 306 payees)                                                                       | Stated and accepted (4)                                                                               |
| 4   | Major    | Names changed later without the owner, even after the owner OK'd them                                                     | Only while new; `name_source` and "posted over pending" dropped (6)                                   |
| 5   | Major    | Plaid's `name` often holds monthly digits: 40 payees in 8 groups                                                          | Stated; owner's question 3                                                                            |
| 6   | Major    | Job and deploy order: `named_by` unset, a half-rebuilt alias table, rollback after `d:` aliases are deleted               | Default `user`, job under the sync lock, `d:` aliases kept until PR 3 (3, 8)                          |
| 7   | Major    | The owner-named test needed a frozen cleaner and missed cases                                                             | Audit rows only; owner's question 2 (8)                                                               |
| 8   | Major    | Rename, join and Undo didn't add or restore keys, so a renamed payee got a twin                                           | Rename and join add `n:<name>`; Undo moves keys back (4)                                              |
| 9   | Major    | An unknown-merchant pending row with a tip never paired, so the charge counted twice until the bank removed it            | Rule 3: the only candidate on both sides pairs (9)                                                    |
| 10  | Major    | The manual-pending score used a payee that doesn't exist yet at that step                                                 | Plaid names only (9)                                                                                  |
| 11  | Minor    | "Different merchant ids never pair" conflicted with payee joins (one name, two ids)                                       | Dropped (9)                                                                                           |
| 12  | Minor    | The new columns do reach the phone; the engine writes `named_by`                                                          | Fixed (3)                                                                                             |
| 13  | Minor    | Every alias loaded on every batch, and `t:` aliases grew without limit                                                    | Indexed lookup of the batch's keys; no `t:` key (4)                                                   |
| 14  | Minor    | The stop list matched 0 rows                                                                                              | Dropped                                                                                               |
| 15  | Minor    | The job replayed pages with no tie-break                                                                                  | Reads each row's `raw_ref` (8)                                                                        |
| —   | Simpler  | `counterparty_name` equals `merchant_name` wherever present; `t:` keys change nothing when Plaid's `name` is on every row | Both dropped (3, 4)                                                                                   |

### 14.2 v6 → v7

| #   | Severity | Finding                                                                                                                                                       | Change                                                                                  |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | Blocker  | v6 didn't say where entry pairing runs among the steps; in one batch a linked posted row and the entry's new key on its pending row made both count, for good | Batch order stated; each step skips rows claimed earlier (9.2)                          |
| 2   | Major    | A leftover entry (two entries, or an entry dated a day late) took the posted row while the bank's pending row kept counting                                   | Posted rows try bank pending rows first; entries may be 1 day after the bank row (9)    |
| 3   | Major    | When the bank removed or re-issued its pending row before posting, the charge counted zero and edits could be lost                                            | The entry covers the bank row and keeps counting; nothing moves onto the bank row (9.2) |
| 4   | Major    | `inherit()` clears the estimate and won't clear, raises alerts and writes links; editing or deleting a paired entry broke                                     | No `inherit()` until the charge posts; the entry stays the row you edit (9.2)           |
| 5   | Major    | No way to undo a wrong pair; "you're asked" was only an alert; an entry could pair on a close amount alone                                                    | Exact evidence only; "Same purchase?" with Yes and No; Not the same (9.1)               |
| 6   | Major    | Rule 3 ("only candidate") depended on what the batch loaded, and was a guess from a close amount                                                              | Dropped; asks instead (9.3)                                                             |
| 7   | Minor    | Rows that take over an entry's overlay never got a payee                                                                                                      | Filed then (4)                                                                          |
| 8   | Minor    | One connection's lock doesn't stop the other six syncs during the job                                                                                         | Behind every connection's fence (8)                                                     |
| 9   | Minor    | Tolerance is both ways; "latest row" unclear; heal window is 44 days                                                                                          | Fixed (6, 9)                                                                            |
