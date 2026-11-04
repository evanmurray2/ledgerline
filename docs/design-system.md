# Design system

The web app's tokens and shared parts, and when to use each. Everything visual comes from here: a screen uses a
token or a shared part, never a typed-in color, size, corner or shadow. `docs/design-review.md` covers how screens
look next to each other; this page covers the pieces they are built from.

## Tokens (`apps/web/src/styles.css`)

### Colors

One set of named colors, each with a light and a dark value (`--ll-*`, used as Tailwind classes without the
prefix: `bg-surface`, `text-muted`, `border-line`). Any element can set `data-theme="light"` or `"dark"` to draw
that theme's colors (the theme preview in Settings does).

| Group    | Tokens                                                             | Use                                                                   |
| -------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Surfaces | `page`, `surface`, `surface-2`, `sunken`                           | Screen background, cards and sheets, a quieter card, wells and inputs |
| Lines    | `divider`, `line`, `line-strong`, `track`                          | Between rows, card borders, text box borders, empty part of a bar     |
| Text     | `ink`, `ink-2`, `muted`, `faint`, `disabled`                       | Main, secondary, notes, placeholders, unavailable                     |
| Accent   | `accent`, `accent-strong`, `accent-soft`, `on-accent`              | Links and main buttons; `accent-strong` is their hover                |
| Inverse  | `inverse`, `on-inverse`, `inverse-line`, `inverse-muted`           | Toasts and the selected chip                                          |
| Status   | `funded-*`, `low-*`, `over-*`, `under-*`, `overfunded-*`, `none-*` | A category's state: `-bg`, `-fg` (text) and `-bar`, through `TONE`    |
| Notes    | `info-*`, `warn-*`, `success-*`, `owed-*`, `danger`, `on-danger`   | `Banner` tones, Owed, removals                                        |
| Other    | `rta-*`, `count-*`, `scrim`, `scrim-a`, `shadow`, `shadow-soft`    | Ready to Assign bar, `CountBadge`, behind a sheet, shadows            |

`index.html` repeats `surface` (light, dark) for the phone's status bar: HTML can't read CSS. Keep them equal.

### Text sizes

Tailwind's own sizes are cleared; these are the only ones.

| Class       | Size  | Use                                                         |
| ----------- | ----- | ----------------------------------------------------------- |
| `text-xs`   | 12 px | Small notes under a row, badges, tab labels, section labels |
| `text-sm`   | 13 px | Field labels, help text, pills                              |
| `text-md`   | 14 px | Text buttons, secondary rows, banners                       |
| `text-base` | 15 px | Row titles and body text                                    |
| `text-lg`   | 16 px | Buttons and every text box                                  |
| `text-xl`   | 17 px | Amount boxes, month title, row amounts                      |
| `text-2xl`  | 20 px | Sheet and sub-page titles, large amounts in a card          |
| `text-3xl`  | 22 px | Tab titles                                                  |
| `text-4xl`  | 26 px | The one big amount on a screen, the welcome title           |

A text box is never below `text-lg`: iPhone Safari zooms in on a smaller one when it is tapped. Line heights are
Tailwind's (`leading-tight`, `-snug`, `-normal`, `-relaxed`). Upper-case labels use `tracking-caps` (0.5 px).

### Corners and shadows

| Class          | Size  | Use                                              |
| -------------- | ----- | ------------------------------------------------ |
| `rounded-sm`   | 4 px  | Bars, status tags                                |
| `rounded-md`   | 8 px  | Small parts inside a card: a segment, a nav item |
| `rounded-lg`   | 12 px | Cards, buttons, text boxes, banners, toasts      |
| `rounded-xl`   | 20 px | The top of a sheet                               |
| `rounded-full` | round | Pills, chips, badges, icon buttons, switches     |

| Class            | Use                                 |
| ---------------- | ----------------------------------- |
| `shadow-low`     | A selected segment, a switch's knob |
| `shadow-raised`  | A toast, the floating Note button   |
| `shadow-overlay` | A menu, a sheet, a dialog           |

### Motion

`ll-sheet` (sheet up, 220 ms), `ll-scrim` (fade, 180 ms), `ll-page-in` / `ll-page-back` (page arriving, 220 ms),
`animate-spin` (busy). All stop under reduced motion.

## Shared parts (`apps/web/src/components`)

Import them from `components/ui`, which re-exports `buttons`, `headers` and `fields`.

### Buttons (`buttons.tsx`)

| Part                          | Use                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `PrimaryButton`               | The one main step at the foot of a sheet or page. `danger` for a removal.    |
| `SecondaryButton`             | The outlined second step next to it.                                         |
| `SoftButton` / `SoftLink`     | The small pill on a row or card. Tones: `soft`, `filled`, `outline`.         |
| `TextButton`, `textLinkClass` | A quiet text action: "Show archived", "Add line".                            |
| `DangerLink`                  | Red text that starts a removal ("Delete…"); `ConfirmInline` confirms it.     |
| `HeaderAction`                | A screen header's action: a pill with an icon, or `iconOnly` on a phone tab. |

All of them: `mutates` disables the button offline or read-only; hover shows only on a computer; pressed dims to
70 %; disabled looks the same in every tone. `PrimaryButton busy` keeps its color, shows a spinner and can't be
tapped again: pass it whenever the label says "Waiting…" or the step is running.

### Form parts (`fields.tsx`)

| Part               | Use                                                                                |
| ------------------ | ---------------------------------------------------------------------------------- |
| `Field`            | A label above a text box, list or picker.                                          |
| `inputClass`       | The one text box and list (`<select>`): 44 px tall, 16 px text.                    |
| `amountInputClass` | The amount box in every sheet: 17 px bold, tabular digits.                         |
| `inputBoxClass`    | The text box without a text size, for a box that sets its own (never below 16 px). |
| `Checkbox`         | Picking items from a list. 22 px, accent when on.                                  |
| `Toggle`           | An on/off setting (a switch, not a checkbox).                                      |
| `SearchField`      | The one search box. Escape clears it.                                              |
| `Label`            | An upper-case label over a group.                                                  |

A link or button that opens a picker in a form (`CategoryField`, the split link on a transaction) uses
`inputClass` with a chevron, so it reads as one of the boxes.

### Display (`ui.tsx`)

| Part                                | Use                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `Card`, `SectionTitle`              | A bordered group of rows, and the heading above it.                           |
| `Pill`, `StatusWord`, `Bar`         | A category's state, in its `TONE`.                                            |
| `Money`                             | An amount, formatted, tabular digits.                                         |
| `Chip`                              | A filter in a `chip-row`.                                                     |
| `CountBadge`                        | A count of to-dos; `danger` for problems; `size="sm"` on a tab icon.          |
| `Segmented`                         | Two to four choices in a row.                                                 |
| `OptionCard`                        | A larger choice with a description.                                           |
| `Banner`                            | The one note or warning card: `info`, `warn`, `neutral`, `danger`, `success`. |
| `EmptyNote`, `Loading`, `ErrorNote` | Nothing here, waiting, failed.                                                |
| `Icon`                              | Every icon, by name.                                                          |

### Frames

`Sheet` and `SheetTitle` (a bottom sheet on a phone, a panel or dialog on a computer), `PageFrame`, `BackHeader`
and `PhoneHeader` (`headers.tsx`), `TabHeader` and `MonthBar`, `AppShell`, `Toast`.

## Adding something

Use an existing part first. If a screen needs a new look, add it to a shared part (a variant or a prop) and to
this page, not to the screen. A new token needs a light and a dark value with at least 4.5:1 contrast for text.
