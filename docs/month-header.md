# One month header on every tab

Status: built (Nov 3, 2026). Decision: D-58 (`docs/decisions/D-58-one-month-header.md`). The first draft went
through a design critique and an adversarial review against the code; what they changed is at the end.

## The problem

The month moved around depending on the tab:

| Tab      | Phone header before                                         | Desktop header before                  |
| -------- | ----------------------------------------------------------- | -------------------------------------- |
| Budget   | `‹ November 2026 ›` is the title, centered, 17 px           | `‹ November 2026 ›` on the left, 22 px |
| Activity | "Activity" title, Add pill on the right, no month           | same                                   |
| Accounts | "Accounts" title, Sync pill + gear, no month                | same, no gear                          |
| Reports  | "Reports" title, small `‹ Nov 2026 ›` at 15 px on the right | same                                   |

Each tab also kept its own month: going back to October on Budget and then opening Reports showed November. The
owner wants `‹ November 2026 ›` at the top of every page, in the same place.

## What the owner chose (Nov 3, 2026)

- The month bar on **Budget, Activity and Reports**, with one month shared between them.
- **Accounts has no month**: its balances are today's, so a month there would change one line and suggest the
  balances are that month's. Its name sits where the month is on the other tabs.
- Activity on this month shows only this month's posted rows (a few days early in a month is fine), and **every
  pending row, whatever its date**.
- Tabs go **Budget, Activity, Reports, Accounts**: the three month tabs together, then Accounts (with Settings
  behind its gear). The desktop sidebar follows: Budget, Activity, Reports, Accounts, Settings.

## The design

### The header of the four tabs (`components/MonthBar.tsx`)

**Phone, 56 px, three fixed columns: `44 px | middle | 44 px`, 8 px side padding.**

```
┌──────────────────────────────────────────┐
│ [ ]       ‹   November 2026   ›      [⋯] │  56 px
├──────────────────────────────────────────┤
│ (optional second row: search, chips)     │
```

- The middle is centered on the screen, not in the space left over: both side slots are always 44 px, so the
  month lands in the same place whatever buttons a tab has. A Playwright test checks the label's box is the same
  on Budget, Activity and Reports, and that Accounts' title is centered on the same line.
- The label is 17 px bold and fixed width (140 px, as wide as "September 2026"), so the chevrons don't move from
  month to month. Under 360 px wide it shortens to "Sep 2026" (92 px); its spoken name stays the full month.
- Each side slot holds at most one 44 px icon button with a 22 px icon:

| Tab      | Left       | Right                            | Second row                                |
| -------- | ---------- | -------------------------------- | ----------------------------------------- |
| Budget   | —          | ⋯ (Set targets, Edit categories) | All / Needs attention / Low chips         |
| Activity | —          | + Add transaction                | Search, filter chips                      |
| Reports  | —          | —                                | — (Spending / Trends / Net worth in body) |
| Accounts | ⚙ Settings | ↻ Sync (spins while syncing)     | —                                         |

Add and Sync are icon buttons on a phone (named "Add transaction" and "Sync"), not the labelled pills D-54
brought in: a pill doesn't fit beside a centered month on a 375 px phone. On a computer they stay pills.

**Desktop, 64 px (`DesktopHeader`):** the month on the left edge of the content column, where Budget's was
(22 px, 184 px fixed width); actions on the right as before. The sidebar shows the page, so there's no visible
title on the month tabs; Accounts shows "Accounts" in that spot.

**Names for VoiceOver:** each month tab has a visually hidden `<h1>` ("Activity"); the bar is a group named
"Month"; a polite live region reads the new month after a change.

### Back to this month

