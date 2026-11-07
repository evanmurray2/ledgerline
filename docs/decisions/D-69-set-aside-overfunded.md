# D-69: A Set aside category is Overfunded only by extra money still left (Nov 7, 2026)

**Asked by the owner** (chat, Nov 7, 2026): "a category should only be overfunded if it has leftover money but is over
its target." Changes the Set aside row of the funding statuses in `docs/design.md` and the Nov 3, 2026 wording fix.

**Context.** Health has a Set aside target. The owner assigned extra to pay a pending Wells Fargo Active Cash charge.
The charge counted, but Health still showed Overfunded, since a Set aside target compared only what was assigned this
month with the target.

**Decision.** A Set aside category is overfunded by min(assigned this month − target, available), and is Overfunded
only when that is above zero (`overfundedBy` in `packages/domain/src/status.ts`). The Move fix offers that amount, and
the Budget line reads "$X extra assigned is unspent · this month's $N". Refill and balance targets don't change: they
were already Overfunded only when available is above the target.

**Money effect.** None. Statuses and the suggested Move amount change; no money is counted differently.
