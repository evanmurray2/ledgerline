# D-74: Pin categories to the top of Budget; no Low filter (Nov 9, 2026)

**Decided by the owner** (chat, Nov 9, 2026): "pin some categories to the top of the page … I don't think I'll need
the Low filter". Changes `docs/design.md` (Screens, Budget) and the Low filter added in Nov 2026
(`docs/build-history.md`).

**Decision.**

1. **Pin.** The pin button in a category sheet's header (beside the close button) pins the category or unpins it.
   Pinned categories show first, in a Pinned group (phone) or Pinned rows (desktop table), in the order they were
   pinned, and stay in their own group too, so group totals still add up. Archived or removed categories drop out.
2. **Per device.** Pins are kept in the browser (`ledgerline-pinned` in localStorage, `apps/web/src/state/pinned.ts`),
   like folded groups: no migration, no sync, works offline. A phone and a computer each keep their own pins.
3. **No Low filter.** Budget's filters are All and Needs attention. Low still shows as the status word on its row;
   Needs attention still leaves Low out. `?view=low` opens All.

**Money effect.** None: pins change only the order on screen.
