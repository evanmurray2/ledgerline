# D-55: One look per meaning (Nov 3, 2026)

The owner asked for the whole app to look and work the same way everywhere, on a phone and a computer, after
the design review (`docs/design-review.md`) found 18 kinds of difference. D-54 settled pages vs sheets and the
header action. These rules settle the rest; the shared pieces live in `apps/web/src/components`.

- **Headers.** A tab's own screen on a phone: `PhoneHeader` (56 px, 22 px title). A screen opened from another
  one: `BackHeader` (56 px, 19 px title after Back). A computer: the 64 px desktop header for both. Search and
  filter chips sit in the header, counts as badges. Header icon buttons are 44 px with 22 px icons; there is one
  ⋯ menu (`OverflowMenu`).
- **Buttons.** Full width: `PrimaryButton` (filled; red for a removal) and `SecondaryButton` (outlined). Small:
  the pill (`SoftButton`/`SoftLink`) in three tones: soft (the usual one), filled (the one main step in a card),
  outline (a quieter second step). Text actions: `TextButton`, 14 px bold blue. Each kind has one disabled look.
- **Removing anything** starts from red text ("Remove Groceries…", "Delete…", "Sign out…") and asks in an inline
  red card with Keep it and a red button (`ConfirmInline`). The "…" means a question follows. Deleting a
  transaction asks too: the server can't bring one back, so there's no Undo for it.
- **Sheets.** Titles use `SheetTitle` (transaction sheets: tag line, amount, details, in that order). The sheet's
  main Save or confirm sits in the footer, above the keyboard.
- **Lists.** A row that opens a page ends with an 18 px chevron; a row that opens a sheet doesn't. Labels above
  cards are `SectionTitle`; labels in sheets are `Label`. A neutral "nothing here" is `EmptyNote`.
- **Notes and colors.** Notes and warnings are `Banner`s. One tone per meaning: late is orange (under) on every
  screen; a bank that needs you to sign in again is yellow (warn) on every screen.
- **Words.** Banks sync: the button is "Sync". Adding says "Add {thing}" with a plus icon. A finished sheet
  closes with "Done". A removal is backed out of with "Keep it", anything else with "Cancel".

Nothing here changes how money is counted. Two items change only how something is shown: a transaction that
needs a category shows its amount like every other row (+ and green for money in), and a late Owed to you item is
the same color on Budget and on Owed to you.
