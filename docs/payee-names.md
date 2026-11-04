# Payee names from Plaid, and no cleanup of bank text

Status: proposal, v3, Nov 4, 2026. Not built. Asked by the owner after a Hulu charge arrived as "Hlu Huluplus Hulu"
while the bank showed "Hulu". The owner's answers so far are in section 12: no cleanup of bank text anywhere (payees
and the pending matcher), the bank's own text as the last resort, every existing transaction moved to the new rules
without a button, and no joining of payees by name. This changes section 4 of `docs/payees.md`, the Payee
normalization steps in `docs/design.md`, and one row of Matching mechanics in `docs/sync-spec.md` (D-47, D-50).

**Does this change how money is counted?** Payee names and keys (sections 3–8): no. The pending matcher (section
9): yes, it changes which bank pending row a posted charge replaces when the bank sends no link between them. That
needs the owner's OK (section 13) before it's built. Every posted charge still counts exactly once.

## 1. What happens today

Take a Hulu charge. Plaid sends three texts for it:

| Plaid field            | Example                         | What we do with it                          |
| ---------------------- | ------------------------------- | ------------------------------------------- |
| `original_description` | `HLU*HULUPLUS HULU.COM/BILL CA` | Stored as `bank_txn.raw_name`               |
| `name`                 | `Hulu`                          | Thrown away                                 |
| `merchant_name`        | often empty for this charge     | Stored as `bank_txn.merchant_name` when set |

1. The import asks for the raw text (`include_original_description: true`, `packages/bank-provider/src/plaid.ts`)
   and keeps it before Plaid's `name` (`rawName: t.original_description ?? t.name`). Only one of the two is stored,
   so Plaid's short name is lost.
2. Sync finds the payee by Plaid's `merchant_entity_id`, then by a key made from the cleaned raw text (`payeeKey`,
   `packages/domain/src/payee.ts`).
3. The first time neither key is known, sync makes a payee named `merchant_name`, or else
   `titleCase(cleanDescription(raw))` (`apps/worker/src/sync/process.ts`, step 5). `cleanDescription` doesn't know
   `HLU*` is a processor prefix, so the result is "Hlu Huluplus Hulu".
4. A posted row keeps the payee of the pending row it replaces. Pending rows often have less enrichment than posted
   ones, so a weak name made from the pending text sticks even when the posted row has a good merchant name.
5. The pending matcher (`packages/domain/src/matcher.ts`) uses the same cleanup: it compares cleaned trigrams of the
   two texts and the store numbers it finds in them (D-47, D-50).

## 2. The principle we drop, and the one that replaces it

**Dropped:** the app cleans up the bank's raw text and decides from it who the payee is, what it's called, and
which pending row a posted charge replaces.

**New:** the app never edits, cleans or scores bank text. It uses what Plaid sends as Plaid sends it, and compares
values only for equality. When Plaid gives no name, the payee is the bank's text exactly as sent. The only other
change to a name is the owner renaming a payee (which joins payees with the same name, `docs/payees.md` 5).

Why:

- Plaid already does merchant cleanup across millions of accounts, with a merchant id per brand. Our regex cleaner
  can't keep up (every processor prefix: `SQ *`, `TST*`, `HLU*`, `AMZN MKTP US*`, `DD *` …) and costs CPU.
- Its `name` is short and readable even when it has no merchant id ("Hulu", "Shell", "Uber").
- It's free: the same `/transactions/sync` response, on the Trial plan, with nothing new to call.

### 2.1 What goes, and what stays

**Deleted:** `cleanDescription`, `titleCase`, `trigrams`, `similarity`, `jaccard`, `clusterPayees` and `payeeKey`'s
`d:` key (`packages/domain/src/payee.ts`), and `storeNumbers` and the trigram cache (`matcher.ts`). Their tests go
with them.

**Stays:** `samePayeeName` and `payeeNameKey` (case, outer spaces and the two apostrophes only; used when the owner
renames). Two word tests on the raw text also stay, since they read the text and change nothing: `channel()` (`CHK`,
`CHECK`, `ACH` set the amount tolerance) and `P2P` (payment-app money in waits to match). Replacing them with Plaid's
`check_number` and counterparty type can come later (12).

