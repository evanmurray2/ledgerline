# D-79: Refuse removing an overspent category, and entries before the budget start (Nov 9, 2026)

**Decided by the owner** (chat, Nov 9, 2026), answering two Money-rules questions from the edge-case sweep (#110):
"Refuse it for now" to both.

**Decision.**

1. **An overspent category can't be removed or archived.** Archived, its overspending dropped out of Budget's
   attention items and showed only in the Archived section, while it still counted. The category's sheet now says
   "To remove {name}, cover its {amount} overspending first." in place of Remove, and the server refuses Remove and
   Archive with `422 overspent` when the `available` the phone sends is below zero (it can't work balances out
   itself, D-45). A category with money left still sends it back to Ready to Assign, as before.
2. **Your own entries dated before the budget start are refused.** Bank rows there are read-only history that never
   counts (D-61, D-67); nothing covered entries you add. The Add sheet's date can't go before
   the first day of the budget start month, and says "Pick a date from {month} 1, {year} on"; the server refuses
   with `422 before_start`. Entries already stored are left as they are.

**For now.** Both are refusals until the owner picks a fuller answer (cover the overspending from Ready to Assign
first; keep an early entry as an uncleared check).

**Money effect.** None on what is already stored: both stop a change that would have hidden or added money.