Off this month, "Back to November" shows under the label on a phone (in the bar's bottom gap, so the label
doesn't move) and beside the chevrons on a computer. The label is always a button (so focus stays on it): off this
month it goes back, on this month it's `aria-disabled`. On a computer `[` and `]` step and `t` goes back.

### One month for the app (`state/month.ts`)

- The month is in each month tab's URL, `?month=2026-10`. No `month` means this month, so the app moves on by
  itself when the month turns (when the session's `currentMonth` changes).
- The tab bar and sidebar links to the month tabs carry the month of the screen you're on. From a screen without
  one (Accounts, a register, Settings) they carry the last month a month screen showed. That's kept in memory
  only: starting the app opens this month.
- Ranges differ: Budget looks ahead (its `maxMonth`); Activity and Reports stop at this month. A later month
  there shows this month with › dimmed, and the app's month isn't changed, so Budget still shows December.
- A transaction sheet keeps the list's search (month, filter, search words): opening and closing one doesn't
  change the list under it (`TxnRow` links and `useClose` keep the search).

### Activity by month

- **Posted rows**: those Budget counts in that month: the row's own month override (Save for next month, the
  previous-month rule) or its date's month, and never before the budget's first month (`ROW_MONTH` in
  `routes/activity.ts`, the same rule as `linesForTxn`). History (dated before an account's budget start) isn't
  listed on any month (D-61); a search finds it. The date is the one the list shows (a card purchase's authorized date), as in Budget.
- **Pending and upcoming**: every one on this month, whatever its date; none on a past month. The Not posted yet
  chip shows only on this month, and Activity opens on it there when it has rows (D-97); `?filter=pending` on a past month shows everything.
- **To-dos** (Money to match, Transfers to sort out, Needs category, Check these) show whatever the month: they're
  waiting now, and the tab's count must match the screen.
- **Search** looks through every month ("Searching all months" above the results); the bar stays as it is.
- **One category** (Reports → a category, `?category=<id>`) also looks through every month: only rows in that
  category (split lines included), as a page of its own: the category's name, "All months", and Back to the report's month.
- **Show more** reads the next 50 posted rows (the list had no paging before; a busy month can hold more than 50).
- A past month with nothing posted says "No transactions in October."
- While another month loads, the last month's rows aren't kept on screen under the new month's name.
- Server: `GET /api/activity?month=YYYY-MM` (a malformed month is a 400; one before the budget is its first
  month). The query reads posted dates from the month before to POST*LAG after the month after (an override moves
  a row one month either way, and a row posts within POST_LAG of its date), through `bank_txn(budget_id, date)`;
  the budget's first month has no lower bound (rows pending at link count there). No widening when a month is set.
  The phone's engine runs the same route. \_Verify:* `apps/worker/test/activity-month.test.ts`.

### Screens without the bar

Screens opened from a tab keep `BackHeader`: a register, Owed to you, Targets, Categories, Rules, Settings.

### Usage ids

`month.prev`, `month.next`, `month.today` (the screen is recorded by `useScreen`); `activity.more`. The old
`budget.month.*` and `reports.month.*` ids are gone.

## What the reviews changed

- **Accounts**: dropped from the month (owner). This also removed the reviewers' Accounts problems: the change
  line counted calendar months over bank rows only, and a new query key would have broken Sync's wait.
- **Activity's month rule**: the draft said `monthOfDate`, which ignores month overrides and the first-month
  clamp, so October in Activity wouldn't have matched October in Budget. Now `ROW_MONTH`, as above.
- **Paging**: the app never read `nextCursor`; a month with over 50 rows would have been cut off without a word.
- **Speed**: a month bounded only from below would scan every later row. The query now has both bounds and skips
  the 45/180-day widening.
- **Sheets dropped the month**: opening a transaction on October showed November under it. Fixed.
- **Stale rows**: `placeholderData` kept one month's rows under another month's name. Fixed.
- **"Back to today"** moved the label and dropped focus: now "Back to November" in the bottom gap, label always a
  button.
- **Narrow phones**: "Sep 2026" under 360 px.
- **Search**: the bar no longer changes to "All months"; a line above the results says so instead.

Left as is: the to-dos show on every month; Accounts keeps "+$X in November" for this month.
