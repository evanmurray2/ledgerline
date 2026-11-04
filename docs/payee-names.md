# Payee names from Plaid, and no cleanup of bank text

Status: proposal, v4, Nov 4, 2026. Not built. Asked by the owner after a Hulu charge arrived as "Hlu Huluplus Hulu".
The owner's answers are in section 13: no cleanup of bank text anywhere (payees and the pending matcher), the bank's
own text as the last resort, every existing transaction moved to the new rules without a button, and payees joined
when any of their Plaid names match exactly. v4 adds a check against the owner's backup of Nov 4 (section 10). This
changes section 4 of `docs/payees.md`, the Payee normalization steps in `docs/design.md`, and one row of Matching
mechanics in `docs/sync-spec.md` (D-47, D-50).

**Does this change how money is counted?** Payee names and keys (sections 3–8): no. The pending matcher (section
9): yes, it changes which bank pending row a posted charge replaces when the bank sends no link between them. That
needs the owner's OK (section 13) before it's built. Every posted charge still counts exactly once.

## 1. What happened to Hulu

The owner's backup shows the whole story:

1. **Nov 1, first link.** Plaid sent the Amex history without merchant names (its enrichment wasn't done yet). Sync
   made payees from the cleaned bank text: `HLU*HULUPLUS HULU.COM/BILL CA` became "Hlu Huluplus Hulu", and
   `HULU SANTA MONICA CA` became "Hulu", two payees.
2. **Nov 2, six hours later.** Plaid sent the same rows again as `modified`, now with `merchant_name` "Hulu" and a
   merchant id. Sync stored them, but never names or re-keys a payee after it's made (`payee_id = coalesce(...)` in
   `process.ts` step 5), so nothing changed.
3. **Nov 2, a merge.** The old Payees page's suggestion card (`clusterPayees`, since removed) offered to merge the two
   under the name it had made, "Hlu Huluplus Hulu", and the merge was accepted with that name. 17 merges were made
   in all; 1 payee was renamed by hand.

So two things went wrong: the app made a name from the bank text, and a better name from Plaid that came later was
ignored. Both are fixed below. Today's code also keeps only one of Plaid's texts (`rawName:
t.original_description ?? t.name`, `packages/bank-provider/src/plaid.ts`), so Plaid's short `name` is lost.

## 2. The principle we drop, and the one that replaces it

**Dropped:** the app cleans up the bank's raw text and decides from it who the payee is, what it's called, and which
pending row a posted charge replaces.

**New:** the app never edits, cleans or scores bank text. It uses what Plaid sends as Plaid sends it, and compares
values only for equality. When Plaid gives no name, the payee is the bank's text exactly as sent. The only other
change to a name is the owner renaming a payee.

**Equal** means equal by `payeeNameKey`: case, outer spaces and curly or straight apostrophes are ignored, nothing
else. "Hulu" equals "HULU"; "Shell" doesn't equal "Shell Oil".

### 2.1 What goes, and what stays

**Deleted:** `cleanDescription`, `titleCase`, `trigrams`, `similarity`, `jaccard`, `clusterPayees` and `payeeKey`'s
`d:` key (`packages/domain/src/payee.ts`), and `storeNumbers` and the trigram cache (`matcher.ts`). Their tests go
with them.

**Stays:** `samePayeeName` and `payeeNameKey`. Two word tests on the raw text also stay, since they read the text and
change nothing: `channel()` (`CHK`, `CHECK`, `ACH` set the amount tolerance) and `P2P` (payment-app money in waits to
match).

## 3. What we store

One budget migration adds two columns to `bank_txn`, filled from the same Plaid response:

| Column              | From Plaid                                          | Backup, Nov 4: rows that have it |
| ------------------- | --------------------------------------------------- | -------------------------------- |
| `plaid_name`        | `name`                                              | 751 of 751                       |
| `counterparty_name` | the first `counterparties[]` with `type = merchant` | 503 of 751                       |

