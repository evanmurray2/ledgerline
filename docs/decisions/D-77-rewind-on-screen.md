# D-77: Rewind and undo on Settings → Import and export (Nov 9, 2026)

**Decided by the owner** (chat, Nov 9, 2026): "fix everything", after an architecture review that listed a real
restore path first. Changes `docs/multi-user.md` 8.8 ("Point-in-time restore is a runbook step, never an in-app button"), the Recovery
card on Settings → Import and export, whose note said rewinding was left off the screen "so a stolen sign-in can't wipe
your data", and `docs/runbooks/restore.md`, which needed a computer and the browser console. The full backup's restore
stays a runbook step (owner, Nov 9, in another session).

**Decision.**

1. **Rewind on screen.** Recovery → **Rewind** puts the budget back as it was at a minute in the last 30 days, with
   the existing `POST /api/settings/restore`. It needs the budget's name typed and a passkey check in the last 15
   minutes, as before. Every device downloads its copy again (the sync epoch changes first, D-45).
2. **Undo.** The store keeps the bookmark that undoes a rewind in the Directory (`app_state`, key
   `restore:<budget>`), which the rewind can't reach. **Undo last rewind** uses it (`{ undo: true, confirm }`); the
   undo is a rewind too and can be undone in turn. `GET /api/settings/restore/last` says when the last one ran.
3. **Why the old reason doesn't hold.** A rewind deletes nothing for good: point-in-time recovery covers every minute
   of the last 30 days, the minute before a rewind included, and the undo bookmark is kept. Anyone who could rewind
   from the screen could already do it from a browser console with the same passkey check. A phone has no console, so
   leaving it off the screen only stopped the owner.

**Money effect.** None: a rewind puts back stored rows as they were; nothing about how money is counted changes.
