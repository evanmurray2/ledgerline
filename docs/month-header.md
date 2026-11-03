# One month header on every tab

Status: draft for review (Nov 3, 2026). Nothing built yet. Decision: D-? (number given just before merging).

## The problem

The month moves around depending on the tab:

| Tab      | Phone header today                                   | Desktop header today             |
| -------- | ---------------------------------------------------- | -------------------------------- |
| Budget   | `‹ November 2026 ›` is the title, centered, 17 px    | `‹ November 2026 ›` on the left, 22 px |
| Activity | "Activity" title, Add pill on the right, no month    | same                             |
| Accounts | "Accounts" title, Sync pill + gear, no month          | same, no gear                    |
| Reports  | "Reports" title, small `‹ Nov 2026 ›` at 15 px on the right | same                      |

Each tab has its own month: going back to October on Budget and then opening Reports shows November. The owner
wants `‹ November 2026 ›` at the top of every page, in the same place.

## Goals

1. The month switcher is in exactly the same place, at the same size, on Budget, Activity, Accounts and Reports.
   Switching tabs never moves it, and changing months never moves the chevrons.
2. One month for the whole app: the month chosen on any tab is the month on every tab.
3. Every tab shows something for that month. A control that does nothing on a screen is worse than no control.
4. Getting back to this month is one tap.
5. No change to how money is counted (`packages/domain` and the Money rules are untouched; this is display only).

Not goals: a month picker grid, swipe left and right between months, or month headers on pushed screens
(register, Settings pages, Targets, Categories).

## The design

### 1. The month bar (`MonthBar`, replaces the headers of the four tabs)

**Phone, 56 px, three fixed columns: `44 px | switcher | 44 px`, with 8 px side padding.**

```
┌──────────────────────────────────────────┐
│ [⚙]      ‹   November 2026   ›      [⋯]  │  56 px
├──────────────────────────────────────────┤
│ (optional second row: chips, search)     │
```

- The switcher is centered on the screen, not in the space that is left over. Both side slots are always
  44 px wide, so it lands in the same place whether a tab has zero, one or two actions.
- Each side slot holds at most one 44 px icon button, with a 22 px icon (the header button size we already use).
  A tab with nothing there leaves the slot empty.
- The label is 17 px bold and **fixed width**: as wide as "September 2026", the widest month, so the chevrons
  don't move from month to month. Chevron buttons are 44 × 44 with a 22 px chevron, as in `MonthSwitcher` now.
- At the first or last month a tab allows, that chevron is dimmed (as now).

What goes in the slots:

| Tab      | Left       | Right      | Second row                         |
| -------- | ---------- | ---------- | ---------------------------------- |
| Budget   | —          | ⋯ (Set targets, Edit categories) | All / Needs attention / Low chips (as now) |
| Activity | —          | + (Add)    | Search, filter chips (as now)      |
| Accounts | ⚙ Settings | ↻ Sync (spins while syncing) | —                          |
| Reports  | —          | —          | — (the Spending / Trends / Net worth switch stays in the body) |

This means Add and Sync become icon buttons on the phone, instead of the labelled pills D-55 brought in
(`HeaderAction`). A pill doesn't fit: Accounts would need about 140 px on the right, and a matching 140 px on the
left to keep the month centered, which leaves too little for the switcher on a 375 px phone. Their names stay
in `aria-label`. The record for this: a new decision, D-?, which replaces this part of D-55.

**Desktop, 64 px (`DesktopHeader`):** the switcher sits on the left edge of the content column, where Budget's
is now (22 px label, the same fixed width). Actions stay on the right as labelled pills: there's plenty of room.
The sidebar already shows which page you're on, so there's no page title, as on Budget today. On a computer
"the same place" means the same place on every page: left on a computer, centered on a phone.

**Page names for VoiceOver.** Without a visible title, each tab gets a visually hidden `<h1>` ("Activity"),
and the switcher is a `group` labelled "Month". `document.title` stays as it is.

### 2. Back to this month

When the month on screen isn't this month, a small caption under the label says **"Back to today"** in the accent
color. The whole label, caption included, is one button that goes to this month. That fits in the 56 px row as two
lines (17 px + 12 px), so nothing else moves. On this month there's no caption and the label isn't a button.

On a computer: `[` and `]` (as now) on all four tabs, plus `t` for this month.

