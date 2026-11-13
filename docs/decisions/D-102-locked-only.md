# D-102: Every budget is locked; the old server path goes (Nov 13, 2026)

**Decided by the owner** (chat, Nov 13, 2026): "There are no budgets that are not locked. I like option 1", where
option 1 was: remove the old server path, and every new budget starts locked. Extends `docs/privacy.md` section 8,
which kept the old code deployed for budgets not yet moved and for the 7-day way back (gone since the readable copy
was deleted on Nov 13, D-99).

**Context.** The owner's budget is the only one, and it has been locked since Nov 12, 2026, 22:24:55 UTC. Its
readable copy is being emptied (phase 6). The server still carries the code that read and changed budget tables,
synced them to phones, processed bank updates itself, moved a budget and offered a way back.

**Decision.**

1. **Every budget is locked.** A new budget (first-run setup, and sign-up if it is ever opened) is made on the device
   with its key, its recovery key and its first entry (`keys/budget.ts` `createBudget`), never as server tables.
2. **The old server path goes.** What only a budget that is not locked used is removed from the Worker, the app and
   the docs: the server's reads and edits of budget tables for a person's request, `GET /api/sync` and
   `/api/sync/rest`, the server's own bank processing jobs, the cutover and the way back, the shadow run, restore
   and its undo, the old link exchange, and recovery codes. Code that the device's engine runs (the routes it
   answers screens and edits with, the filing steps) stays: it is the same code, now run on the device.
3. **Tables only the old path used** are dropped by a forward-only store migration once phase 6 has emptied them,
   not before.

**What it costs.** A budget can no longer be served by the server at all: there is no fallback if the device code
breaks, other than a fix and a deploy. Inviting other people later means each of them starts locked, which needs
sign-up's robot check on its own address first (`docs/privacy.md` 5.6).