`raw_name`, `merchant_name` (515 of 751) and `merchant_entity_id` (259 of 751) stay as they are. `NormalizedTxn`
gains the two fields; `bank_event` payloads carry them like the others, so `steps.ts` writes them with
`json_extract` as it does now. No other Plaid field is added (section 10.3 says why).

And to `payee`:

| Column        | Values           | Notes                                                                                                     |
| ------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `named_by`    | `sync` or `user` | `sync` when sync made the name. A rename, a join and the transaction `payeeName` edit set `user`          |
| `name_source` | 1–4              | Which place in the list in 5 the name came from, while `named_by = 'sync'`; lets a better name replace it |

These columns stay on the server: payees are made only by sync processing, and the phone already gets payee names.
Nothing new is synced, and `engine.test.ts` doesn't change.

## 4. Who the payee is (identity)

Each transaction has up to five keys:

| Key                      | From                                   |
| ------------------------ | -------------------------------------- |
| `m:<merchant_entity_id>` | Plaid's merchant id                    |
| `n:<name>`               | `merchant_name`, by `payeeNameKey`     |
| `n:<name>`               | `counterparty_name`, by `payeeNameKey` |
| `n:<name>`               | `plaid_name`, by `payeeNameKey`        |
| `t:<bank text>`          | `raw_name`, exactly as sent            |

The three names share one `n:` space, so "Hulu" as a merchant name and "Hulu" as Plaid's short name are the same key.

**Filing a row:** sync looks up the keys in the order above and takes the first that has an alias. Then it adds an
alias for each of the row's keys that no payee has yet. If none matches, it makes a payee (5) with all the row's keys.

- **Any exact name joins.** A row whose merchant name, counterparty name or Plaid name equals a key of an existing
  payee goes to that payee, and brings its other keys with it. That's how the Nov 1 Hulu rows and the Nov 2 ones
  become one payee, and how one chain's stores become one payee.
- **Existing payees are never joined by sync.** If a row's keys point at two different payees, it goes to the first
  in the order above, and the key that points elsewhere stays where it is. Only the owner joins two payees (rename,
  or **Join**, `docs/payees.md` 4.3, 5). The backup has no row like this (10.2).
- **Never a key:** a name on the stop list (Payment, Transfer, Deposit, Withdrawal, Interest, Fee, Check, Online
  Transfer, ACH, Debit, Credit; exact names, any case). Such a row is still filed by its other keys.
- **Renames don't break it.** Aliases point at the payee's id. After the owner renames "Hulu" to "Streaming: Hulu",
  new Hulu rows still match `n:hulu`.

Keys go in `payee_alias.pattern` with their prefix (`m:` stays in `merchant_entity_id`); no new table.

## 5. What the payee is called (names)

For a new payee, the first of these that is present:

1. `merchant_name`
2. `counterparty_name`
3. `plaid_name`
4. `raw_name`, exactly as the bank sent it

No tidy step: the name is shown as Plaid or the bank wrote it. The payee gets `named_by = 'sync'` and its
`name_source`.

## 6. A better name arriving later

Plaid often sends a row first with less data (the first link, a pending row) and again later with more (a
`modified` event, the posted row). Sync now looks again whenever a row of a `sync`-named payee arrives or changes:

- **A higher place.** If the row has a name from a higher place in the list in 5 than the payee's `name_source`, the
  payee takes that name. On Nov 2, the `modified` Hulu rows would have renamed "Hlu Huluplus Hulu" (place 4) to "Hulu"
  (place 1).
