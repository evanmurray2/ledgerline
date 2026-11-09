# D-82: A split whose lines no longer add up waits for you to fix it (Nov 9, 2026)

**Decided by the owner** (chat, Nov 9, 2026): "I pick B", from two choices for a split whose transaction amount
changes after it was split (an entry's amount edited, or a split bank pending row posting at another amount): A, the
line that "absorbs the remainder" takes the difference (`docs/design.md`); B, the app asks you to fix the split.

**Before.** Nothing applied the remainder: the lines stayed as they were, and the difference was in no category and
no other total either, so the identity (`docs/sync-spec.md` rule 10) was off by it and nothing said so.

**Decision.**

1. **The lines stay as you saved them.** Nothing moves money between categories by itself.
2. **The gap counts as uncategorized** (the amount less the lines' total) until you fix the split, like any
   uncategorized amount: no category and not Ready to Assign change, and rule 10 holds again
   (`packages/domain/src/budget/project.ts`; `money-rules.property.test.ts`).
3. **Activity lists it under Check these** with "Split $380.00 off" and Review, and its sheet says "The split adds up
   to $120.00, not $500.00. Edit the split to fix it." Nothing is stored for this: it is worked out from the split
   on each read, so it clears the moment the lines add up.
4. **Fixing it is two taps:** the split editor already works out the remainder line from the current amount, so
   opening the split and tapping Save split puts it right; any line can be changed first.

**Money effect.** Only for splits that no longer add up: their gap is now uncategorized instead of nowhere.
Categories and Ready to Assign don't change.
