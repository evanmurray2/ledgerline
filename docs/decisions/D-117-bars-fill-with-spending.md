# D-117: A category's bar fills as its money is spent (Nov 13, 2026)

**Asked by the owner** (chat, Nov 13, 2026): "fix everything in one PR", after a design critique of every screen.
Changes the Budget row of the screens table in `docs/design.md` ("bars mean only 'money left this month'") and the bar
part of D-39.

**Before.** A category's bar showed the money left: Rent with $0 of $1,000 spent was a full green bar, and Groceries,
Funded with $212.40 of $600.00 left, was a bar one third full that looked underfunded. Since the row's line was
changed to "$387.60 spent of $600.00", the line and the bar counted opposite ways. Reports' bars fill with spending,
so the same bar meant the opposite on another tab.

**Decision.** Every bar fills with what's spent of the month's money (spent + available): the Budget row, the
category sheet and the desktop table, as on Reports. An overspent category is a full red bar. Rows that had no bar
still have none. The view still sends `leftPercent`; the app draws `100 − leftPercent`, so the engine, its output and
the device check (D-116) are unchanged. The desktop table drops "57% used" under Spent: the bar says it.

**Money rules.** None changed. This is how a number is drawn, not how it is counted.

**Other fixes in the same PR** (no decision needed, listed here so they are found together): amounts on Budget's
Needs attention and Activity's Needs category rows keep the right edge, with the button on the line below; Fund all
is an outlined pill, so the Assign bar stays the one solid button; a short card that the Overspent fix covers too is
shown in a neutral color; Budget's sync strip has a chevron; Activity lists a check under Check these only, not again
under Pending (Pending's total is its own rows); the outer "Needs attention" heading is larger than the groups under
it; category tags on rows are plain text, not outlined; the bank's own text is fainter; "9:00 AM" no longer breaks
before AM; text wraps without a lone last word; "N more" under a banner reads "Show N more" with a chevron; the
Underfunded icon is a circle half lined in.
