# D-56: Pages arrive with a short slide (Nov 4, 2026)

Updates D-54. A page opened from another screen (Edit categories, Set targets, an account, Owed to you, Settings and
its pages) slides in a little from the right and fades in; when Back returns to a page, it comes from the left. A
tab's own screen, sheets and the desktop side panel don't move, and Settings sections on a computer switch in place.
Off with Reduce Motion. Plain CSS on the page's frame (`PageFrame`), so it works on every iOS version.

Budget's Edit categories and Set targets are header pills on a computer, like Sync and Add; on a phone they stay in
the ⋯ menu. Pills don't get chevrons: chevrons stay on rows that open a page.

Considered and dropped after an adversarial review (`docs/page-navigation.md`): chevrons on pills, and a full
slide with the browser's View Transitions (it would run on every navigation, misfire on tabs and sheets, and
crossfade everything on older iPhones). Nothing here changes how money is counted.
