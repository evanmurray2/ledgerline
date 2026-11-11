# D-92: A posted row that took a bank pending row's key still meets your entries (Nov 11, 2026)

**Asked of the owner** (chat, Nov 11, 2026); merged only on the owner's yes. Changes D-64 (the batch order) and D-72 (2), and `docs/payee-names.md`
9.2.

**Context.** The owner had three entries on one card (Add pending). For each, the bank sent a pending row and a
posted row. The posted row paired with the bank's pending row; the entry stayed, with no "Same purchase?" card, so
each charge counted twice. Two ways in, both reproduced in `apps/worker/test/entry-covers.test.ts`:

1. One bank update brings the pending row and the posted row together (this bank lists a pending row for days after
   it posts). The posted row claims the pending row in step 2, so step 3 (posted rows and entries) and step 4 (new
   pending rows and entries) both skip the pair.
2. The bank's pending row is here, then the entry is added, then the posted row arrives and claims the pending row
   before the heal step has compared the pending row with the entry.

After that nothing looked again: step 3 and the heal step (D-72) read only posted rows that still have their own
key. An entry added after such a pair was never compared either. A card left from an earlier question about the
pending row did show, but Yes was refused ("changed").

**Decision.**

1. A posted row that holds a bank row's key, not an entry's, is compared with your open entries by the rule of step
   3: a pair only on exact evidence (your typed name equals one of the posted row's Plaid names, or the same amount
   on the same day), each the other's one such candidate; otherwise "Same purchase?" asks. This runs in the batch
   that makes the claim (after step 3) and in the heal step, which now also reads such posted rows from the last 44
   days when an open entry on the account is dated so it could pair.
2. On a pair (or Yes), the entry takes the whole pair (`matchEntryOverStmts` in `sync/pairing.ts`): the posted row
   and the pending row move to the entry's key; what was set on the held key fills what the entry leaves empty; the
   entry is matched. The posted amount wins, and a different amount is flagged as for any match.
3. The question is about the key the posted row holds (the row the screens show). No is remembered. Not the same on
   the entry gives each bank row its own key back; the posted row then claims the pending row again, and the entry
   stays apart and is not asked about again.
4. An entry that covers another bank pending row is left out.

The order still holds: a posted row tries bank pending rows before entries, so an entry never takes a charge whose
pending row keeps counting. Here the pending row is already claimed, so nothing counts twice.

**Money effect.** An entry and the posted charge it stands for count once where they counted twice. Every pair still
needs exact evidence or your Yes. Entries left over from before pair, or are asked about, on the next sync of their
bank (44-day window). A split or owed mark set on the bank's pending row itself is not carried to the entry (as for
a covered row, D-64).

**Cost.** The heal step's posted query reads more rows while an entry is open (the same cap, `CHUNK.process`).
`measure/entry-covers.measure.ts`: processing 10.1 and 7.1 ms, heal median 3.6 ms, inside the ranges in
`docs/measurements.md`; it now ends with 15 matched and 25 asked (was 12 and 24).
