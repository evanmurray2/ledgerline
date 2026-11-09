# D-74: Pin categories to the top of Budget; no Low filter (Nov 9, 2026)

**Decided by the owner** (chat, Nov 9, 2026): "pin some categories to the top of the page … I don't think I'll need
the Low filter". Changes `docs/design.md` (Screens, Budget) and the Low filter added in Nov 2026
(`docs/build-history.md`).

**Decision.**

1. **Pin.** The pin button in a category sheet's header (beside the close button) pins the category or unpins it.
   Pinned categories show first, in a Pinned group (phone) or Pinned rows (desktop table), in the order they were
   pinned, and stay in their own group too, so group totals still add up. Archived or removed categories drop out.
2. **Saved with the budget.** The ids are one setting, `pinnedCategories` in the `setting` table, which already syncs
   to every device (`apps/worker/src/views/pinned.ts`). No migration. `POST /api/settings/categories/:id/pin` with
   `{ pinned }` pins or unpins one category, so a change sent late from an offline phone undoes nothing else; it is
   on the offline edit list. `BudgetView.pinned` lists the ids; the app drops archived or removed ones. The owner
   asked for the same pins on every device (chat, Nov 9), after a first version kept them per device.
3. **No Low filter.** Budget's filters are All and Needs attention. Low still shows as the status word on its row;
   Needs attention still leaves Low out. `?view=low` opens All.

**Money effect.** None: pins change only the order on screen.
