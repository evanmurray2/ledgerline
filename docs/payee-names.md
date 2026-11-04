# Payee names from Plaid, not from the bank's raw text

Status: proposal, v1, Nov 4, 2026. Not built. Asked by the owner after a Hulu charge arrived as "Hlu Huluplus Hulu"
while the bank showed "Hulu". This changes section 4.2 of `docs/payees.md` and the "Clean" and "Key" steps of
Payee normalization in `docs/design.md`. Everything else in `docs/payees.md` (suggest, then OK; rename = merge;
the Payees page) stays.

**Does this change how money is counted?** No. It changes which payee a transaction is filed under and what
that payee is called. No amount, date, category, transfer, pending match or Money rule (`docs/sync-spec.md`)
changes. It needs one budget migration, so the owner OKs the merge of PR 1 (section 9).

## 1. What happens today

Take a Hulu charge. Plaid sends three texts for it:

| Plaid field            | Example                         | What we do with it                          |
| ---------------------- | ------------------------------- | ------------------------------------------- |
| `original_description` | `HLU*HULUPLUS HULU.COM/BILL CA` | Stored as `bank_txn.raw_name`               |
| `name`                 | `Hulu`                          | Thrown away                                 |
| `merchant_name`        | often empty for this charge     | Stored as `bank_txn.merchant_name` when set |

1. The import asks for the raw text (`include_original_description: true`, `packages/bank-provider/src/plaid.ts`)
   and keeps it before Plaid's `name` (`rawName: t.original_description ?? t.name`). Only one of the two is
   stored, so Plaid's short name is lost.
2. Sync finds the payee by Plaid's `merchant_entity_id`, then by a key made from the cleaned raw text
   (`payeeKey`, `packages/domain/src/payee.ts`).
3. The first time neither key is known, sync makes a payee named `merchant_name`, or else
   `titleCase(cleanDescription(raw))` (`apps/worker/src/sync/process.ts`, step 5). `cleanDescription` doesn't know
   `HLU*` is a processor prefix, so the result is "Hlu Huluplus Hulu".
4. A posted row keeps the payee of the pending row it replaces. Pending rows often have less enrichment than
   posted ones, so a weak name made from the pending text sticks even when the posted row has a good merchant name.
5. Later rows with the same key get that payee, so the bad name repeats until the owner renames it.

The design behind this (`docs/design.md`, Payee normalization) treats the raw text as the main signal: clean it,
key on it, name from it. Plaid's enrichment is an extra key "when present". The regex cleaner has to know every
processor prefix (`SQ *`, `TST*`, `HLU*`, `AMZN MKTP US*`, `DD *`, `UBER *` …) to do as well as Plaid already does.

## 2. The principle we drop, and the one that replaces it

**Dropped:** the bank's raw text decides who the payee is and what it's called.

**New:** Plaid's enrichment decides who the payee is and what it's called. The raw text is evidence: it's kept
on every transaction exactly as the bank sent it, it's used where the full text matters (2.1), and it's the
last fallback for a payee when Plaid gives nothing better.

Why:

- Plaid already does merchant cleanup across millions of accounts, with a merchant id per brand. Our regex cleaner
  can't keep up with it and costs CPU.
- Its `name` is short and readable even when it has no merchant id ("Hulu", "Shell", "Uber").
- It's free: the same `/transactions/sync` response, on the Trial plan, with nothing new to call.

### 2.1 Where the raw text stays

These keep using `raw_name`, unchanged:

| Use                                       | Why it needs the raw text                                            | Where                                  |
| ----------------------------------------- | -------------------------------------------------------------------- | -------------------------------------- |
| Pending ↔ posted pairing                  | Store numbers (`#1182`) keep two branches apart (D-47, D-50)         | `process.ts` step 3, `packages/domain` |
| Check and ACH detection                   | `CHK`, `CHECK`, `ACH` words                                          | `channel()` in `process.ts`            |
| Waiting to match for payment-app money in | `VENMO`, `ZELLE`, `CASH APP` words                                   | `P2P` in `process.ts`                  |
| The last-resort payee key and name        | When Plaid sends no merchant and no usable name (3, 4)               | `payeeKey`, `cleanDescription`         |
| Shown to the owner                        | Rename sheet's Bank names, Payees search, transaction detail, export | `routes/settings/payees.ts`, `ops.ts`  |

