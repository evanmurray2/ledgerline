# D-91: An edit sent later carries the time the person made it (Nov 11, 2026)

**Follows from the design the owner accepted** (`docs/privacy.md` 5.3: "The time the person made the edit travels
with it", so that "an edit made on the last day of a month acts on that month"). This file records how today's
server does it, before the move to the device, and what it changes.

**Context.** The phone can make some edits offline and send them later, each with an id and the time it was made
(`x-edit-id`, `x-edit-at`). Until now the server used that time only to settle which of two edits of one
transaction field is newer (`editTime`, which this replaces). Everything else an edit wrote (a row's created and updated times, and any
"today" or "this month" the edit worked out) used the moment the edit **arrived**. The phone's copy runs the same
edit when the person makes it, so its rows had other times than the server's, and the twin check
(`apps/worker/test/twin.ts`) could not compare times.

**Decision.**

1. **An edit's rows carry the time the person made it** (`apps/worker/src/http/clock.ts`, `editNow`). A request
   with a valid `x-edit-id` and `x-edit-at` runs at that time. The phone's engine runs the edit at the same time,
   so both write the same rows, times included.
2. **Bounds, as before for field edits:** never later than the server's clock, and never more than 7 days back. An
   edit that waited longer counts as 7 days old.
3. **Only the routes that change the budget read it.** Sign-in, sessions, bank links, limits and the record of
   edit ids read the server's clock (`requestNow`), which a header can't move.
4. **A new row's id** takes its time part from the raw `x-edit-at` (`http/ids.ts`), not the bounded one, so the id
   is the same on both sides even when the bound moves the time.

**What changes for the person.** For the six kinds of edit the phone can make offline today, only recorded times
change: none of them reads "today" or "this month" to decide an amount (assign, set and move name their month, a
target names its month). When more edits can be made offline (`docs/build-plan.md`), an edit that does read them,
such as closing out an owed item "this month", will act on the month it was made in. The same-day order of rows
(newest first by time) now follows when edits were made, not when they arrived.

**Confirmed by the owner** (chat, Nov 11, 2026: "Yes") before more edits could be made offline: an edit made
offline acts on the month it was made in, not the month it arrives in.

**Consequences.** A phone that joined payees, synced, and then pressed Undo was refused, because the undo compares
times; it now works (twin test). After the move to the device the 7-day bound goes: the device's word is the
entry, and the server bounds only the entry's clear time (5.3, check 4).
