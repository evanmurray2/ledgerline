# D-72: An entry dated up to 7 days after the bank row is a candidate; the heal step meets older posted rows (Nov 7, 2026)

**Decided by the owner** (chat, Nov 7, 2026). Changes D-64 (2) and `docs/payee-names.md` 9 (candidates).

**Context.** The owner added a water bill (Calwater, $44.99, dated Nov 6) after the bank's ACH row (Calwater Service,
$44.99, Nov 4) had already posted. Neither paired nor was asked about, so the charge counted twice. Two gaps:

1. An entry was a candidate only when dated 0–14 days before, or 1 day after, the bank row. Nov 6 is 2 days after.
2. Step 3 (posted rows and entries) runs only on posted rows in the batch that brings them, and the heal step only
   re-reads pending rows. An entry added after its posted row arrived was never compared with it.

**Decision.**

1. An entry is a candidate when dated 0–14 days before, or up to 7 days after, the bank row (`ENTRY_DAYS_BEFORE`,
   `ENTRY_DAYS_AFTER` in `packages/domain/src/same-purchase.ts`). Tolerance and exact evidence are unchanged: a
   different day with a different name still asks "Same purchase?" rather than pairing.
2. The heal step (`healPending`) also reads the connection's posted rows from the last 44 days that took no key yet,
   when an open entry on the same account is dated in that window. They go through the same steps a new batch does,
   so they pair on exact evidence or are asked about once (asking again writes nothing).

**Money effect.** An entry you add for a charge that already posted is now asked about (or paired on exact evidence)
on the next sync, instead of both counting until you delete one. Every pair still needs exact evidence or your Yes.

**Cost.** One more query per heal (posted rows joined to open entries on the account), capped at `CHUNK.process` rows.