## 3. What we store

One budget migration adds to `bank_txn`, filled from the same Plaid response:

| Column              | From Plaid                                             | Notes                                     |
| ------------------- | ------------------------------------------------------ | ----------------------------------------- |
| `plaid_name`        | `name`                                                 | Plaid's short name; may be absent         |
| `counterparty_name` | the first `counterparties[]` with `type = merchant`    | Often set when `merchant_name` isn't      |
| `counterparty_type` | that entry's `type`, or `payment_app` if one is listed | Lets sync spot payment apps without regex |

`raw_name`, `merchant_name` and `merchant_entity_id` stay as they are. `NormalizedTxn` gains the three fields;
`bank_event` payloads carry them like the others, so `steps.ts` writes them with `json_extract` as it does now.

And to `payee`:

| Column     | Values           | Notes                                                                                                |
| ---------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| `named_by` | `sync` or `user` | `sync` when sync made the name. Any rename, any join and the transaction `payeeName` edit set `user` |

`named_by` lets sync improve a name it made itself (5, 6) without ever touching a name the owner chose.

These columns stay on the server: payees are made only by sync processing, and the phone already gets payee
names. Nothing new is synced, and `engine.test.ts` doesn't change.

## 4. Who the payee is (identity)

Sync tries these keys in order and takes the first that matches an alias:

1. `m:<merchant_entity_id>`, as now. Skipped for payment apps (7).
2. **New:** `n:<name key>`, where the name is `merchant_name`, else `counterparty_name`. The key is the name
   lowercased with spaces, punctuation and a trailing `.com` removed (`Hulu` and `HULU.COM` → `hulu`). Skipped for
   payment apps and for the stop list (7).
3. `d:<cleaned raw text>`, as now.

When no key matches, sync makes the payee (5) and writes **one alias per key it had**, not only the first. So a
Hulu row with a name and a raw text writes both `n:hulu` and `d:HLUHULUPLUSHULU`, and a later row that has only one
of them still finds Hulu.

Plaid's `name` alone (no `merchant_name`, no counterparty) is **not** an identity key. It's a good label but too
loose a key: Plaid uses names like "Payment", "Transfer", "Deposit", "Interest", and two different businesses
can share one. It only names the payee (5).

The alias table needs no new column: `n:` keys go in `pattern` with the `n:` kept, so they can't collide with the
`d:` patterns, which are uppercase and have no prefix.

## 5. What the payee is called (names)

For a new payee, the first of these that is present:

1. `merchant_name`
2. `counterparty_name`
3. `plaid_name`
4. `titleCase(cleanDescription(raw_name))`, as now

Then one tidy step: a name in all capitals is title-cased ("SHELL OIL" → "Shell Oil"); a mixed-case name is kept
as Plaid wrote it ("McDonald's", "iCloud").

The payee gets `named_by = 'sync'`.

## 6. A better name arriving later

Pending rows and the first row from a new merchant often come with less enrichment than later rows. Today the first
name sticks. Instead, when sync files a row under a payee with `named_by = 'sync'`:

- If the row has a name from a higher place in the list in 5 than the payee's current name came from, sync
  renames the payee to it. "Hlu Huluplus Hulu" (place 4) becomes "Hulu" (place 1, 2 or 3).
- It also adds the row's other keys as aliases, unless another payee already owns them.
- If another payee already owns the row's `m:` or `n:` key, the row goes to that payee only when it isn't
  inheriting a payee from its pending row. A posted row still keeps its pending row's payee, as now, so
  nothing jumps between payees after the owner has seen it.

To know which place a name came from, the payee stores it: `payee.name_source` (1–4), set with `named_by`. A payee
with `named_by = 'user'` is never renamed by sync.

## 7. Payment apps and generic texts

These keep today's behaviour (one payee per app, the app's name), and `docs/payees.md` section 10 still leaves
per-person payees for later:

