# D-58: One month header on the tabs (Nov 3, 2026)

The owner wants `‹ November 2026 ›` at the top of every page in the same place. Before, Budget showed the month as
its title, Reports as a small switcher on the right, and Activity and Accounts not at all, and each tab kept its own
month. Design and review: `docs/month-header.md`.

**Decision**

- Budget, Activity and Reports share one header (`MonthBar`): on a phone the month is centered between two fixed
  44 px slots; on a computer it sits at the left of the content column. One month for the three, carried in
  `?month=` and by the tab links.
- Accounts has no month (its balances are today's); its name sits in the month's place.
- Activity shows the chosen month's posted rows by the month Budget counts them in, every pending and upcoming
  row on this month (none on a past month), the to-dos on every month, and searches every month.
- Tabs go Budget, Activity, Reports, Accounts (sidebar: then Settings).

**Replaces**

- D-54's labelled header actions on a phone's tabs: Add (Activity) and Sync (Accounts) are 44 px icon buttons
  there, since a pill doesn't fit beside a centered month. Pills stay on a computer and on pages (New rule).
- D-55's 22 px phone tab titles (`PhoneHeader` on Activity, Accounts and Reports): the month (17 px) is the title
  on the month tabs, and Accounts' 17 px title sits in the same place.
- The tab order Budget, Activity, Accounts, Reports.

Money rules: unchanged. Activity's month uses Budget's existing rule (`linesForTxn`); nothing is counted
differently.
