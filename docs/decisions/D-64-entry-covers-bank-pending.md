# D-64: Your entry covers the bank's pending row; entries pair only on exact evidence (Nov 5, 2026)

**Decided by the owner** (`docs/payee-names.md`, approved v7, answers 5 and 8 in its section 13). PR 3 of its
section 11 (9.1, 9.2).

**Context.** An entry you add (Add pending, or an Upcoming row) paired only with a **posted** charge, on a unique best
score that a close amount alone could win. When the bank also sent a pending row, both counted until the charge
posted, and the bank's row kept counting after that until the bank removed it. A wrong pair could not be undone.

**Decision.**

1. **Batch order** (`apps/worker/src/sync/pending-match.ts`): (1) Plaid's link; (2) posted rows and bank pending rows
   (D-47, its rules unchanged until PR 4); (3) posted rows and entries; (4) new or unclaimed bank pending rows and
   entries. Each step skips rows an earlier step claimed in the batch, so a leftover entry never takes a charge whose
   pending row still counts.
2. **Entries pair only on exact evidence**: the name you typed equals one of the bank row's Plaid names
   (`payeeNameKey`), or the same amount on the same day. Candidates: same account and sign, amount within tolerance,
   the entry dated 0–14 days before, or 1 day after, the bank row. The pair must be each row's one candidate with
   evidence. The weighted score for entries is gone.
3. **Cover** (step 4): an unmatched entry covers a bank pending row (`manual_pending.covers_provider_txn_id`). The bank
   row is hidden and stops counting; the entry keeps counting with your amount, category, memo, splits and owed
   marks. Nothing moves: no key, no `inherit()`, no estimate or won't clear change. If the bank removes the covered row,
   nothing changes (it isn't flagged as vanished); a new pending row can be covered instead. The heal step checks
   covers for the pending rows it reads, so an entry added after the bank's row covers it on the next sync.
4. **When the charge posts**, the posted row takes the entry's key (`inherit()` from the entry, as step 3 does), whether
   it paired with the covered row (by link or D-47) or with the entry; the covered row takes the same key, so it's
   done, and what you set on it (category, memo, budget month) fills what the entry leaves empty.
5. **"Same purchase?"**: a bank row with candidates but no pair on evidence raises a `same_purchase` alert, shown as a
   card in Activity's Needs attention with Yes and No per candidate. The existing `ambiguous_match` moves from
   Accounts to the same card. Yes pairs as an automatic pair would; No goes into `not_same`, which no step ever pairs
   or asks about again. **Not the same** on a sheet undoes a cover or a posted row that took your entry's key (each
   row gets its own key back) and remembers No.
6. An entry deleted, or given an amount that no longer fits the covered row, ends its cover.

**How covered rows are hidden.** The views (migration 0004) hide only a pending row a posted row has claimed, and
changing them takes a migration. Instead every read that lists or counts transactions adds one condition
(`uncovered()` in `apps/worker/src/ledger/ledger.ts`): `RECENT_TX` (pending totals, Needs attention, Ready to Assign's
inputs), `loadTxns` (budget lines on the phone), registers, category sheets and the CSV export. A sheet opened by key
still shows the row. No migration.

**Money effect.** A charge you entered counts once at every step: the entry until it posts, then the posted row. A
close amount alone no longer pairs an entry with a posted row; until you answer "Same purchase?" both count, as when
nothing paired before.

**Not in this change.** "Same purchase?" for a posted row and a bank pending row without evidence, and dropping text
likeness (PR 4). Splits and owed marks on the covered bank row itself are not carried over (you set them on the entry).
Yes, No and Not the same need a connection (they move bank rows' keys), like matching money back.
