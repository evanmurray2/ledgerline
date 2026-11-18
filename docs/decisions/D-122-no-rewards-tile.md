# D-122: Reports has no Rewards tile (Nov 18, 2026)

**Decided by the owner** (chat, Nov 18, 2026): "Can we just remove it? I don't like it."

**Before.** `docs/design.md` listed Spent, Invested, Income and Rewards on Reports. The Rewards tile added every
card inflow to Ready to Assign, not only money tagged "Rewards", so a card payment from an account that isn't linked
showed as rewards.

**Decision.** Reports shows Spent, Invested and Income only. The reports route still returns `tiles.rewards`
(nothing reads it); the Money rules for rewards (D-13: they go to Ready to Assign) are unchanged. UI only: no
migration, no change in how money is counted.
