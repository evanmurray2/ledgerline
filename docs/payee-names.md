# Payee names from Plaid, and no cleanup of bank text

Status: proposal, v6, Nov 5, 2026. Not built. Asked by the owner after a Hulu charge arrived as "Hlu Huluplus Hulu".
v5 followed an adversarial review of v4 and is simpler: two keys instead of five, no stop list, no name ranks, and
a pending matcher with three plain rules. v6 adds the owner's answers of Nov 5 and one more fix: a manual entry now
pairs with the bank's pending row (9.1). Reviews are in section 14. The owner's answers are in section 13. This changes section 4 of
`docs/payees.md`, the Payee normalization steps in `docs/design.md`, and one row of Matching mechanics in
`docs/sync-spec.md` (D-47, D-50).

**Does this change how money is counted?** Payee names and keys (sections 3–8): no. The pending matcher (section
9): yes. It changes which bank pending row a posted charge replaces when the bank sends no link, and it pairs a
manual entry with the bank's pending row so the two stop counting twice. The owner OK'd both (13). Every posted
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
  takes over its pending row, or a row you categorized keeps its payee, as today.
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
4.2). While it's new, each sync sets its name to the name (5) of its latest row, including a row's `modified`
version. This fixes the Hulu case: the `modified` rows of Nov 2 would have renamed "Hlu Huluplus Hulu" to "Hulu".

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
3. **Re-file.** Under the connection's sync lock, so no sync runs at the same time:
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

### 9.1 A manual entry and the bank's pending row

**Today:** a manual entry (Add pending, or an Upcoming row) pairs only with a **posted** charge (`process.ts` step 2).
When the bank also sends a pending row for the same purchase, both count in the budget. When the charge posts, it
pairs with the manual entry, and the bank's pending row still counts until the bank removes it, which takes hours or
days at Bank of America. The design never paired the two: it expected you to edit the bank's pending row instead of
adding one. In practice you add the entry first, before the bank shows anything.

**New:** when a bank pending row arrives, it can pair with an unmatched manual entry, by the same rules as a posted
charge today: same account and sign, amount within tolerance, the pending row dated 0–14 days on or after the entry,
and a unique best score on both sides (amount 50%, day 20%, name 30%, where name is 1 when your typed name equals one
of the pending row's Plaid names); several close candidates are asked (`ambiguous_match`).

When they pair:

- The bank's pending row takes the entry's `txn_key`, as a posted row does today, so it carries your category, memo,
  splits and owed marks. The entry is marked matched and stops counting.
- Your amount becomes the pending row's estimate, as if you had edited the bank's amount ("override a bank pending
  amount", `docs/design.md` Pending), so a tip you entered keeps counting until the charge posts.
- When the charge posts, it replaces the bank's pending row by Plaid's link or by 9.2, and with it your entry. Each
  charge counts once at every step.

The heal step at the end of each sync also looks at unmatched entries, so entries made before this change pair on
the next sync.

### 9.2 A posted charge and the bank's pending row

Most banks send Plaid's link (`pending_transaction_id`) from a posted row to its pending row, and the link decides,
as now. Bank of America almost never does (5 links in 181 posted rows), so it needs these rules.

**Candidates (as now):** same account and sign, amount within tolerance (exact for checks and ACH; for card
purchases up to $5 or 25% more, for tips and fuel holds), and dates that fit (authorized the same day or the day
before; without an authorization date, 0–14 days before).

**A candidate pairs when one of these holds:**

1. **Same merchant:** the rows share a key from section 4 (merchant id, or a Plaid name equal to a Plaid name).
2. **Same amount, same day:** the amounts are equal and the authorization days (else the dates) are the same (as
   now).
3. **No doubt:** it's the only candidate for the posted row, and the posted row is the only candidate for it.

Otherwise it doesn't pair; the pending row stays until the bank removes it, and the heal step tries again.

**Several candidates** (as now): best score first, each row once (amount 50%, day 20%, same merchant 30%). Twins
with nothing set pair without asking; when a close alternative carries different edits, you're asked
(`ambiguous_match`).

**Manual pending row:** as now, except the name part of the score: 1 when your typed name equals one of the posted
row's Plaid names, else 0.

**Gone:** text likeness and store numbers.

**Backup check:** Bank of America's 5 unlinked pairs all pair again: 3 by the same merchant name (two with a tip),
2 by the same amount and day (one of them also by rule 3). The other day's rows had 3 or 4 candidates each, so rule 3
alone wouldn't have paired them. Rule 3 is for a tipped charge whose pending row's Plaid name differs from the posted
row's (6 of 11 pairs in the backup differ): without it, the charge counts twice until the bank removes the pending
row. The backup has no such case.

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

Four PRs:

1. **Store Plaid's name** (3, migration): `plaid_name`, `named_by`, `NormalizedTxn`, the import, and part 1 of the
   job. No change on screen. The owner OKs the merge, since it adds a migration.
2. **Payees from Plaid** (4–8): keys, names, the new-payee rule, rename and join keys, the re-file job (parts 2 and
   3). `cleanDescription` stays only inside the matcher until PR 3.
3. **Pending matcher** (9.2): delete the cleanup code, the old `d:` aliases and their lookup. A decision changes
   D-47 and D-50 in `docs/sync-spec.md`.
4. **Manual entry and bank pending** (9.1): its own decision and a new Matching mechanics row in
   `docs/sync-spec.md`. It doesn't depend on PRs 1–3 and can go first.

Docs: decisions (`D-?-payee-names-from-plaid.md`, `D-?-pending-match-without-text.md`,
`D-?-manual-entry-meets-bank-pending.md`) and entries in
`docs/whats-true-now.md` for `docs/design.md`, `docs/payees.md` (4) and `docs/sync-spec.md`. Delete the build-plan
line.

Tests:

- Domain: the keys of a row; the first key decides; the new-payee name follows the latest row and stops at the
  first categorization or rename; no rename into another payee's name; the matcher's three rules, several candidates,
  twins, manual pending.
- Sync (`sync.test.ts`, `pending-match.test.ts`): the Hulu story ends as one payee named "Hulu"; a filed row never
  moves; a rename adds `n:<name>`, so the next row with that Plaid name finds it; Venmo rows are one payee and Zelle
  rows one per person; a tipped pending row with a different Plaid name pairs by rule 3 when it's the only candidate; the D-47 and D-50 cases
  rewritten with Plaid fields; a manual entry pairs with the bank's pending row, which carries its edits and amount, and
  then with the posted charge, counting once throughout; two close entries are asked; an old entry pairs on the heal
  step.
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
5. **Pending matcher:** no test week. The three rules in 9.2: OK (Nov 5).
6. **Renames from a transaction's sheet:** none in the data (8).
7. **Payees with monthly names:** left as they are; no change to transfers (4).
8. **A manual entry pairs with the bank's pending row** (9.1): OK (Nov 5).

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