## 3. What we store

One budget migration adds to `bank_txn`, filled from the same Plaid response:

| Column              | From Plaid                                             | Notes                                       |
| ------------------- | ------------------------------------------------------ | ------------------------------------------- |
| `plaid_name`        | `name`                                                 | Plaid's short name; may be absent           |
| `counterparty_name` | the first `counterparties[]` with `type = merchant`    | Often set when `merchant_name` isn't        |
| `counterparty_type` | that entry's `type`, or `payment_app` if one is listed | Lets sync spot payment apps without a regex |

`raw_name`, `merchant_name` and `merchant_entity_id` stay as they are. `NormalizedTxn` gains the three fields;
`bank_event` payloads carry them like the others, so `steps.ts` writes them with `json_extract` as it does now.

And to `payee`:

| Column        | Values           | Notes                                                                                                     |
| ------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `named_by`    | `sync` or `user` | `sync` when sync made the name. A rename, a join and the transaction `payeeName` edit set `user`          |
| `name_source` | 1–4              | Which place in the list in 5 the name came from, while `named_by = 'sync'`; lets a better name replace it |

These columns stay on the server: payees are made only by sync processing, and the phone already gets payee names.
Nothing new is synced, and `engine.test.ts` doesn't change.

## 4. Who the payee is (identity)

Two keys, tried in order:

1. `m:<merchant_entity_id>`, as now: Plaid's own id for the merchant.
2. `t:<bank text>`: the raw text exactly as sent. Replaces today's `d:` key made from the cleaned text.

When neither key matches an alias, sync makes the payee (5) and writes an alias for each key the row has. A name is
never a key: two payees with the same name stay two payees until the owner renames one to join them. So the app
never joins payees on its own.

What this means:

- Rows that share a Plaid merchant id are one payee, whatever their text.
- Without a merchant id, two texts that differ in any way (`SQ *BLUE BOTTLE 0123` and `SQ *BLUE BOTTLE 0456`) are two
  payees. If both get the name "Blue Bottle Coffee" from Plaid, they show the same name and stay apart. Renaming
  one to "Blue Bottle Coffee" on purpose joins them (`docs/payees.md` 5); the Rename sheet already warns "You have a
  payee named …", and `docs/payees.md` 4.3 already offers **Join** on a new payee whose name matches one you have
  categorized. Both are the owner's choice, never automatic.

`t:` keys go in `payee_alias.pattern` with their prefix; no new table.

## 5. What the payee is called (names)

For a new payee, the first of these that is present:

1. `merchant_name`
2. `counterparty_name`
3. `plaid_name`
4. `raw_name`, exactly as the bank sent it

No tidy step: the name is shown as Plaid or the bank wrote it ("HULU", "McDonald's", "SQ \*BLUE BOTTLE 0123").

The payee gets `named_by = 'sync'` and `name_source` 1–4.

## 6. A better name arriving later

Pending rows and the first row from a new merchant often come with less data than later rows. When sync files a row
under a payee with `named_by = 'sync'`:

- If the row has a name from a higher place in the list in 5 than the payee's `name_source`, sync renames the payee
  to it and lowers `name_source`. A payee named from the bank text (place 4) becomes "Hulu" (place 1, 2 or 3).
- It adds the row's other key as an alias, unless another payee already owns it.
- A posted row still keeps its pending row's payee, as now.

A payee with `named_by = 'user'` is never renamed by sync.

## 7. Payment apps

Today's behaviour stays (one payee per app, through the app's merchant id), and `docs/payees.md` section 10 still
leaves per-person payees for later. One guard: sync never adds an `m:` alias from a payment-app row
(`counterparty_type = 'payment_app'`, or the `P2P` words) to a payee other than the app's, so the app's merchant id
can't move to a person's payee.

## 8. Existing payees and transactions

The owner chose (13): every existing transaction follows the new rules, at once, with no button or note. One alarm
job, run once after the migration, in three parts. Each part works in chunks under 10 ms of CPU and is measured
(`docs/measurements.md`); the job records its progress, so a failed step picks up where it stopped.

