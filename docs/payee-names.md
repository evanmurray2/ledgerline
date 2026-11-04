# Payee names from Plaid, not from the bank's raw text

Status: proposal, v2, Nov 4, 2026. Not built. Asked by the owner after a Hulu charge arrived as "Hlu Huluplus Hulu"
while the bank showed "Hulu". v2 has the owner's answers (section 12): no cleanup of bank text at all, the bank's
own text as the last resort, every existing payee moved to the new rules without a button, and one payee per
merchant name. This changes section 4 of `docs/payees.md` and the Payee normalization steps in `docs/design.md`.
Everything else in `docs/payees.md` (suggest, then OK; rename = merge; the Payees page) stays.

**Does this change how money is counted?** No. It changes which payee a transaction is filed under and what that
payee is called. No amount, date, category, transfer, pending match or Money rule (`docs/sync-spec.md`) changes.
The pending matcher keeps its own text comparison (2.1). It needs one budget migration, so the owner OKs the merge
of PR 1 (section 9).

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
5. Later rows with the same key get that payee, so the bad name repeats until the owner renames it.

## 2. The principle we drop, and the one that replaces it

**Dropped:** the app cleans up the bank's raw text and decides from it who the payee is and what it's called.

**New:** Plaid decides who the payee is and what it's called. The app does no cleanup of its own. When Plaid gives
no name, the payee is the bank's text exactly as the bank sent it. The only other change to a name is the owner
renaming a payee (which joins payees with the same name, `docs/payees.md` 5).

Why:

- Plaid already does merchant cleanup across millions of accounts, with a merchant id per brand. Our regex cleaner
  can't keep up (every processor prefix: `SQ *`, `TST*`, `HLU*`, `AMZN MKTP US*`, `DD *` …) and costs CPU.
- Its `name` is short and readable even when it has no merchant id ("Hulu", "Shell", "Uber").
- It's free: the same `/transactions/sync` response, on the Trial plan, with nothing new to call.

### 2.1 Where the raw text stays

These keep using `raw_name`, unchanged:

| Use                                       | Why it needs the raw text                                            | Where                                 |
| ----------------------------------------- | -------------------------------------------------------------------- | ------------------------------------- |
| Pending ↔ posted pairing                  | Name likeness and store numbers (`#1182`, D-47, D-50)                | `packages/domain/src/matcher.ts`      |
| Check and ACH detection                   | `CHK`, `CHECK`, `ACH` words                                          | `channel()` in `process.ts`           |
| Waiting to match for payment-app money in | `VENMO`, `ZELLE`, `CASH APP` words                                   | `P2P` in `process.ts`                 |
| The last-resort payee key and name        | When Plaid sends no merchant and no name (4, 5)                      | `process.ts` step 5                   |
| Shown to the owner                        | Rename sheet's Bank names, Payees search, transaction detail, export | `routes/settings/payees.ts`, `ops.ts` |

**The pending matcher keeps its text cleanup.** It compares a pending row's text with a posted row's text to decide
which pending row a posted charge replaces, and that is what makes each charge count once. Its cleanup (the
prefixes, dates and numbers it ignores) moves from `payee.ts` into `matcher.ts` as a private helper, unchanged, and
is never used for payees again. Changing it would change which rows pair, a Money-rules question this change
doesn't ask.

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

Sync tries these keys in order and takes the first that matches an alias:

1. `m:<merchant_entity_id>`, as now. Skipped for payment-app rows (7).
2. **New:** `n:<merchant name>`, where the name is `merchant_name`, else `counterparty_name`. Skipped for payment
   apps and for the stop list (7). This is what makes every Shell one payee (4.1).
3. **New:** `t:<bank text>`, the raw text exactly as sent. Replaces today's `d:` key made from the cleaned text.

When no key matches, sync makes the payee (5) and writes **one alias per key it had**, not only the first. So a Hulu
row with a merchant id, a merchant name and a bank text writes all three, and a later row that has only one of them
still finds Hulu.

Plaid's `name` alone (no `merchant_name`, no counterparty) is **not** a key. It's a good label but too loose a key:
Plaid uses names like "Payment", "Transfer" or "Deposit", and two different businesses can share one. It only names
the payee (5).

**What no cleanup means for keys:** when Plaid gives nothing, two texts that differ only in a store or reference
number (`SQ *BLUE BOTTLE 0123` and `SQ *BLUE BOTTLE 0456`) are two payees. Renaming one to the other's name joins
them, and both texts then point at the joined payee. This is the owner's choice: the app doesn't guess.

