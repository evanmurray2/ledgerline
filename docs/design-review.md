# Design consistency review (Nov 3, 2026)

A review of `apps/web/src` for the same kind of thing looking or behaving differently across screens, on a phone
(390 px) and a computer (1280 px), checked in the mock app (`VITE_MOCK=1`). Line numbers refer to commit `790df7f`
(`git show 790df7f:<path>`); they will drift as the fixes land. `docs/build-plan.md` section 19 tracks what's done.

Already fixed with this review (D-54): Set targets is a page like Categories, and a screen's header action (Add,
Refresh, New rule) is one `HeaderAction` style on both screen sizes.

Money rules: nothing below changes how money is counted. All of it is markup, copy or color. Two items (11b
and 13a) touch how an amount or a "late" state is shown, but not how it is computed.

Findings are ranked by how visible they are to a phone user.

---

## 1. Phone screen headers: four hand-rolled versions, three title sizes, two heights (high)

Measured on the phone:

| Screen | Markup | Height | Title |
|---|---|---|---|
| Budget | `Budget.tsx:1266` + MonthNav `:691` (`px-2 py-1.5`) | 56 px row (109 px with chips) | month, 17 px, centered |
| Activity | `Activity.tsx:368` (`px-4 pt-3 pb-2.5`, no min-h) | 161 px with search and chips | 22 px |
| Accounts | `Accounts.tsx:205` (`min-h-14 pl-4 pr-1`) | 56 px | 22 px |
| Reports | `Reports.tsx:278` (a copy of Accounts' markup) | 56 px | 22 px |
| Sub-pages (Owed, Register, Settings, all Settings pages, Categories) | `BackHeader`, `ui.tsx:675` (`py-2 pl-1 pr-4` + 44 px button) | 61 px (65 px with a subtitle) | 19 px |
| Setup steps | `Setup.tsx:28`: back link, no border or background, `aria-label="Back"` | | none |

- Going from a tab screen to its sub-page, the header grows by 5 px and the title shrinks from 22 px to 19 px.
- Budget is the only tab screen without a 22 px screen title.
- **Standard:** add a shared `PhoneHeader({title, right, below})` to `ui.tsx`: `min-h-14`, `pl-4 pr-1`, 22 px
  title, and a right slot of 44 px icon buttons. Use it in Activity, Accounts and Reports. Make `BackHeader` on
  the phone `min-h-14` (drop `py-2` and center the content) so every header row is 56 px. Pick one title size
  for sub-pages: 19 px is fine, but write it down in the `BackHeader` doc comment.

## 2. Two different "⋯" menus (high, visible on Budget and every account)

- `OverflowMenu` (`ui.tsx:93-151`): 22 px icon, 36 px trigger, items `h-10` at 14 px semibold,
  `min-w-[180px]`, shadow `0_8px_24px`, closes on outside pointerdown and on Escape (focus goes back to the
  trigger). Used by Budget on phone and desktop.
- `AccountMenu` (`Accounts.tsx:672-717`): 24 px icon, 44 px trigger, items `h-12` at 15 px, `w-52`, shadow
  `0_4px_12px`, closes through a full-screen invisible button, no Escape handling, `role="menu"` and
  `menuitem`. Used in the Register header.
- The screenshots `phone-budget-menu.png` and `phone-register-menu.png` show the difference.
- **Standard:** `OverflowMenu`. Let its items take `onClick` as well as `to`, give it `role="menu"` and
  `menuitem` (from AccountMenu), and replace `AccountMenu` with it.

## 3. Other header actions that should follow the header-action convention (medium)

- Rules list: "+ New rule" is a text link at 15 px (`Rules.tsx:44`, passed to `Page right`). Budget's desktop
  header links are 13 px (`Budget.tsx:1222,1229`). On the phone this is the only text-link action in a
  `BackHeader`.
- Register: the ⋯ menu in the header (`Accounts.tsx:418`). Covered by section 2.
- Settings on phone: the gear is an icon button in the Accounts header (`Accounts.tsx:218-225`, 22 px). It
  should be part of the same icon-button slot as Refresh/Sync (21 px icon, `Accounts.tsx:216`), and both icons
  should be the same size.
- Reports: the month switcher in the header's right slot is fine as a control, but see section 9.
- **Standard:** whatever the other session settles on for the primary action. "New rule" should then become
  the same kind of control as Activity's "Add transaction" (a primary "add" on a list screen).

## 4. Filter chips: in the header on two screens, in the scrolling body on a third (medium)

- Budget chips sit in the header (`Budget.tsx:1268-1272` on phone, `DesktopHeader below` at `:1243` on
  desktop). Activity's do too (`Activity.tsx:374`, `:366`).
- Register chips are in the scrolling body (`Accounts.tsx:501-516`). They scroll away on the phone and are
  not in the header on desktop.
- The labels differ as well. Budget and Activity use `CountBadge`: "Needs attention [6]". The Register puts the
  count inside the text: "Pending 3", "Needs category 2" (`Accounts.tsx:405-407`).
- **Standard:** chips go in the header with `CountBadge`. Move the Register chips into the header area (under
  the `BackHeader` on phone, in `below` on desktop) and render the counts with `CountBadge`.

## 5. Buttons: one set of shared components, many hand-rolled copies (high)

Shared (`ui.tsx`): `PrimaryButton` (h-12, rounded-xl, 16 px, disabled `bg-disabled-bg text-muted`),
`SecondaryButton` (same size, border), `SoftButton` (h-9 pill, 13 px, accent-soft, disabled
`bg-sunken text-disabled`), `Chip`.

### 5a. Soft accent pill (the most common small action), hand-rolled 12 times
These copy SoftButton's classes, usually because the action is a `<Link>`:

| File:line | Label | Differs from SoftButton |
|---|---|---|
| `Activity.tsx:407, 428, 544` | Match, Pick, Review | (Link) |
| `BudgetSheets.tsx:271` @790df7f | Edit (target) | `px-3.5` |
| `Connections.tsx:158` | Finish setup | `self-start` (Button) |
| `Connections.tsx:222` | Repair on Accounts | (Link) |
| `Categories.tsx:150` | Restore | (a Button that could simply be SoftButton) |
| `Payees.tsx:117` | Rename | (Link) |
| `Data.tsx:210, 268` | Download | `disabled:opacity-60` |
| `Accounts.tsx:197` | Refresh (desktop) | `disabled:opacity-50`, icon |
| `Owed.tsx:164` | Match money back | `px-4` on desktop, `flex-1` on phone |
| `Activity.tsx:509` | Choose / category name | `disabled:opacity-50`; sunken when chosen |
| `Data.tsx:85-89` | Choose file | **h-11**, `px-4`, **14 px** |

**Fix:** export `softButtonClass` from `ui.tsx` (or give `SoftButton` an `asChild`/`to` prop) and use it for
the Links. Give every small pill one disabled treatment (SoftButton's).

### 5b. Small filled accent pill: no component, four sizes
- `Budget.tsx:337`: Fund all, h-9, 13 px, `px-3`
- `Activity.tsx:315`: Add, h-9, **14 px**, `px-3.5`
- `Budget.tsx:533`: Set targets (first budget), **h-10**, 14 px, `px-4`
- `TxnSheets.tsx:645`: Match to something else, h-9, 13 px
- `Payees.tsx:87`: Merge, h-9, 13 px, `flex-1`

**Fix:** add `SoftButton tone="filled"` (h-9, 13 px, `bg-accent text-on-accent`, disabled like PrimaryButton).
Fold the Activity Add button into whatever the header work decides.

### 5c. Small outline pill (secondary small action), five variants
- `Budget.tsx:422`: Undo, `bg-surface`
- `TxnSheets.tsx:307, 608, 717`: Not this purchase, Unlink, Unpair. No `bg-surface`.
- `Owed.tsx:185`: Close out. No `bg-surface`.
- `Payees.tsx:74`: Keep separate. `bg-surface`.
- `TxnSheets.tsx:636`: Undo with `border-success-border text-funded-fg`.
- `Accounts.tsx:122`: Try now. `bg-surface`, **no border**, `text-ink`.

**Fix:** add `SoftButton tone="outline"` (`border border-line-strong bg-surface text-ink-2`).

### 5d. Large buttons rebuilt by hand
- Inline delete confirmations use `h-11 rounded-[10px] text-[14px]` for both "Keep it" and the red button
  (`Categories.tsx:491/499`, `Rules.tsx:474/482`, `BudgetSheets.tsx:617/625` @790df7f). The other inline
  confirmation, "Use 1 of your N links?" (`Connections.tsx:89-101`), uses `SecondaryButton` and
  `PrimaryButton` (h-12, rounded-xl, 16 px). **Fix:** use `SecondaryButton` and `PrimaryButton danger` in all
  four.
- Activity selection bar, "Choose category" (`Activity.tsx:585`): h-11, 15 px, disabled
  `bg-disabled text-on-accent`. PrimaryButton's disabled look is different. **Fix:** `PrimaryButton` with
  `className="w-auto h-11"`, or let it keep its 48 px height.
- `Data.tsx:120,124` shrink Secondary and Primary to `h-10`. This is the only place they are resized. **Fix:**
  drop the override.
- `Auth.tsx:401`, "Sign out of this device": a hand-built SecondaryButton with `text-over-fg`. **Fix:** add a
  `danger` prop to SecondaryButton for red text.
- `ActivitySheets.tsx:144` and `Setup.tsx:79`: Links styled as PrimaryButton. Acceptable, but share a
  `primaryButtonClass`.

### 5e. Text-link buttons: 13, 14 and 15 px, five heights
- 13 px: `Budget.tsx:1222/1229` (h-9), `BudgetSheets.tsx:284` "See all" (min-h-9), `TxnSheets.tsx:318`
  (h-9), `TxnSheets.tsx:355` "Split into categories" (**h-6**).
- 14 px: `Activity.tsx:457` Select (h-9), `Activity.tsx:658/666` Split it… / It's a transfer… (h-10),
  `Categories.tsx:131` Show archived (min-h-9), `Rules.tsx:357` + Add condition (h-9), `TxnSheets.tsx:907`
  + Add a line (h-11), `BudgetSheets.tsx:750` @790df7f Select all (h-9).
- 15 px: `Rules.tsx:44` + New rule.
- `TxnSheets.tsx:104,113`: "Rename payee" and "See rule …" are bold but **muted** (they inherit
  `text-muted`). They are the only text links that aren't accent-colored.
- **Fix:** add a `TextButton` / `textLinkClass` to `ui.tsx`: 14 px bold accent, `min-h-9` (h-11 when it's the
  only target on its line). Use it in all of the above.

## 6. Destructive actions: three different flows (high for safety, medium visibility)

1. Inline `role="alertdialog"` with "Keep it" and a red button: remove a category (`Categories.tsx:473-503`),
   delete a rule (`Rules.tsx:459-486`), remove a target (`BudgetSheets.tsx` @790df7f ~603-630).
2. **No confirmation at all:**
   - Delete a transaction (`TxnSheets.tsx:539-549`): deletes at once. The toast "X deleted" has **no Undo**.
   - Remove a group (`Categories.tsx:437-456`).
   - Remove a passkey (`Auth.tsx:324-329`; the reauth prompt is the only thing in the way).
   - Sign out another device (`Auth.tsx:456-468`), and "Sign out of this device" (`Auth.tsx:390-404`), which
     also deletes the budget saved on the phone.
3. Pick the outcome, then confirm with a red PrimaryButton (Check: "Delete it", `ActivitySheets.tsx:449-531`).

The links that start these flows differ too: `mt-3 min-h-10 14px text-over-fg` (Categories `:453`, `:510`),
`mt-4` (Rules `:492`), `min-h-9` with no margin (TxnSheets `:547`), and an h-9 rounded pill at 13 px (Auth
`:326`).

The labels mix "Delete this rule…", "Remove {name}…", "Remove group {name}" (no ellipsis even though nothing
asks first), and "Delete".

**Standard:** flow 1. Extract a `ConfirmInline({text, confirmLabel, onConfirm})` built from
SecondaryButton + `PrimaryButton danger` (see 5d), and use it for transaction delete, group remove, passkey
remove and "sign out of this device". Alternatively, give transaction delete an Undo toast like category
archive (`Categories.tsx:337-344`) and categorize. Make the trigger one `DangerLink` (14 px bold `text-over-fg`,
`min-h-10`), with "…" only when a confirmation follows.

## 7. Sheet titles: SheetTitle is used in only 5 of about 20 sheets (medium)

- `SheetTitle` (`Sheet.tsx:233-251`, 20 px, `leading-tight`) is used by Note, Owed close-out, Target, Assign
  and the Targets list.
- Hand-rolled 20 px `h1` without `leading-tight`: Repair (`Accounts.tsx:595`), Rename account (`:745`), Rename
  payee (`TxnSheets.tsx:964`, `Payees.tsx:173`), Edit/New category (`Categories.tsx:363`), Add a transaction
  (`ActivitySheets.tsx:585`), Category sheet (`BudgetSheets.tsx:151` @790df7f).
- Split: **19 px** (`TxnSheets.tsx:823`).
- Category picker: an `h2` at **17 px** (`CategoryPicker.tsx:110`).
- Amount-led headers (28 px amount) are built 6 times, and the order and weight of the text around the amount
  change from sheet to sheet:
  - `TxnSheets.tsx:83` (Header): tag at 13 px **bold**, amount, then "payee · account · date" at 14 px muted.
  - `TxnSheets.tsx:573` (PaidBack): same order.
  - `TxnSheets.tsx:680` (PairedTransfer): tag "Transfer · date" bold, amount, no line under it.
  - `ActivitySheets.tsx:104-107` (Match): "payee · account · date" at 13 px **regular** above the amount, a
    question under it.
  - `ActivitySheets.tsx:312-315` (Transfer pick): "account · date · raw" above, a question under it.
  - `ActivitySheets.tsx:476` (Check).
- **Fix:** use `SheetTitle` everywhere (Split and the picker included). Add an `amount` variant (tag line 13 px
  bold, amount 28 px, sub line 14 px muted, in that order) for the six transaction sheets.

## 8. Where a sheet's main button sits: sticky footer vs. end of the body (medium on phone)

- Footer (stays visible above the keyboard): Edit transaction, Paid back, Split, Repair, Rename account,
  Category, Assign, Target, Add transaction, and the Rule edit Page.
- At the end of the scrolling body: Note (`Note.tsx:70`), Rename payee in both versions (`TxnSheets.tsx:984`,
  `Payees.tsx:216`), Edit/New category (`Categories.tsx:429`), Owed close-out (`Owed.tsx:362`), Paired
  transfer "Done" (`TxnSheets.tsx:727`), and the Match, Transfer and Check result buttons
  (`ActivitySheets.tsx:243, 342, 489, 525`).
- On a phone with the keyboard up (Rename payee, New category, Note), the Save button can sit below the fold.
- **Fix:** put the sheet's main Save or confirm action in `footer`. Done/Undo pairs after a result can stay
  in the body.

## 9. Two month switchers (medium)

- Budget `MonthNav` (`Budget.tsx:691-723`): 22 px chevrons, `rounded-lg`. The month is an `h1` (17 px on
  phone, 22 px on desktop). Previous is disabled at `minMonth`. `[` and `]` shortcuts.
- Reports (`Reports.tsx:245-271`): 20 px chevrons, no radius. The month is a 15 px `span` with
  `min-w-[84px]`. Previous is **never disabled**.
- **Fix:** add a shared `MonthSwitcher({month, canPrev, canNext, onGo, size})`. Keep Reports' month as
  secondary text, but use the same chevrons, the same disabled logic and the same shortcut wiring.

## 10. Section labels: SectionTitle is used by one screen and copied by seven (medium)

- `SectionTitle` (`ui.tsx:498`, 13 px, uppercase, 0.5 tracking, `min-h-9`, note at 12 px muted) is used only
  by Activity.
- Identical hand-rolled `h2`s: `Settings.tsx:272/277/292`, `Budget.tsx:481`, `Owed.tsx:114/198`,
  `Data.tsx:200/204`, `Auth.tsx:301`, `Accounts.tsx:319`. Accounts' total is 13 px semibold `text-ink-2`, not
  SectionTitle's 12 px muted note. `Activity.tsx:439-448` (Needs category) is also hand-rolled.
- Other label styles:
  - `Label` (`ui.tsx:516`): 12 px, 0.4 tracking. Used in sheets. Copied by hand as an `h2` in
    `ActivitySheets.tsx:157` and as a CategoryPicker label class.
  - Register day headers: 12 px, `min-h-8` (`Accounts.tsx:522`).
  - In-card group headers: 12 px, 0.6 tracking (`Budget.tsx:259, 325, 394`).
  - Desktop table group rows: 12 px, 0.5 tracking (`Budget.tsx:993`).
  - Payees suggestion: 12 px, 0.4 tracking, in accent (`Payees.tsx:56`).
- **The same section looks different on phone and desktop.** "Preferences" is an uppercase label on the
  phone's Settings home (`Settings.tsx:292`) and a 15 px sentence-case `h2` in the desktop Appearance pane
  (`Settings.tsx:363`).
- Other sentence-case 15 px headings sit next to uppercase labels: Activity "Needs attention"
  (`Activity.tsx:388`) and Reports "Spending by category" (`Reports.tsx:300`).
- **Fix:** use `SectionTitle` for every label above a card (with the `note` prop for totals). Use `Label` in
  sheets. Add one `GroupHeader` for in-card group bars. Pick one style for the Settings "Preferences" heading.

## 11. "Needs attention" and lists: the same idea built two ways (medium)

- a. Budget's attention view puts the section title **inside** the card, as a toned bar with an icon
  (`Budget.tsx:322-341`). Activity's attention groups put an uppercase `SectionTitle` **above** a plain card
  (`Activity.tsx:115-133`). Both screens call the filter "Needs attention" (screenshots `phone-budget-attn.png`
  and `phone-activity.png`). Choose one. Budget's toned headers carry status, so Activity could keep
  SectionTitle; just write the rule down.
- b. Amount format in Activity rows: "Needs category" rows show `formatCents(r.amount)` with no sign or color
  (`Activity.tsx:498`). Every other row uses `TxnRow`, which shows `{plus: true}` and green for inflows
  (`Activity.tsx:95-98`, `:50`). An inflow that needs a category shows as "$20.00" in black here and "+$20.00"
  in green everywhere else. Display only; it doesn't change any total.
- c. Trailing chevrons on rows that open a page are applied unevenly:
  - Settings `RowLink` and Rules rows have a `chevR` at 18 px (`common.tsx:81`, `Rules.tsx:75`).
  - Accounts rows (which open the register page) have none (`Accounts.tsx:329-361`).
  - The Accounts "Owed to you" row (`:286`), Reports category rows (`Reports.tsx:73`) and the transaction sheet
    Match row (`TxnSheets.tsx:395`) use a 16 px chevR.
  - The Targets list uses a text "›" (`BudgetSheets.tsx:853-854` @790df7f; now `Targets.tsx:388`). The other
    session should use `RowLink` or `chevR 18` when it turns this into a Page.
  - **Rule to adopt:** rows that open a page get `chevR` 18 px `text-faint`; rows that open a sheet don't.
    Then add the chevron to Accounts rows.
- d. Row heights: Settings, Accounts, Rules, Payees and Categories use `min-h-14`. Budget and Activity rows use
  `min-h-11` plus `py-2`/`py-2.5`. Reports and the category sheet's recent rows use `min-h-12`. Low impact;
  leave it unless rows are being touched.

## 12. Empty states: eight different looks (medium)

- Celebratory: `rounded-[14px] bg-funded-bg p-4 text-center 15px semibold` (`Budget.tsx:314`,
  `Activity.tsx:391`). Inside a card: `px-3 py-3.5 14px text-funded-fg` (`Activity.tsx:465`, `Owed.tsx:119`).
  Each pair is consistent.
- Neutral messages, all different:
  - "No transactions match." `p-4 text-center 14px` outside a card (`Activity.tsx:385`). "No transactions
    here." is the same (`Accounts.tsx:518`).
  - "No spending yet." inside a card, **left-aligned**, `p-4` (`Reports.tsx:56`).
  - "No history yet." no card, no padding (`Reports.tsx:153`).
  - "No categories yet." 13 px (`Categories.tsx:222`). "No transactions yet this month." 13 px `py-3`
    (`BudgetSheets.tsx:291` @790df7f).
  - "Nothing is marked as owed to you." `p-3` 14 px (`ActivitySheets.tsx:158`).
- **Missing:** the Rules list (`Rules.tsx:55-80`) and a Payees search with no matches (`Payees.tsx:102-124`)
  both render an empty bordered card.
- **Fix:** add `EmptyNote({children, inCard})` to `ui.tsx` (14 px muted, centered, `p-4`), use it for every
  neutral empty state, and add one to Rules ("No rules yet") and to Payees search ("No payee matches").

## 13. Notes and banners: `Banner` exists, but about 15 places build their own (medium)

- `Banner` (`ui.tsx:581`) is used only by `Budget.tsx:449` and `Accounts.tsx:312`.
- Hand-rolled versions:
  - Warnings: `Accounts.tsx:102-127` (SyncFailure, `rounded-[14px]` with an icon), `:291-306` (repair link),
    `:631` (repair sheet), `Connections.tsx:106`.
  - Over/under: `Budget.tsx:472`, `Owed.tsx:91`, `Connections.tsx:71`, `TxnSheets.tsx:247`, `Accounts.tsx:491`.
  - Info: `Budget.tsx:785`. Owed: `Owed.tsx:78`.
  - Success: `Note.tsx:49`, `Payees.tsx:95`, `Data.tsx:136`, `Connections.tsx:126`, `Owed.tsx:307`,
    `ActivitySheets.tsx:125, 325, 486`, `Accounts.tsx:612`, `TxnSheets.tsx:618`.
  - They use `rounded-xl` or `rounded-[14px]` and 13 or 14 px text. Banner's success and warn tones have a
    border; none of the hand-rolled success notes do.
- **Fix:** give `Banner` an optional `icon` and `to` (for the tappable repair and match cards), and use it
  for all of the above.
- a. **The same state gets different colors on different screens.** These are display only:
  - A late "Owed to you" item is orange on Budget: tone `under` (`Budget.tsx:206`, attention section `:93`).
    On the Owed screen its line is red: `text-over-fg` (`Owed.tsx:141`).
  - "Needs you to sign in again" is a yellow `warn` banner on Accounts (`Accounts.tsx:295`). On the Bank
    connections chip it is `under` (`Connections.tsx:178`), and in the Settings nav meta `text-under-fg`
    (`Settings.tsx:165`).
  - **Fix:** one tone per meaning: late = `under` everywhere, and repair needed = `warn` everywhere (or
    `under`; just one).
- b. Error notes: `Auth.tsx:70-77` (`Problem`) is a byte-for-byte copy of `ErrorNote`, so replace it.
  `Frame` is also duplicated, identically, in `Auth.tsx:56` and `Lock.tsx:15`; move it to `ui.tsx`.

## 14. Copy: one action, several words (medium)

- **Sync vs Refresh:**
  - Desktop Accounts button: "Refresh", then "Syncing…" (`Accounts.tsx:200`).
  - Phone button label: "Sync banks now" (`:211`). Pull to refresh: "Pull to sync banks", "Release to sync"
    (`:251`).
  - Failure card: "Try now" (`:124`).
  - Everything else says sync ("didn't finish syncing", "synced 9:42 AM").
  - **Standard:** "Sync" ("Sync now" on the button).
- **Add vs New, "+" text vs plus icon:**
  - "Add transaction"/"Add" with an icon (`Activity.tsx:317-318`).
  - "+ New rule" as text (`Rules.tsx:48`), "+ Group" (`Categories.tsx:122`).
  - "Add category" with an icon (`Categories.tsx:256-257`).
  - "+ Add a line" (`TxnSheets.tsx:908`), "+ Add condition" (`Rules.tsx:358`), "+ Link another bank"
    (`Connections.tsx:121`).
  - **Standard:** "Add {thing}" with `<Icon name="plus" size={16} stroke={2.6}/>`: "Add rule", "Add group",
    "Add line", "Add condition". Sheet titles can stay "New category" / "New rule".
- **Leaving a finished sheet:** "Done" (PrimaryButton) everywhere except Note, where it is "Back"
  (SecondaryButton, `Note.tsx:52`). Use "Done".
- **Backing out:** "Keep it" (inline delete confirmations), "Cancel" (link confirmation, Rename payee from a
  transaction `TxnSheets.tsx:986`, Activity select), "Not now" (reauth `Auth.tsx:265`). Keep "Keep it" for
  destructive confirmations and "Cancel" for the rest; "Not now" is fine for an interruption.
- **Save labels:** "Save", "Save rule", "Save note", "Save new date". Fine, but Rename payee and Rename account
  could say "Save name".

## 15. Duplicate flows that drifted apart (low to medium)

- **Rename payee** is built twice:
  - `TxnSheets.tsx:959-988`, from a transaction: a Cancel button, the raw bank name in one bordered row, no
    merge option.
  - `Payees.tsx:168-220`, from Settings: no Cancel, raw names in a monospace Card list, a "merge into"
    select.
  - Same title, same `track="payee.rename"`. **Fix:** one component; show the merge select in both, or in
    neither.
- **Appearance** has two different controls:
  - Phone Settings home: a hand-rolled segmented control with `role="radio"` (`Settings.tsx:300-321`), a copy
    of `Segmented`'s classes.
  - Desktop Appearance pane: large preview cards (`Settings.tsx:334-359`).
  - The phone can also reach `/settings/appearance` (it shows the preview cards under a BackHeader), so a phone
    user can meet both.
  - **Fix:** add a `radio` mode to `Segmented` and use it on both, or the cards on both.
- **Sheet vs Page for editing an item:** a rule is edited on a full Page (`Rules.tsx:271`). A category
  (`Categories.tsx:358`) and a payee (`Payees.tsx:168`) are edited in Sheets over their list Page. This is
  probably justified (rules are long forms), but say so in a decision so new editors know which to pick.
- **Undo after a one-tap change** shows up in four places:
  - an inline "Done just now" card (Budget fixes, `Budget.tsx:391-429`);
  - an inline Banner with an underlined "Undo" (Budget take-back, `Budget.tsx:449-467`);
  - a toast with Undo (categorize, archive);
  - a SecondaryButton "Undo" next to "Done" (Match, Transfer pick, Owed snooze, New month fill).
  - These follow where the change happens, so they are acceptable. The gaps are transaction delete (no Undo,
    see 6) and Unpair transfer (`TxnSheets.tsx:705-717`, no Undo while Unlink has one).

## 16. Desktop: content padding, gaps and widths (low)

- Top padding of the content column:
  - `py-5`: Budget (`Budget.tsx:1256`), Reports (`Reports.tsx:286`), Owed (`Owed.tsx:56`), Categories
    (`common.tsx:46`).
  - `pt-3`/`py-3`: Activity (`Activity.tsx:379`), Accounts and Register (`Accounts.tsx:232, 422`).
- Gap between blocks: `gap-3` on most screens, `gap-3.5` on Activity (`Activity.tsx:383`), `gap-4` in Reports'
  desktop column (`Reports.tsx:296`).
- Bottom padding on the phone: `pb-6` (Activity, Page), `pb-4` (Owed), none beyond `py-3` (Budget, Accounts,
  Reports).
- Card shells: `Card` is `rounded-[14px]`. The Budget desktop table is `rounded-xl` (`Budget.tsx:1085`), and
  Reports tiles are `rounded-xl` (`Reports.tsx:39`). About 12 `section`s hand-copy Card's classes (for
  example `Accounts.tsx:263, 433`, `Reports.tsx:55, 97, 136, 164, 204`, `Owed.tsx:68`, `Data.tsx:78`, and
  Activity Section `:131, :463` using a `div`).
- **Fix:** add a `ScreenBody` wrapper to `ui.tsx` (`px-4 pt-3 pb-6` on phone, `px-6 pt-5 pb-8` and
  `DESKTOP_WIDTH` on desktop, `gap-3`) and use it in the six tab and sub screens. Use `Card` for the hand-copied
  shells.
- `DESKTOP_WIDTH` is applied consistently. The only exception is the Settings pane (`max-w-[680px]`,
  left-aligned, `common.tsx:26`), which is deliberate (`wide`).

## 17. Icons (low)

- The same icon at different sizes in the same role:
  - `more`: 22 px (`ui.tsx:132`) vs 24 px (`Accounts.tsx:685`).
  - Month chevrons: 22 px (`Budget.tsx:702/722`) vs 20 px (`Reports.tsx:256/269`).
  - Trailing row chevrons: 16 vs 18 px (see 11c).
  - Header icons on Accounts: refresh 21 px vs gear 22 px (`Accounts.tsx:216/224`).
  - Alerts in warning cards: 20 px stroke 2.4 (`Accounts.tsx:111, 297`) vs 16 px stroke 2.6 (`Budget.tsx:798`).
- **Fix:** header icon buttons 22 px, trailing chevrons 18 px, inline status icons 14 or 16 px. Write these
  in a comment by `ICONS`.

## 18. Small things (low)

- Status chips have two shapes. Transaction badges are `rounded-md px-2 py-0.5` (`Activity.tsx:68`).
  Connection status is `rounded-full px-2.5 py-1` (`Connections.tsx:205`). Pick one (rounded-md, as on the
  rows people see most).
- The Payees search (`Payees.tsx:38-47`) lacks `type="search"`, Escape to clear and
  `placeholder:text-faint`, which Activity (`Activity.tsx:322-335`) and the CategoryPicker
  (`CategoryPicker.tsx:116-125`) have. Extract `SearchField`.
- Amount inputs: transaction sheets build a 17 px input by hand (`TxnSheets.tsx:254, 271`); the category sheet
  uses `inputClass` plus 18 px (`BudgetSheets.tsx:206`). Use one size.
- Disabled states: `opacity-50` (`Accounts.tsx:122, 197, 214`, `Activity.tsx:509`), `opacity-60`
  (`Data.tsx:210, 268`), `bg-sunken text-disabled` (SoftButton), `bg-disabled-bg text-muted` (PrimaryButton,
  `Budget.tsx:337`), `bg-disabled text-on-accent` (`Activity.tsx:585`). One per button kind, as in 5a and 5d.
- Setup and Auth headings: Setup steps 24 px (`Setup.tsx:125, 161, 298`), Auth and Lock 26 px (`Auth.tsx:63`,
  `Lock.tsx:21`), Welcome 32 px. Setup uses `bg-surface max-w-[560px]`; Auth uses `bg-page max-w-[400px]`.
  Low priority, since these are rarely seen.
- The reauth "Confirm it's you" prompt is a centered dialog (`Auth.tsx:236-270`), the only non-Sheet modal.
  Fine as a system interruption; mentioned only for completeness.

---

## Suggested order of work

1. A `PhoneHeader` component, and `BackHeader` at 56 px (section 1). Add Register chips to the header (4).
2. Replace `AccountMenu` with `OverflowMenu` (2).
3. Button variants: export `softButtonClass`/`tone` and `TextButton`; switch the inline confirmations to
   Primary/Secondary (5).
4. `ConfirmInline` for transaction delete, group remove, passkey remove and sign out (6).
5. `SheetTitle` everywhere, with an amount variant; main sheet actions in `footer` (7, 8).
6. `SectionTitle`, `EmptyNote`, `Banner` with icon and link; one tone per meaning (10, 12, 13).
7. Copy: Sync, "Add …", Done (14).
8. `MonthSwitcher`, the merged Rename payee, Appearance control, `ScreenBody` (9, 15, 16).