1. **Fill the new columns.** `raw_page` keeps every Plaid page as sent (append-only). The job reads each page, takes
   `name` and `counterparties` per transaction, and fills `plaid_name`, `counterparty_name` and `counterparty_type`.
   No new Plaid calls.
2. **Tell which names the owner chose.** A payee is `user`-named when it has a `payee.rename` or `payee.merge` audit
   row, or when its name is not what the old rules would have made from any of its rows. The second test catches
   renames through the transaction `payeeName` edit, which writes no audit row. It needs the old rules once, so the
   job carries a frozen copy of `cleanDescription` and `titleCase`, deleted in PR 4 (10). All
   other payees are `sync`-named.
3. **Re-file every transaction.** All aliases are rebuilt from the transactions:
   - A `user`-named payee keeps its name and its transactions. Each of its transactions writes its `m:` and `t:` keys
     as aliases pointing at it.
   - Every other transaction is filed again by sections 4–7, in date order, as if it had just arrived. Its payee may
     change: a payee that only the old cleanup joined splits into one per bank text. Its category, memo, owed mark
     and every other part stay; a transaction's money never changes.
   - When one key points at both a `user`-named payee and other rows, the `user`-named payee wins.
   - Old `d:` aliases are deleted. A `sync`-named payee left with no transactions is marked merged into the payee most
     of its rows went to, so links to it still resolve.
   - A posted row whose pending row was re-filed follows it, as now.
   - One audit row records the job (`payee.refile`, counts only). An Undo of a join made before the job is refused
     ("Can't undo now: this payee changed since."), since the aliases it would restore are gone.

What the owner sees afterwards: the Payees page lists the new names, and may have more payees than before where the
old cleanup had joined texts. Needs category suggestions follow the new payees.

## 9. The pending matcher without text

### 9.1 Where text matters today

| Case                                             | How often                                                               | Text used today                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Posted row with Plaid's `pending_transaction_id` | Most banks                                                              | None: the link decides                                                                                      |
| Posted row without the link (D-47)               | Bank of America almost always (1 of 177 posted rows had the link, D-47) | A gate (cleaned trigram likeness ≥ 0.4 unless amount and day agree), store numbers (D-50), 30% of the score |
| Manual pending row you entered                   | When you add one                                                        | 30% of the score (likeness of your typed name to the posted text)                                           |
| Orphan (a removed pending row, no link)          | Rare                                                                    | 30% of the score, only to break a tie                                                                       |
| Re-issued posted row                             | Rare                                                                    | None                                                                                                        |

So text matters most for Bank of America, which sends no link.

### 9.2 The new evidence: Plaid's own fields, compared for equality

Two rows are **the same merchant** when either holds:

- both have a `merchant_entity_id`, and they're equal; or
- both have a Plaid name (`merchant_name`, else `plaid_name`), and they're equal by `payeeNameKey` (case, outer
  spaces and apostrophes only).

They're **different merchants** when both have a `merchant_entity_id` and they differ. Otherwise the app doesn't
know, and says so: it never guesses from the text.

Plaid enriches pending rows as well as posted ones, so a Bank of America pending row and its posted row usually
carry the same merchant id or name.

### 9.3 The rules

**Posted row without the link (replaces the D-47 and D-50 row).** A bank pending row is a candidate when, as now,
it's in the same account with the same sign, the amount is within tolerance, and the dates fit (authorized on the
posted row's authorization day or the day before; else dated 0–14 days before). Then:

1. Different merchants: never a candidate.
2. Same merchant: a candidate.
3. Unknown merchant: a candidate only when the amount and the day agree exactly (today's exception, kept).
4. Otherwise not a candidate. The pending row stays until the bank removes it, as an unlike-named one does today,
   and the heal step tries again on later syncs.

Among candidates, today's pairing stays: best score first, each row once, asking (`ambiguous_match`) only when a
close alternative carries different edits; twins with nothing set pair without asking. The score's name part
becomes 1 for the same merchant and 0 otherwise (amount 50%, day 20%, name 30%, as now). Store numbers go: two
branches of one chain, both pending for the same amount, are twins; they pair without asking unless you've edited
one, and then you're asked.

**Manual pending row.** Eligibility doesn't change (it never used text). The name part of the score is 1 when your
typed name equals, by `payeeNameKey`, the posted row's payee name or Plaid name, else 0. Auto-match still needs a
unique best on both sides, else you're asked.

**Orphan.** Same score; a tie is still "ambiguous".

### 9.4 What changes for the owner

- Fewer wrong pairs: two different stores can't pair on a look-alike text, and a merchant-id mismatch is a hard no.
- Possibly more pending rows left beside their posted rows on Bank of America, when Plaid gives neither row a merchant
  id or name and the amount changed (a tip, a fuel hold). They clear when the bank removes the pending row, as
  today for unlike-named rows. Pairing them by hand is already an open item in `docs/build-plan.md`.
- More `ambiguous_match` questions only where two pending rows from the same merchant carry different edits.

### 9.5 Check it against real rows first

Before switching, PR 3 runs the new rules beside the old ones for one week on every sync, and records only counts
(pairs both made, pairs only the old rules made, only the new, conflicts) as a usage event with fixed ids. No names
or amounts leave the store. If "only the old rules" is more than a few a week, the owner decides whether to switch
(13). Then PR 4 deletes the old rules and the shadow run.

## 10. Plan

Four PRs, deployed in this order:

1. **Store Plaid's names** (3, migration): the columns, `NormalizedTxn`, the import, and part 1 of the job (8.1). No
   change on screen. The owner OKs the merge, since it adds a migration.
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

- Bank provider: `normalizePlaidTxn` takes `name` and the first merchant counterparty; payment-app counterparty.
- Domain: the name order; same, different and unknown merchant; the new candidate rules; twins from one chain;
  merchant-id mismatch refused even with exact amount and day; manual pending scored by name equality.
- Sync (`sync.test.ts`, `pending-match.test.ts`): Hulu with only a bank text and a Plaid name gets "Hulu"; a payee
  named from a pending row's bank text is renamed when its posted row brings `merchant_name`; a `user` name is never
  changed; two texts with one Plaid name and no merchant id stay two payees; a posted row keeps its pending row's
  payee; Venmo payments stay on one Venmo payee; the D-47 and D-50 cases rewritten with Plaid fields.
- The job: pages with and without `counterparties`; restart after a failed step; a `user`-named payee keeps its rows
  and name; a renamed-by-`payeeName` payee is seen as `user`-named; category, memo and owed marks unchanged on every
  moved row; old Undo refused; measured CPU.

## 11. Limits

- **CPU (10 ms).** Payee lookup is two map lookups per row; the matcher compares ids and names instead of building
  trigrams, which is cheaper. The job is chunked and measured. The shadow run doubles the matcher's work for one week;
  measure it.
- **Phone.** Nothing new synced (3). Moved transactions reach the phone through the normal sync of `txn_overlay`.
- **Plaid.** No new calls, links or products. The `counterparties` field is in the same response today.

## 12. Not in this change

- Payment apps per person (`docs/payees.md` section 10). `counterparty_type` and the person's name in
  `counterparties` are stored for it.
- Replacing the `CHECK`/`ACH` and payment-app word tests with Plaid's `check_number` and counterparty type.
- Splitting a payee that's already joined.
- Merchant logos and websites (`logo_url`, `website`).
- Plaid's `personal_finance_category` as a category suggestion.

## 13. The owner's answers (Nov 4, 2026)

1. **No cleanup** of bank text anywhere: payees and the pending matcher. The bank's text as sent is the last resort
   for a payee's name and key.
2. **Existing payees:** move every existing transaction to the new rules, at once, with no button or note (8).
3. **No joining by name.** "One payee per merchant name" felt like guessing; payees join only by Plaid's merchant id
   or by the owner renaming (4).
4. **Pending matcher (section 9): waiting for the owner's OK**, since it changes which rows pair.
