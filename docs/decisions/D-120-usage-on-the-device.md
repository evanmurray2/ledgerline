# D-120: Usage events stay in the device's browser storage (Nov 15, 2026)

**Asked by the owner** (chat, Nov 15, 2026): to see how the app is used, the owner chose "On-device usage log" — the
phone keeps tap and screen events, with no amounts, and Settings saves a file to share.

**What was true.** Since the lock (D-102) the app still sent its usage batches to `/api/usage`, and a locked budget's
server answered 204 and kept nothing (`seal/sealed-routes.ts`). `docs/privacy.md` 5.8 said usage would "stay on the
device, sealed with the budget" with an export; neither was built, but Settings said "usage export".

**Decision.** The tracker (`apps/web/src/usage/tracker.ts`) writes its events to the browser's `localStorage`
(`ledgerline.usage.v1`) every 30 s and when the page is hidden, and sends nothing. It keeps the last 90 days, at most
10,000 events (about 1 MB). Settings → Usage file, a screen of its own apart from the full backup, saves them as JSON, or deletes them. Each event
also names its page load (8 hex characters) and release, so a review can tell visits and versions apart.

**Why not sealed with the budget.** A table in the device's copy is a budget migration (the owner's yes, and every
phone runs it) and would put usage in the sealed log, which is for the budget. The events hold fixed ids and numbers
only (`cleanId`), the same kind of thing `localStorage` already holds for notices (`copy/notices.ts`).

**What it costs.** The events are readable by anyone who can read the browser's storage on that device. Each device
keeps its own, so a file covers one device. `/api/usage` stays on the server, unused by the app, until a change to the
server routes is allowed after the design freeze (D-117).
