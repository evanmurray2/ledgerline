# D-65: A posted row and the bank's pending row pair without text, only on exact evidence (Nov 5, 2026)

**Decided by the owner** (`docs/payee-names.md`, approved v7, answers 1 and 5 in its section 13). PR 4 of its
section 11 (9.3). Changes D-47 (1) and (2) and replaces D-50.

**Context.** Without Plaid's link (`pending_transaction_id`), D-47 paired a posted row with a bank pending row when
their cleaned bank texts looked alike (trigram similarity ≥ 0.4) or the amount and day agreed exactly, and D-50 kept
two branches of a chain apart by the store numbers in the text. One of the owner's banks (Bank A) almost never sends the link (5 of 181
posted rows in the owner's backup), and its pending text never equals its posted text (0 of 11 pairs), so the pairing
rested on a guess from text. The owner asked for no cleanup of bank text anywhere.

**Decision.**

1. **Candidates are as before** (D-47): same account and sign, amount within tolerance (exact for checks and ACH; card
   purchases within $5 or 25% either way), the pending row authorized on the posted row's authorization day or the day
   before (else dated 0–14 days before). A pair you answered No to (`not_same`) is never a candidate.
2. **A candidate pairs only on exact evidence:** the **same merchant** (the two rows share a merchant key: Plaid's
   merchant id, or a Plaid name, `merchant_name` or `name`, equal to a Plaid name by `payeeNameKey`), or the **same
   amount on the same day** (authorization day, else date). The bank's own text is never a key here. Different
   merchant ids don't block a pair (one payee can have two ids), so two branches with the exact amount on the same
   day pair; with a close amount they are asked about.
3. **Among candidates with exact evidence, D-47's pairing stays:** best score first (amount 50%, day 20%, same
   merchant 30%: 1 or 0), each row once; twins with nothing set pair without asking; a close alternative with
   different edits is asked about (`ambiguous_match`).
4. **The rest is asked:** a posted row left with candidates and none with exact evidence raises "Same purchase?"
   (`same_purchase`, D-64's card), with its candidates best first. A candidate pending row your entry covers is asked
   about as your entry (the covered row is hidden), and Yes pairs the posted row with the entry, claiming the covered
   row with it. Yes pairs as an automatic pair would; No goes into `not_same`. The heal step runs the same code, so it
   asks the same, and writes nothing when the question is already asked.
5. When step 2 left a posted row for you, step 3 pairs it with an entry only when every pending row it was asked about
   is one that entry covers; otherwise the entry joins the question.
6. **Orphan and re-issue matching** keep working without text: the orphan score's name part is the same merchant.
7. **Gone:** `cleanDescription`, trigrams, similarity and store numbers; the old cleaned-text payee aliases (`d:`) and
   their lookup. A one-time job (`drop_text_aliases`), queued with no migration only after the re-file job is done
   (its `payee.refile` audit row), deletes those alias rows, 100 per step.

**Money effect.** Which bank pending row a posted charge replaces when the bank sends no link: now only on exact
evidence or your Yes. A tipped charge whose pending row has another Plaid name now waits for your answer, and until
then both rows count, as when nothing paired before. Every posted charge still counts exactly once.

**Not the same on two bank rows** (built after this change). A posted row that took a bank pending row's key, by
step 2 or by your Yes (`txn_link` kind `pending_match`, not made by the provider), has Not the same on its sheet
(`POST /api/transactions/:key/not-same`, `routes/same-purchase.ts`). The pending row keeps the key and its overlay
(what you set on the pair is on it); the posted row gets its own key back (`ownKeyStmt`, as when the provider's link
wins) and is filed again as a new posted row (`sync/file-fresh.ts`, a payee and no category); the link is marked
undone and the pair goes into `not_same`, which step 2 and the heal step honor. A pending row still listed counts
again as pending; one the bank already removed stays gone, so only the posted row counts. Not restored: the won't
clear and the estimate `inherit()` cleared on the pending row, and what the posted row's own overlay filled in when
it paired. A pair made by the provider's link (`pending_transaction_id`) isn't offered and the route refuses it (409):
its link wins (D-47), and the next sync would pair them again.

**Not in this change.** A busy card can
raise more questions than D-47 did: each posted row whose candidates have no exact evidence is asked about once,
until it pairs or you answer. Bank A sends an authorization date on every row (181 of 181 posted rows in
the owner's Nov 4 backup), so its window is the same day or the day before, not 14 days.
