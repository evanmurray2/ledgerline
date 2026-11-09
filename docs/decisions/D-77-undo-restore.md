# D-77: A restore can be undone; it stays a runbook step (Nov 9, 2026)

**Decided by the owner** (chat, Nov 9, 2026): asked whether to put Rewind on Settings → Import and export, the owner
chose "Runbook only". Keeps `docs/multi-user.md` 8.8 ("Point-in-time restore is a runbook step, never an in-app
button"). Changes `docs/runbooks/restore.md` step 4, where the undo bookmark had to be saved by hand and no route took
it.

**Decision.**

1. **No button.** A point-in-time restore is still the console step in `docs/runbooks/restore.md`, with the budget's
   name typed and a passkey check in the last 15 minutes.
2. **The Directory keeps the undo.** After a restore, the store keeps the bookmark that undoes it in the Directory
   (`app_state`, key `restore:<budget>`), which the restore can't reach. `POST /api/settings/restore` with
   `{ undo: true, confirm }` uses it. The undo is a restore too, so it can be undone in turn.
   `GET /api/settings/restore/last` says when the last one ran.

**Money effect.** None: a restore puts back stored rows as they were.
