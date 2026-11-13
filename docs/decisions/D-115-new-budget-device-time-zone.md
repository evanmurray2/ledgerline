# D-115: A new budget takes its first device's time zone (Nov 13, 2026)

**Before.** `docs/design.md` (Settings defaults) gave a budget US Pacific (America/Los_Angeles): the budget table's
default, which the server set when it made a budget's row. Since D-102 the first device makes that row
(`apps/worker/src/local/start-device.ts`), and it kept the same default. The build plan listed this as open: a
person anywhere else got Pacific month boundaries and "today".

**Decision.** The first device writes the budget's row with its own time zone, as the browser names it
(`Intl.DateTimeFormat().resolvedOptions().timeZone`). A zone the device's Intl doesn't know falls back to
America/Los_Angeles, as before.

**What stays.** Only a budget made from now on is touched: the owner's budget keeps its own zone, and no existing
row changes. The Money rules are the same; they already read the budget's own zone for its months and "today".
