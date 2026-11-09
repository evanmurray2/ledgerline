# Recovery

There is no off-site backup (decisions.md D-29). Recovery uses Cloudflare's 30-day point-in-time recovery of each budget's Durable Object.

## Undo recent damage (last 30 days)

On your phone or a computer:

1. Open Settings → Import and export.
2. Under Recovery, tap **Rewind**.
3. Pick a time just before the damage. The time is in your device's time zone.
4. Type your budget's name, then tap **Rewind** and confirm. Face ID asks for your passkey if you haven't used it in the last 15 minutes.

Everything after that time is replaced. Bank transactions after it come back on the next sync; your own edits after it are lost. Every device downloads its copy again, because the rewind changes the budget's sync epoch in the Directory first (D-45).

**A rewind can be undone.** The Directory keeps the bookmark that puts the budget back as it was just before the last rewind, and Recovery shows **Undo last rewind**. The undo is a rewind too, so it can be undone in turn. Even without the bookmark, a rewind to the minute before a bad rewind works, for 30 days.

The route behind the screen is `POST /api/settings/restore` with `{ before, confirm }` or `{ undo: true, confirm }`; `GET /api/settings/restore/last` says when the last rewind ran.

## Your own copy

Settings → Import and export → **JSON export** downloads your budget (categories, assignments, transactions, rules, payees). Save it to Files or iCloud now and then: it is the only copy that survives losing the Cloudflare account or damage noticed after 7 days. Ledgerline can't yet re-import a JSON export into a new database; the file keeps your data readable until it can.
