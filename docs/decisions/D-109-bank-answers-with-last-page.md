# D-109: The bank's balances come in the step of a run's last page (Nov 13, 2026)

**Before.** `docs/privacy.md` 5.5 gave the sealed fetch "at the end of a run, one step each for Plaid's balances and
liabilities", after the last page of transactions. Each step is its own alarm, so the balances and card statements
were asked one and two steps after the transactions, though a device files them with the update's time
(D-86 A1). The build plan listed this as left open: the balances are not fetched with the update.

**Decision.** The step that fetches and seals a run's last page (Plaid says no more pages) also asks the bank's
balances and card statements and seals them into the same run, before the run is signed (`seal/fetch-job.ts`
`sealAnswers`). A run with no new page asks them in the step after Begin, as before. The `balances` and
`liabilities` steps stay for that case and for a job saved in them by an older release.

**What stays.** The sealed run is the same: its pages, then the balances (part kind 1), then the card statements
(kind 2), and a bank that can't say them leaves the run without them, as its manifest says. A device files it as
before; nothing about how money counts changes. A step tried again fetches no second page (the run has no more) and
seals no second balance (each kind is sealed once per run).

**Cost.** The last page's step makes two more bank calls and seals two small answers (under 1 ms each in Node,
`docs/measurements.md`, Nov 10), on top of the page (about 1.7 ms). It is not measured on Cloudflare yet.