- A row is a payment-app row when `counterparty_type = 'payment_app'`, or when Plaid sends no counterparty and the
  raw text matches `P2P`. Its `m:` and `n:` keys are skipped so a new person's payment doesn't make a new alias on
  the app's merchant id, and the payee is found by its `d:` key as now.
- A **stop list** of names that are never an `n:` key or a name: Payment, Transfer, Deposit, Withdrawal,
  Interest, Fee, Check, Online Transfer, ACH, Debit, Credit (any case). Such a row falls through to the raw text.

## 8. Existing payees

The owner's budget already has payees named by the old rules. Two parts:

1. **Backfill the columns.** `raw_page` keeps every Plaid page as sent (append-only), so a one-time alarm job reads
   each page, takes `name` and `counterparties` per transaction, and fills the new `bank_txn` columns. It uses
   the apply step's chunking (25 transactions per step) to stay under 10 ms, and is measured
   (`docs/measurements.md`). No new Plaid calls.
2. **Mark and improve sync-made names.** The migration sets `named_by = 'user'` for every existing payee, so
   nothing changes without the owner. Then a payee is set back to `sync` when its name is exactly what the old
   rules made from one of its rows (its `merchant_name`, or `titleCase(cleanDescription(raw_name))`), and it has
   no `payee.rename` or `payee.merge` audit row. Those are names the owner never chose.
   - **Recommended:** rename those to the new rule's name once, in the same job. The Payees page shows one
     dismissable note, "12 payee names tidied · Undo", whose Undo puts back every old name from the job's
     audit row.
   - **Or:** leave them, and let them improve only as new rows arrive (6).

## 9. Plan

Three PRs:

1. **Store Plaid's names** (3, migration): the columns, `NormalizedTxn`, the import, and the backfill job (8.1).
   No change on screen. The owner OKs the merge, since it adds a migration.
2. **Name and key payees from Plaid** (4, 5, 6, 7): the new key and name order, all aliases on create, the
   upgrade of sync-made names, payment apps and the stop list. `named_by` set by rename, join and the
   `payeeName` edit.
3. **Tidy existing names** (8.2), if the owner picks it, with the note and Undo.

Docs: a decision (`docs/decisions/D-?-payee-names-from-plaid.md`) and an entry in `docs/whats-true-now.md` for
`docs/design.md` (Payee normalization: Clean and Key) and `docs/payees.md` (4.2). Delete the build-plan line.

Tests:

- Bank provider: `normalizePlaidTxn` takes `name` and the first merchant counterparty; payment-app counterparty.
- Domain: the name key (`Hulu`, `HULU.COM`, `Hulu.com` agree), the stop list, name order and the tidy step.
- Sync (`sync.test.ts`): Hulu with only a raw text and a name gets "Hulu"; a pending row named from raw text is
  renamed when its posted row brings `merchant_name`; a `user` name is never changed; a posted row keeps its
  pending row's payee; two Venmo payments to different people stay on one Venmo payee and add no alias to its
  merchant id; "Payment" never becomes a key.
- Backfill: a page with and without `counterparties`; restart after a failed step; measured CPU.
- Pending pairing, transfers and Waiting to match: existing tests unchanged, since they still read `raw_name`.

## 10. Limits

- **CPU (10 ms).** Sync does one more map lookup per row and at most one payee update. `clusterPayees` and the
  regex cleaner run less often, since most rows match on `m:` or `n:` first. The backfill is chunked and measured.
- **Phone.** Nothing new synced (3).
- **Plaid.** No new calls, links or products. The `counterparties` field is in the same response today.

## 11. Not in this change

- Payment apps per person (`docs/payees.md` section 10). This change makes it easier later: `counterparty_type`
  and the person's name in `counterparties` are stored.
- Merchant logos and websites (`logo_url`, `website`): free in the same response, but they need storage on the
  phone and a design for rows.
- Plaid's `personal_finance_category` as a category suggestion: suggestions stay "what you used most"
  (`docs/payees.md` 2.1).

## 12. Questions for the owner

1. Existing payees: tidy the names the app made, once, with Undo (recommended), or leave them (8.2)?
2. Joining by Plaid's merchant name: every "Shell" or "Starbucks" location becomes one payee, even when Plaid gives
   them different merchant ids. Recommended yes; the owner can split by renaming.
