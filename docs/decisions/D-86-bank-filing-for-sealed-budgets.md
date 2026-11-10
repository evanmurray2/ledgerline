# D-86: How bank rows are filed once budgets are sealed (Nov 10, 2026)

**Decided by the owner** (chat, Nov 10, 2026): "Yes do A1, A3, A4, and option a for A2", in answer to the four
questions in `docs/privacy.md` 14.2. Nothing is built yet. Each item takes effect when its part of that design is
built, on the server first (its phase 3), so the effect can be seen on plain data before the work moves to the device.

**Context.** The privacy design moves bank matching from the server to the device. Three rounds of review showed that
today's filing can't be copied there as it is: several times are the clock of whichever server step ran, transfers
pair only inside one batch of 25 rows, and an edit can land in the middle of a run.

**Decision.**

1. **A1: one time per bank update.** Every time that comes from a bank update is the time the server finished
   fetching it: a row's arrival (`bank_txn.created_at`, which D-67 reads), its removal, when a pending row vanished,
   the bank balance time and the start of a bank difference (D-68's `drift_since`), the 44-day window the heal step
   looks back over, the month a "history changed" note names (in the budget's time zone, not a fixed one), and the
   day of a card's liability snapshot.
2. **A2, option (a): one update at a time, and transfers look back.** Bank updates are filed one at a time, in the
   order they arrived, for the whole budget. Transfer matching also looks at rows filed in the last days that have
   no partner yet, not only at the rows of the batch. **The exact rule (how many days, and which row wins when
   several could pair) is not decided here**: it is written and tested when this is built, and needs the owner's yes
   then.
3. **A3: no fetching for an account nobody has opened for 90 days.** It starts again when the person opens the app.
4. **A4: an edit never lands in the middle of a bank update.** The update is filed whole, then the edit.

**Money effect.**

- A1: normally none. The old and new times are seconds to minutes apart; hours apart only when the app was resting
  at a daily limit or a step was retried. Then a row near D-67's one-hour or 14-day line, or a bank difference near
  D-68's one-day line, could fall on the other side.
- A2: no amount in the bank's data changes. More transfers between two banks pair by themselves than today, when
  that depended on both sides being filed in the same batch; a card payment that pairs is in its payment category
  without being sorted by hand. When two banks' rows arrive together, which bank's text names a new payee first can
  differ.
- A3: rows that came during the pause are stamped at the return. No effect on a starting balance (D-67 settles in 14
  days). A bank difference that began during the pause shows a day after the return.
- A4: none on amounts. An entry added at the moment an update is being filed is matched by the next update.

Changes D-67 item 3 and D-68 item 2 (which time is read), and the matching mechanics in `docs/sync-spec.md`, when
built. `docs/whats-true-now.md` gets its lines then.