### 3. One month for the app

- The month is part of each tab's URL, `?month=2026-10`, as on Budget and Reports now. With no `month`, a tab
  shows this month. The URL stays the source of truth, so Back, reloads and links work as they do now.
- The tab bar and the sidebar carry the month: their links to the four tabs include the `?month=` of the screen
  you're on. Opening Reports from Budget's October keeps October.
- From a screen without a month (a register, Settings, Targets): tapping a tab uses the last month you chose. That
  month is held in memory only (`state/month.ts`), so starting the app again always opens on this month.
- "This month" is stored as *no month*, never as `2026-11`, so the app moves to December by itself at midnight
  on Nov 30 when you were on this month.
- **Ranges differ per tab:** Budget can look ahead (its `maxMonth`); Reports, Activity and Accounts stop at this
  month. If the chosen month is ahead of what a tab allows, that tab shows its last month with › dimmed, and the
  chosen month doesn't change, so going back to Budget shows December again. The bar always shows the month the
  screen is showing; it never claims December over November's numbers.
- Each tab's first month is the budget's first month (`minMonth`).

### 4. What each tab shows for the month

**Budget and Reports:** unchanged.

**Activity**
- Posted rows: only those whose budget month (the same `monthOfDate` that puts a row in Budget's Spent) is the
  chosen month. Paging (`cursor`) stays inside that month.
- To-dos stay whatever the month (Needs category, Money to match, Transfers to sort, Check these): they're jobs
  waiting now, and hiding one would leave the Activity tab's count disagreeing with the screen.
- Not posted yet: **this month always shows every pending row, whatever its date** (owner, Nov 3, 2026). A charge
  from Oct 30 that's still pending on Nov 3 is pending now, so it shows on November, not October. Upcoming rows
  show on this month too. A past month never shows pending or upcoming rows. Once a row posts, it moves to the
  month its date puts it in, like every posted row (which can be the month before).
- **Search looks through every month.** While a search is typed, the bar's label shows "All months" and its
  chevrons are hidden, and a line above the results says "Searching all months". Clearing the search brings the
  month back.
- On a past month with no posted rows: "No transactions in October."
- Server and phone: `GET /api/activity?month=2026-10` narrows `postedQuery` to that month's dates. The phone's
  engine answers the same route, so `engine.test.ts` gets a case for it. A month's query reads fewer rows than the
  45-day window does now, so it fits the 10 ms CPU limit; measure it anyway (`docs/measurements.md`).

**Accounts**
- Balances stay as of today. The card says "Net worth today", and the change line becomes
  "+$1,240 in October" for the chosen month.
- `GET /api/accounts?month=2026-10` gives `netWorthChange` for that month (the `monthPosted` sum in
  `routes/accounts.ts` takes the month instead of this one).
- Repairs, failures and alerts don't depend on the month.

### 5. Screens without the bar

Screens you open from a tab keep `BackHeader`, so you can tell you've gone one level deeper: a register,
Owed to you, Targets, Categories, Rules and the Settings pages. Settings on a computer is a sidebar page with no
month; that one page is the exception to "every page".

### 6. Usage ids

`month.prev`, `month.next` and `month.today`, with the screen already recorded (`useScreen`). The old
`budget.month.*` and `reports.month.*` ids go away.

## How it's built

1. `components/MonthBar.tsx`: the phone and desktop bar, built on `MonthSwitcher` (fixed-width label, the
   "Back to today" caption, `t`).
2. `state/month.ts`: the last month chosen, in memory; `useAppMonth(tab)` reads `?month=`, clamps it to the tab's
   range and returns `{ month, shown, go }`.
3. `TabBar` and `DNav` links carry `?month=`.
4. Routes `/activity` and `/accounts` accept `month`; Worker routes and the engine take it.
5. Swap the four tabs' headers to `MonthBar`.
6. Tests: unit tests for clamping and "this month" as no month; Playwright: the month stays put across the four
   tabs on a phone (bounding box of the label is the same), October carries from Budget to Reports and Activity,
   Back to today, search shows All months; Worker tests and `engine.test.ts` for the `month` parameter.

## Open questions

- Should Activity on a past month also show that month's to-dos only? (Proposed: no, to-dos are always shown.)
- Accounts balances at the end of a past month were left out on purpose (the owner chose this, Nov 3, 2026).
