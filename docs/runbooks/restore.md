# Recovery

There is no off-site backup (decisions.md D-29). Recovery uses what Cloudflare keeps for D1 on the free plan.

## Undo recent damage (last 30 days)

Each budget lives in its own Durable Object, with Cloudflare's 30-day point-in-time recovery. Restoring goes through the app, so every phone's copy is downloaded again (D-44): the restore changes the budget's sync epoch in the Directory first.

From a computer, signed in to Ledgerline in a browser (sign in again first: it needs a passkey check in the last 15 minutes), open the browser's console on the Ledgerline tab and run, with a time just before the damage and your budget's name:

```js
await fetch('/api/settings/restore', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-ledgerline': '1' },
  body: JSON.stringify({ before: '2026-11-03T15:00:00Z', confirm: 'Your budget name' }),
}).then((r) => r.json());
```

The answer has an `undo` bookmark; keep it. Everything after that time is replaced. Bank transactions after it come back on the next sync; your own edits after it are lost.

## Your own copy

Settings → Import and export → **JSON export** downloads your budget (categories, assignments, transactions, rules, payees). Save it to Files or iCloud now and then: it is the only copy that survives losing the Cloudflare account or damage noticed after 7 days. Ledgerline can't yet re-import a JSON export into a new database; the file keeps your data readable until it can.