Comparing names for a key uses only what `samePayeeName` already ignores (case, outer spaces, curly and straight
apostrophes): `payeeNameKey`. `Shell` and `SHELL` are one key; `Shell` and `Shell Oil` are two.

### 4.1 One payee per merchant name, on the backend

The `payee_alias` table already maps a key to a payee: `pattern` holds a text key and `merchant_entity_id` the
Plaid id. `n:` and `t:` keys go in `pattern` with their prefix, so they never collide. No new table.

Two Shell stations, each with its own Plaid merchant id:

1. The first Shell row arrives: `m:ent_A`, `n:shell`, `t:SHELL OIL 57444 AUSTIN TX`. No alias matches, so sync makes
   the payee "Shell" and writes all three aliases.
2. The second station's row arrives: `m:ent_B`, `n:shell`, `t:SHELL SERVICE 1182`. `m:ent_B` matches nothing;
   `n:shell` matches the "Shell" payee. Sync files the row there and adds the aliases `m:ent_B` and
   `t:SHELL SERVICE 1182` for it.
3. Every later row from either station matches on `m:` first.

If the owner renames "Shell" to "Shell Gas", nothing moves: the aliases point at the payee's id, not its name. A
merchant whose Plaid name changes ("Shell" to "Shell Oil") still matches by its merchant id. To keep two stations
apart, the owner renames one: that payee then has a different name, but its aliases keep it separate (splitting a
payee that's already joined is not in this change, `docs/payees.md` 10).

## 5. What the payee is called (names)

For a new payee, the first of these that is present:

1. `merchant_name`
2. `counterparty_name`
3. `plaid_name`
4. `raw_name`, exactly as the bank sent it

No tidy step: the name is shown as Plaid or the bank wrote it ("HULU", "McDonald's", "SQ *BLUE BOTTLE 0123").

The payee gets `named_by = 'sync'` and `name_source` 1–4.

## 6. A better name arriving later

Pending rows and the first row from a new merchant often come with less data than later rows. Today the first name
sticks. Instead, when sync files a row under a payee with `named_by = 'sync'`:

- If the row has a name from a higher place in the list in 5 than the payee's `name_source`, sync renames the payee
  to it and lowers `name_source`. A payee named from the bank text (place 4) becomes "Hulu" (place 1, 2 or 3).
- It adds the row's other keys as aliases, unless another payee already owns them.
- A posted row still keeps its pending row's payee, as now, so nothing jumps between payees after the owner has
  seen it.

A payee with `named_by = 'user'` is never renamed by sync.

## 7. Payment apps and generic texts

These keep today's behaviour (one payee per app), and `docs/payees.md` section 10 still leaves per-person payees for
later:

- A row is a payment-app row when `counterparty_type = 'payment_app'`, or when Plaid sends no counterparty and the
  raw text matches `P2P`. It's found by its `m:` key, as now, so each app stays one payee. Its `n:` key is skipped,
  and sync never adds an `m:` alias from it to another payee, so the app's merchant id stays with the app's payee.
  Without a merchant id it falls through to its bank text key, as any other row.
- A **stop list** of merchant names that are never an `n:` key: Payment, Transfer, Deposit, Withdrawal, Interest,
  Fee, Check, Online Transfer, ACH, Debit, Credit (any case). Such a row falls through to its bank text key.

## 8. Existing payees and transactions

The owner chose (12): every existing transaction follows the new rules, at once, with no button or note. One
alarm job, run once after the migration, in three parts. Each part works in chunks under 10 ms of CPU and is
measured (`docs/measurements.md`); the job records its progress, so a failed step picks up where it stopped.

1. **Fill the new columns.** `raw_page` keeps every Plaid page as sent (append-only). The job reads each page, takes
   `name` and `counterparties` per transaction, and fills `plaid_name`, `counterparty_name` and `counterparty_type`.
   No new Plaid calls.
2. **Tell which names the owner chose.** A payee is `user`-named when it has a `payee.rename` or `payee.merge` audit
   row, or when its name is not what the old rules would have made from any of its rows (`merchant_name`, or
   `titleCase(cleanDescription(raw_name))`). The second test catches renames through the transaction `payeeName`
   edit, which writes no audit row. All other payees are `sync`-named.
3. **Re-file every transaction.** All aliases are rebuilt from the transactions:
   - A `user`-named payee keeps its name and its transactions. Each of its transactions writes its `m:`, `n:` and
     `t:` keys as aliases pointing at it.
   - Every other transaction is filed again by sections 4–7, in date order, as if it had just arrived. Its payee
     may change (two "Hulu" payees become one; a payee joined only by the old cleanup may split). Its category,
     memo, owed mark and every other part stay; a transaction's money never changes.
   - When one key points at both a `user`-named payee and new rows, the `user`-named payee wins.
   - Old `d:` aliases are deleted. A `sync`-named payee left with no transactions is marked merged into the payee
     most of its rows went to, so links to it still resolve.
   - A posted row whose pending row was re-filed follows it, as now.
   - One audit row records the job (`payee.refile`, counts only). An Undo of a join made before the job is refused
     ("Can't undo now: this payee changed since."), since the aliases it would restore are gone.

What the owner sees afterwards: the Payees page lists the new names; Needs category suggestions follow the new
payees (a split payee's suggestion comes from its own rows). Nothing else changes.

## 9. Plan

Three PRs, deployed in this order:

1. **Store Plaid's names** (3, migration): the columns, `NormalizedTxn`, the import, and part 1 of the job (8.1).
   No change on screen. The owner OKs the merge, since it adds a migration.
2. **Name and key payees from Plaid** (4–7): the new keys and name order, all aliases on create, the upgrade of
   sync-made names, payment apps and the stop list; `named_by` set by rename, join and the `payeeName` edit. The
   cleanup moves into `matcher.ts`; `cleanDescription`, `titleCase`, `payeeKey`'s `d:` key and `clusterPayees`
   leave `payee.ts`.
3. **Re-file existing payees** (8.2, 8.3), after PR 2 has run one sync in production.

Docs: a decision (`docs/decisions/D-?-payee-names-from-plaid.md`) and an entry in `docs/whats-true-now.md` for
`docs/design.md` (Payee normalization) and `docs/payees.md` (4). Delete the build-plan line.

Tests:

- Bank provider: `normalizePlaidTxn` takes `name` and the first merchant counterparty; payment-app counterparty.
- Domain: the name order, the stop list, `n:` keys alike only by `payeeNameKey`.
- Sync (`sync.test.ts`): Hulu with only a bank text and a Plaid name gets "Hulu"; a payee named from a pending row's
  bank text is renamed when its posted row brings `merchant_name`; a `user` name is never changed; a posted row keeps
  its pending row's payee; two Shell merchant ids join on `n:shell`; two Venmo payments to different people stay on
  one Venmo payee and add no alias; "Payment" never becomes a key; with no Plaid name, the payee is the bank text
  as sent.
- Pending pairing, transfers and Waiting to match: existing tests unchanged, since they still read `raw_name` and the
  matcher's cleanup is the same code.
- The job: pages with and without `counterparties`; restart after a failed step; a `user`-named payee keeps its rows
  and name; a renamed-by-`payeeName` payee is seen as `user`-named; two old payees for one merchant become one;
  category, memo and owed marks unchanged on every moved row; old Undo refused; measured CPU.

## 10. Limits

- **CPU (10 ms).** Sync does one more map lookup per row and at most one payee update. The regex cleaner no longer
  runs for payees. The job is chunked and measured.
- **Phone.** Nothing new synced (3). Moved transactions reach the phone through the normal sync of `txn_overlay`.
- **Plaid.** No new calls, links or products. The `counterparties` field is in the same response today.

## 11. Not in this change

- Payment apps per person (`docs/payees.md` section 10). This change makes it easier later: `counterparty_type` and
  the person's name in `counterparties` are stored.
- Splitting a payee that's already joined.
- Merchant logos and websites (`logo_url`, `website`): free in the same response, but they need storage on the
  phone and a design for rows.
- Plaid's `personal_finance_category` as a category suggestion: suggestions stay "what you used most"
  (`docs/payees.md` 2.1).

## 12. The owner's answers (Nov 4, 2026)

1. **No cleanup.** Remove the app's own cleanup of bank text for payees; the bank's text as sent is the last resort.
   The pending matcher keeps its cleanup (2.1), since changing it would change which rows pair.
2. **Existing payees:** move every existing transaction to the new rules, at once, with no button or note (8).
3. **One payee per merchant name:** yes, every "Shell" is one payee (4.1).
