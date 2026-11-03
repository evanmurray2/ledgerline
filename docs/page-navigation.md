# Page navigation: pills that go somewhere, and pages that slide (design, Nov 4, 2026)

Status: **proposed**, pending the review below. Updates D-54 (pages and sheets) and D-55 (one look per meaning).
Nothing here changes how money is counted.

## Problem

Budget's Edit categories and Set targets are about to become header pills, like Sync and Add (D-55). Two things
then feel off, on the phone especially:

1. **The pill promises the wrong thing.** Elsewhere a pill opens a sheet (Add transaction) or acts in place
   (Sync). These two look the same but leave the screen for a page.
2. **A page just appears.** Opening a page swaps the screen in one frame, and Back swaps it back. Sheets slide up
   and fade the screen behind them (D-33), so they read as "on top of where I was". Pages have no motion at all, so
   moving forward and coming back look like the screen glitched rather than like going somewhere.

Making these two screens sheets was considered and rejected (D-54): Categories has drag to reorder, which fights a
sheet's swipe-down to close; each category already opens its own sheet, so sheets would stack; and the 400 px side
panel on a computer is cramped for both lists.

## Proposal

### 1. A pill that goes to a page ends with a chevron

- The rule rows already follow (D-55): a row that opens a page ends with an 18 px chevron; a row that opens a sheet
  doesn't. Pills follow the same rule: `HeaderAction` and `SoftLink` take the chevron when their `to` is a page.
- Budget on a computer: `✎ Edit categories ›` and `◎ Set targets ›`, beside the month, styled like Sync and Add.
- Budget on a phone: unchanged, both stay in the ⋯ menu (the month fills the header). Menu items that open a page
  get the chevron too, so the menu says the same thing.
- Other pills that go to a page get it as well (Bank connections' "Repair on Accounts"; any SoftLink whose target
  is a page). Pills that open a sheet or act (Add, Sync, Match, Review, Edit target) don't.

Implementation: decide by the destination, not by hand. A small `isPagePath(to)` (below) lets `HeaderAction`,
`SoftLink` and `OverflowMenu` add the chevron themselves, so a new pill can't get it wrong.

### 2. Pages slide; sheets keep their own motion; tabs don't move

Every navigation gets one of three motions, decided centrally from where it comes from and goes to:

| From → to | Motion |
| --- | --- |
| A tab or page → a page further in (Budget → Edit categories; Accounts → an account; Settings → Rules → a rule) | **Forward**: the new page slides in from the right over the old one, which shifts a little left and dims |
| Back to a page less deep (Back button, Back after saving) | **Back**: the reverse |
| Opening or closing a sheet (a child route drawn as a sheet) | **None** from this; the sheet keeps its slide-up |
| Switching tabs (tab bar, sidebar) | **None**: tabs are places side by side, not deeper |
| Anything else (sign-in, setup, a redirect, the first load) | **None** |

- **Depth** comes from the page path, ignoring sheet segments: a tab's own screen (`/budget`, `/activity`,
  `/accounts`, `/reports`) is 0; a page opened from a tab (`/categories`, `/targets`, `/owed`, `/accounts/$id`,
  `/settings`) is 1; a Settings page (`/settings/rules`) is 2; a rule (`/settings/rules/$id`) is 3. Sheet routes
  (`/budget/category/$id`, `/activity/txn/$key`, `/categories/$id`, `/targets/$id`, …) take their parent page's
  path, so opening one is "same page" → no slide. One table in `router.tsx` lists which child routes are sheets.
- **How:** the router already wraps navigations in the browser's View Transitions API
  (`document.startViewTransition`) when asked. `defaultViewTransition: { types }` with a function that returns
  `['forward']`, `['back']` or `false` from the from/to locations. CSS keyed on `:active-view-transition-type()`
  draws the slide. Only the screen's own area (`main`) gets a `view-transition-name`, so the tab bar, the sidebar,
  the status banner and the desktop side panel stay still.
- **Timing:** 280 ms on a phone with the same easing as sheets (`cubic-bezier(0.2, 0.8, 0.2, 1)`); on a computer
  a 180 ms 24 px shift and fade (a full-width slide across a wide window is a lot of motion).
- **Reduce Motion:** no slide; a 120 ms crossfade, or nothing.
- **Where it isn't supported** (older iPhones before iOS 18, older browsers): the page swaps as today. Nothing
  breaks.

### What doesn't change

Which screens are pages and which are sheets (D-54). Routes, URLs, Back targets, data loading. The phone's ⋯ menu.

## Decision to record

D-? updates D-54: "A control that goes to a page says so (a chevron), and going to a page moves (it slides in, and
Back slides it out); sheets slide up; tabs don't move."

## Verification plan

- Unit: the motion function (from, to) → forward/back/none for every row of the table above, including sheets,
  tabs and redirects.
- e2e (mock, phone and desktop): Edit categories and Set targets pills show a chevron; Add and Sync don't; a forward
  navigation and a Back each run one view transition with the right type (checked through
  `document.activeViewTransition` or a test hook); opening a sheet runs none; with `reducedMotion: 'reduce'` no
  slide.
- Screenshots of the Budget header on a computer and the ⋯ menu on a phone.
- On the owner's iPhone (Home Screen app): Budget → Edit categories → a category → Back → Back.

## Review

(Filled in by the adversarial review, before building.)
