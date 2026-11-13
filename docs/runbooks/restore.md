# Recovery

There is no off-site backup (decisions.md D-29). Recovery uses Cloudflare's 30-day point-in-time recovery for each budget's Durable Object. Restoring is a runbook step, never a button in the app (`docs/multi-user.md` 8.8), so a stolen sign-in can't wipe a budget.

**A locked budget can't be restored by the server** (`docs/privacy.md` 5.8, phase 5; D-99). The server holds it sealed and can't read it, and rolling its store back would undo the log the devices hold. `POST /api/settings/restore` answers 409 for it, and so do the undo and loading a full backup (`BudgetStore.restoreTo`, `restoreUndo`, `restoreDump`). Its devices hold the budget; its full backup is made on a device (below), and nothing loads it back.

## Undo recent damage (last 30 days)

Each budget lives in its own Durable Object (`BudgetStore`). Restoring goes through the app, so every device's copy is downloaded again (D-45): the restore changes the budget's sync epoch first, and each device then shows "Your budget was restored, so it downloads again."

You need a computer: the steps use the browser's console, which an iPhone doesn't have.

1. On a computer, open https://ledgerline.ledger-line.workers.dev and sign in again with your passkey. The restore needs a passkey check in the last 15 minutes.
2. Open the browser's console on the Ledgerline tab (Chrome or Edge: Ctrl+Shift+J, or Cmd+Option+J on a Mac; Safari: turn on Settings → Advanced → Show features for web developers, then Cmd+Option+C).
3. Run this, with a time just before the damage (UTC, in the last 30 days) and your budget's name exactly as it shows in Settings:

```js
await fetch('/api/settings/restore', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-ledgerline': '1' },
  body: JSON.stringify({ before: '2026-11-03T15:00:00Z', confirm: 'Your budget name' }),
}).then((r) => r.json());
```

4. The answer is `{ ok: true, undo: "…" }`. You don't need to keep the bookmark: the Directory keeps the last one (D-77).

**To undo the last restore** (a restore by mistake, or by someone else), repeat steps 1 and 2, then run:

```js
await fetch('/api/settings/restore', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-ledgerline': '1' },
  body: JSON.stringify({ undo: true, confirm: 'Your budget name' }),
}).then((r) => r.json());
```

The budget goes back to how it was just before the last restore. The undo is a restore too, so running it again undoes the undo. To see when the last restore ran: `await fetch('/api/settings/restore/last').then((r) => r.json())` (`to` is null when it was an undo).

Everything after that time is replaced. Bank transactions after it come back on the next sync; your own edits after it are lost.

Answers that refuse: `confirm` (the name doesn't match), `invalid` (the time isn't in the last 30 days, or isn't an ISO time, or there's no restore to undo), and a passkey prompt when the last check is older than 15 minutes (sign in again, then repeat step 3).

## Your own copies

Settings → Backup and export has the full backup. Save it to Files or iCloud now and then: it is the only copy that survives losing the Cloudflare account or damage found after 30 days.

- **Full backup of a locked budget** (`.locked`, or `.sqlite` without a lock): made on the device from its copy, after a passkey prompt (D-99). By default it is sealed with your recovery key, which the screen asks you to type; only that key opens it (`openBackup` in `packages/seal`). The server never sees it and can't load it back. Without a lock, anyone with the file can read the whole budget.

- **Full backup** (`.ndjson`): every row of the budget, with a fingerprint of each table (`docs/multi-user.md` 8.7). The store can load one into an empty budget and prove nothing changed (`BudgetStore.restoreDump`, then `restoreVerify`; `apps/worker/test/backup.test.ts`), but **no route or tool reaches that, and none is planned**: a full backup takes data out, and nothing loads it back (`docs/privacy.md` 5.8, D-99). Keep the file as your own copy. Bank tokens in it stay encrypted with the Worker's `TOKEN_KEYS`, so it restores only where those keys are the same.
