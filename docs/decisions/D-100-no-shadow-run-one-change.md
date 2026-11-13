# D-100: No two-week shadow run; the rest of the design ships together, and the move follows at once (Nov 12, 2026)

**Decided by the owner** (chat, Nov 12, 2026): "I just learned tha there is supposed to be a shadow run done for
two weeks. I absolutely do not want to do that. I want to do the rest of the design in as few PRs as possible
(preferably one) and cutover immediately." and "the rest of every phase in the design. all in as few PRs as
possible. I want the design doc fully finished." Replaces the two-week condition of `docs/privacy.md` section 8
(order of work, item 5), phase 4 of its table, and the risk row "Money is counted differently after the move".

**Context.** The design made the device file bank updates beside the server for two weeks on the owner's budget,
compared exactly, before the budget moved to its sealed log. The owner does not want that wait.

**Decision.**

1. No shadow run stands between the code and the move. The device's filing is checked by its tests against the
   server's own steps (`apps/worker/test/file-run.test.ts`, `sealed-filing.test.ts`, `cutover.test.ts`) and by the
   browser test of the whole move (`e2e/tests/move.spec.ts`).
2. The rest of every phase is built in as few pull requests as possible.
3. The move is made as soon as that code is live and the owner is at the phone (a passkey prompt and the recovery
   key). The Worker's `CUTOVER` variable names the owner's budget from then on.
4. What stays: the freeze refuses to start while a bank update runs or a link has no stamp; the phone compares
   every table with the server before anything is sealed; the first snapshot is read back; the way back is open
   for 7 days and returns the budget as it was at the freeze.

**What it costs.** If the device files a bank update differently from how the server did, it shows on the owner's
real budget after the move, not in a comparison before it. The way back loses what was done since the move.
