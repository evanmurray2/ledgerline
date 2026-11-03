# Page navigation: pills that go somewhere, and pages that slide (design, Nov 4, 2026)

Status: **built** (D-56), as the revised proposal below.
Transitions only as a later, guarded follow-up. Updates D-54 (pages and sheets) and D-55 (one look per meaning).
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

| From → to                                                                                                      | Motion                                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A tab or page → a page further in (Budget → Edit categories; Accounts → an account; Settings → Rules → a rule) | **Forward**: the new page slides in from the right over the old one, which shifts a little left and dims |
| Back to a page less deep (Back button, Back after saving)                                                      | **Back**: the reverse                                                                                    |
| Opening or closing a sheet (a child route drawn as a sheet)                                                    | **None** from this; the sheet keeps its slide-up                                                         |
| Switching tabs (tab bar, sidebar)                                                                              | **None**: tabs are places side by side, not deeper                                                       |
| Anything else (sign-in, setup, a redirect, the first load)                                                     | **None**                                                                                                 |

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

## Review (Nov 4, 2026)

An adversarial review (fresh reviewer, checked against the code) said **ship with changes**. Findings, checked:

1. **Blocker.** The router runs every navigation, including redirects, the first load, month changes and search
   keystrokes, through `document.startViewTransition` once `defaultViewTransition` is set
   (`router-core/dist/esm/load-client.js:933`, `router.js:494-506`). On a browser with view transitions but no
   transition types (Safari 18.0/18.1, not checked), it starts an untyped one: a crossfade on every navigation.
2. **Major.** Browser back/forward and redirects animate too; a Safari tab's own swipe-back would animate twice.
3. **Major: depth by path gives the wrong motion** in real flows:
   - tab switches from a page (`/accounts/$id` → Budget tab) slide back;
   - New category → its target goes through `/budget/category/$id/target?from=categories` (`Categories.tsx:315`),
     so it slides back, then forward on Done;
   - Repair from Bank connections lands on an Accounts sheet;
   - Owed's Back always goes to Budget (`Owed.tsx:56`);
   - Settings panes on a computer would slide the whole layout.
4. **Major.** Phone sheets are portalled to `body`, outside `main`, so they'd crossfade in the root snapshot while
   `main` slides. The desktop side panel opening or closing resizes `main` mid-slide.
5. **Major.** Pages read from the on-device engine asynchronously, with no route loaders, so a page slides in blank
   and its content pops in mid-slide.
6. **Minor.** Back is a new navigation, so a page slides back in scrolled to the top.
7. **Major (design).** A chevron on a pill has no established meaning. It reads as "next" or "more", and sits next to
   the month switcher's own chevron. `Banner` with `to` already shows a chevron for sheets, so the rule would be
   broken on day one. It patches D-54 rather than following it.
8. **Minor.** e2e runs Chromium, so it can't show Safari's behavior.

## Revised proposal (what gets built)

- **No chevrons on pills.** Chevrons stay on rows and menu items that open a page. `Banner` follows the row rule
  too (chevron only when it opens a page). The page's Back header is the signal that you've left the screen.
- **Pages animate on arrival**, with plain CSS, no view transitions:
  - `Page`, the Register, Owed and Set targets get an enter animation: a 24 px slide from the right and a fade,
    220 ms, the sheets' easing.
  - Coming back via Back plays it from the left (a module flag set by Back).
  - Off under Reduce Motion.
  - It works on every iOS version and can't affect sheets, tabs, the side panel or the first load: only a page
    mounting animates. A tab's own screen never animates.
- **View Transitions:** a possible follow-up only if this feels lacking. It would need the support guard,
  route-id classification, no slide for tabs, Settings panes, sheets or the side panel, root naming off, loaders,
  a swipe-back check and a test hook.
