# D-54: Pages, sheets and header actions (Nov 3, 2026)

The owner found Edit categories (a page with Back) and Set targets (a sheet with ✕) inconsistent, and the same for
Activity's Add (filled pill, text) and Accounts' Refresh (soft pill on a computer, a bare icon on a phone). Two
rules now decide how such things look, on a phone and a computer alike:

- **A list you work through is a page; one thing you edit is a sheet.** Set targets is a page (`/targets`) like
  Categories (`/categories`): Back returns to the Budget, keeping its month, and each category's target opens as a
  sheet over the list (on a computer, in the side panel next to it, so the list stays in view). Saving comes back
  to the list. Old `/budget/targets` links redirect.
- **A screen's own header action is one style:** the soft blue pill with an icon and a word (`HeaderAction` in
  `components/ui.tsx`): Add on Activity, Refresh on Accounts, New rule on Rules. The label may be longer on a
  computer ("Add transaction"). Filled blue stays for the main button of a sheet or form (Save, Assign). Icons alone
  stay for navigation (the Settings gear, ⋯ menus, Back).

Replaces D-34's "Set targets list" being a sheet and D-35's "Set targets is on Budget only" placement (it still
opens only from Budget). Nothing here changes how money is counted. The rest of the review is in
`docs/design-review.md`.