- **Posted over pending.** At the same place, a posted row's name replaces a name taken from a pending row: Plaid's
  posted names are the settled ones. (In the backup, one pending row had a processor prefix in its merchant name that
  the posted row didn't.)
- **New keys.** The row's keys that no payee has yet become aliases of the payee.

A posted row still keeps its pending row's payee, as now. A payee with `named_by = 'user'` is never renamed by sync.

## 7. Payment apps

No special case. The backup shows what Plaid sends: payment-app rows have no merchant id and no merchant name; their
Plaid name is the app ("Venmo") or the app and the person ("Zelle from …", "Zelle to …"). So the rules in 4 give one
Venmo payee, and one Zelle payee per person and direction. In the backup, 67 payment-app rows become 6 payees. The
bank text alone would have made about 50 (each Venmo text carries a date), which is why the names come first.

Per-person Venmo payees stay for later (`docs/payees.md` 10): Plaid's Venmo rows don't name the person.

## 8. Existing payees and transactions

The owner chose (13): every existing transaction follows the new rules, at once, with no button or note. One alarm
job, run once after the migration, in three parts. Each part works in chunks under 10 ms of CPU and is measured
(`docs/measurements.md`); the job records its progress, so a failed step picks up where it stopped.

1. **Fill the new columns.** `raw_page` keeps every Plaid page as sent (append-only). The job reads the pages in
   order, takes `name` and the merchant counterparty of each transaction (the latest version wins), and fills
   `plaid_name` and `counterparty_name`. No new Plaid calls. In the backup, all 751 rows are in the 184 stored pages.
2. **Tell which names the owner chose.** A payee is `user`-named when its name is not what the old rules would have
   made from any of its rows (`merchant_name`, or `titleCase(cleanDescription(raw_name))`). An audit row isn't
   enough: the 17 merges in the backup include Hulu's, made under the app's own name. This test catches renames through the transaction `payeeName` edit, which writes no audit row, too. It
   needs the old rules once, so the job carries a frozen copy of `cleanDescription` and `titleCase`, deleted in PR 4
   (11). All other payees are `sync`-named.
3. **Re-file every transaction.** All aliases are rebuilt:
   - A `user`-named payee keeps its name and its transactions, and their keys become its aliases first.
   - Every other transaction is filed again by sections 4–7, in date order, as if it had just arrived. Its payee may
     change. Its category, memo, owed mark and every other part stay; a transaction's money never changes.
   - Old `d:` aliases are deleted. A `sync`-named payee left with no transactions is marked merged into the payee
     most of its rows went to, so links to it still resolve.
   - A posted row whose pending row was re-filed follows it, as now.
   - One audit row records the job (`payee.refile`, counts only). An Undo of a join made before the job is refused
     ("Can't undo now: this payee changed since."), since the aliases it would restore are gone.

In the backup: 310 payees today, 302 after. Hulu becomes one payee named "Hulu".

## 9. The pending matcher without text

### 9.1 Where text matters today

| Case                                             | Text used today                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Posted row with Plaid's `pending_transaction_id` | None: the link decides                                                                                      |
| Posted row without the link (D-47)               | A gate (cleaned trigram likeness ≥ 0.4 unless amount and day agree), store numbers (D-50), 30% of the score |
| Manual pending row you entered                   | 30% of the score (likeness of your typed name to the posted text)                                           |
| Orphan (a removed pending row, no link)          | 30% of the score, only to break a tie                                                                       |
| Re-issued posted row                             | None                                                                                                        |

In the backup, only Bank of America and Amex sent pending rows (13 and 2; one at Citi). Bank of America linked 5
posted rows to their pending rows and left 5 unlinked; the matcher paired those.

### 9.2 Same merchant, different merchant, or unknown

Two rows are **the same merchant** when they share a key from section 4 other than `t:` (a merchant id, or any name
equal to any name, the stop list aside). They're **different merchants** when both have a merchant id and the ids
differ. Otherwise the app doesn't know, and says so: it never guesses from the text.

The bank text is never a match key here: in the backup, a pending row's text never equals its posted row's (0 of 11
pairs; the posted text adds the city, a phone number or a processor prefix).

### 9.3 The rules

**Posted row without the link (replaces the D-47 and D-50 row).** A bank pending row is a candidate when, as now, it's
in the same account with the same sign, the amount is within tolerance, and the dates fit (authorized on the posted
row's authorization day or the day before; else dated 0–14 days before). Then:

1. Different merchants: never a candidate.
2. Same merchant: a candidate.
3. Unknown merchant: a candidate only when the amount and the day agree exactly (today's exception, kept).
4. Otherwise not a candidate. The pending row stays until the bank removes it, as an unlike-named one does today, and
   the heal step tries again on later syncs.

Among candidates, today's pairing stays: best score first, each row once, asking (`ambiguous_match`) only when a
close alternative carries different edits; twins with nothing set pair without asking. The score's name part becomes
1 for the same merchant and 0 otherwise (amount 50%, day 20%, name 30%, as now). Store numbers go: two branches of one
chain, both pending for the same amount, are twins; they pair without asking unless you've edited one, and then
you're asked.

**Manual pending row.** Eligibility doesn't change (it never used text). The name part of the score is 1 when your
typed name equals one of the posted row's names (its payee name or a Plaid name), else 0. Auto-match still needs a
unique best on both sides, else you're asked.

**Orphan.** Same score; a tie is still "ambiguous".

### 9.4 What changes for the owner

- In the backup, the new rules make the same 5 pairs the matcher made: 3 by the same merchant name (two of them with a
  tip added), 2 by the exact amount and day.
- Two different stores can't pair on a look-alike text, and a merchant-id mismatch is a hard no.
- A pending row whose merchant Plaid can't name, and whose amount changed (a tip), now stays beside its posted row
  until the bank removes it. The backup has none. Pairing by hand is an open item in `docs/build-plan.md`.

### 9.5 Watch it for a week

The backup has only 5 such pairs, over three days. So PR 3 runs the new rules beside the old ones for one
week on every sync, and records only counts (pairs both made, pairs only the old rules made, only the new, conflicts)
as a usage event with fixed ids. No names or amounts leave the store. If "only the old rules" is more than a few a
week, the owner decides whether to switch (13). Then PR 4 deletes the old rules and the shadow run.

## 10. Check against the owner's backup (Nov 4, 2026)

The owner's full backup (751 bank rows, 184 Plaid pages, 310 payees), read in a scratch session; nothing from it is in
the repo. Counts only.

### 10.1 What Plaid sends, by bank

| Bank             | Rows (pending) | `merchant_name` | merchant id | merchant counterparty | `location.store_number` | `authorized_datetime` |
| ---------------- | -------------- | --------------- | ----------- | --------------------- | ----------------------- | --------------------- |
| Bank of America  | 194 (13)       | 185             | 46          | 174                   | 9                       | 0                     |
| Wells Fargo      | 220 (0)        | 196             | 135         | 196                   | 35                      | 0                     |
| Charles Schwab   | 181 (0)        | 45              | 28          | 44                    | 0                       | 0                     |
| Citibank         | 78 (1)         | 56              | 24          | 56                    | 35                      | 0                     |
| American Express | 57 (2)         | 32              | 25          | 32                    | 0                       | 57                    |
| Chase            | 8 (0)          | 1               | 1           | 1                     | 0                       | 5                     |
| SoFi             | 13 (0)         | 0               | 0           | 0                     | 0                       | 0                     |

Plaid's `name` is on every row. `check_number` is on 1 row, and `payment_meta`'s reference number, payer and payee on
none.

### 10.2 The new payee rules on this data

- 310 payees today, 302 after. No row's keys point at two different payees.
- 4 payees have rows with more than one merchant name, joined through another of their names: a pending/posted pair
  with a processor prefix only on the pending row, a pair where the pending row lost an apostrophe, a store whose
  merchant name sometimes includes its city, and a store with its paid membership (the membership's Plaid name is the
  store's). The first three are right; the owner can split the last by hand when splitting exists, or leave it.
- 67 payment-app rows become 6 payees (7).

### 10.3 Why no other Plaid field is added

- `authorized_datetime` (the time of the purchase) would be strong evidence for pairing, but Bank of America, the only
  bank that needs the fallback, sends it on no row.
- `location.store_number` is on 1 of Bank of America's 13 pending rows, so it can't replace the store-number check;
  the merchant-id test covers what it was for.
- `check_number` and `payment_meta` are almost never sent.
- `logo_url` and `website` are on rows with a merchant id only; they need a design first.

## 11. Plan

Four PRs, deployed in this order:

1. **Store Plaid's names** (3, migration): the two columns, `NormalizedTxn`, the import, and part 1 of the job (8.1).
   No change on screen. The owner OKs the merge, since it adds a migration.
2. **Name and key payees from Plaid** (4–7) and **re-file existing payees** (8.2, 8.3). `named_by` set by rename,
   join and the `payeeName` edit. `cleanDescription`, `titleCase`, `clusterPayees` and `payeeKey`'s `d:` key go,
   except the job's frozen copy.
3. **Shadow-run the new pending rules** (9.5), after the owner's OK to section 9.
4. **Switch the pending matcher** (9.3), after the week's counts: delete the trigram and store-number code, the
   shadow run and the job's frozen copy. Update the Matching mechanics row in `docs/sync-spec.md` through a decision
   that changes D-47 and D-50.

Docs: decisions (`docs/decisions/D-?-payee-names-from-plaid.md`, `docs/decisions/D-?-pending-match-without-text.md`)
and entries in `docs/whats-true-now.md` for `docs/design.md` (Payee normalization), `docs/payees.md` (4) and
`docs/sync-spec.md` (Matching mechanics). Delete the build-plan line.

Tests:

- Bank provider: `normalizePlaidTxn` takes `name` and the first merchant counterparty.
- Domain: the keys of a row; the name order; the stop list; same, different and unknown merchant; the new candidate
  rules; twins from one chain; merchant-id mismatch refused even with exact amount and day; manual pending scored by
  name equality.
- Sync (`sync.test.ts`, `pending-match.test.ts`): the Hulu story of section 1 ends as one payee named "Hulu"; a
  `modified` row with a merchant name renames a payee named from the bank text; a posted row's name replaces its
  pending row's at the same place; a `user` name is never changed; a row matching two payees joins neither; Venmo rows
  are one payee and Zelle rows one per person; "Payment" is never a key; the D-47 and D-50 cases rewritten with Plaid
  fields.
- The job: pages with and without `counterparties`; restart after a failed step; a `user`-named payee keeps its rows
  and name; a payee merged under the app's own name is `sync`-named; category, memo and owed marks unchanged on every
  moved row; old Undo refused; measured CPU.

## 12. Limits, and what's not in this change

- **CPU (10 ms).** Payee lookup is at most five map lookups per row; the matcher compares keys instead of building
  trigrams, which is cheaper. The job is chunked and measured. The shadow run doubles the matcher's work for one week;
  measure it.
- **Phone.** Nothing new synced (3). Moved transactions reach the phone through the normal sync of `txn_overlay`.
- **Plaid.** No new calls, links or products.
- **Not in this change:** per-person Venmo payees; splitting a payee that's already joined; merchant logos; Plaid's
  `personal_finance_category` as a category suggestion; replacing the `CHECK`/`ACH` and payment-app word tests.

## 13. The owner's answers (Nov 4, 2026)

1. **No cleanup** of bank text anywhere: payees and the pending matcher. The bank's text as sent is the last resort
   for a payee's name and key.
2. **Existing payees:** move every existing transaction to the new rules, at once, with no button or note (8).
3. **Joining:** a fuzzy "same merchant name" join felt like guessing. Instead, a row joins a payee when any of its
   Plaid names equals one of the payee's exactly (4).
4. **Plaid fields:** add none until checked against real data. Checked (10): only `name` and the merchant
   counterparty are added.
5. **Pending matcher (section 9): waiting for the owner's OK**, since it changes which rows pair.
