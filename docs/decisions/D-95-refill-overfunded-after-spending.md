# D-95: A Refill category that spent more than its target is Overfunded by all the money left (Nov 12, 2026)

**Asked by the owner** (chat, Nov 12, 2026): "if spending is greater than the target, then any extra money in the
category is overfunded." Adds to the Refill row of the funding statuses in `docs/design.md`; follows D-69, which did
the same for Set aside targets only.

**Context.** Rotating subscriptions refills to $25 every month. The owner assigned $49.97 and spent $33.98, which left
$15.99. A Refill target compared only what is available with the target, and $15.99 is below $25, so the row showed
Funded although the month's spending had already used the target up and extra money was still there.

**Decision.** When a Refill category's spending this month is above the target amount, it is overfunded by everything
still available (`overfundedBy` in `packages/domain/src/status.ts`). Otherwise the rule stays: overfunded by available
minus the target. The Move fix offers that amount. Set aside (D-69) and balance targets don't change.

**Money effect.** None. Statuses and the suggested Move amount change; no money is counted differently.
