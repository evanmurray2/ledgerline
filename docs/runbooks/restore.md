# Recovery

There is no off-site backup (decisions.md D-29). Recovery uses Cloudflare's 30-day point-in-time recovery for each budget's Durable Object. Rewinding is on Settings → Import and export since D-77; it was a runbook step before (`docs/multi-user.md` 8.8).

## Undo recent damage (last 30 days)

On your phone or a computer:

1. Open Settings → Import and export.
2. Under Recovery, tap **Rewind**.
3. Pick a time just before the damage. The time is in your device's time zone.
4. Type your budget's name, then tap **Rewind** and confirm. Face ID asks for your passkey if you haven't used it in the last 15 minutes.

Everything after that time is replaced. Bank transactions after it come back on the next sync; your own edits after it are lost. Every device downloads its copy again, because the rewind changes the budget's sync epoch in the Directory first (D-45).

**A rewind can be undone.** The Directory keeps the bookmark that puts the budget back as it was just before the last rewind, and Recovery shows **Undo last rewind**. The undo is a rewind too, so it can be undone in turn. Even without the bookmark, a rewind to the minute before a bad rewind works, for 30 days.

The route behind the screen is `POST /api/settings/restore` with `{ before, confirm }` or `{ undo: true, confirm }`; `GET /api/settings/restore/last` says when the last rewind ran.

## Your own copies

Settings → Import and export has two downloads. Save them to Files or iCloud now and then: they are the only copies that survive losing the Cloudflare account or damage found after 30 days.

- **Full backup** (`.ndjson`): every row of the budget, with a fingerprint of each table (`docs/multi-user.md` 8.7). The store can load one into an empty budget and prove nothing changed (`BudgetStore.restoreDump`, then `restoreVerify`; `apps/worker/test/backup.test.ts`), but **no route or tool reaches that yet** (`docs/build-plan.md`). Keep the file: it is the copy a future restore path will read. Bank tokens in it stay encrypted with the Worker's `TOKEN_KEYS`, so it restores only where those keys are the same.
- **JSON export**: a readable copy of categories, assignments, transactions and payees. It can't be loaded back.
