# D-67: Bug sweep answers: later-month spending, owed split lines, undo of Remove, Fill targets, closing a card (Nov 12, 2026)

**Decided by the owner** (chat, Nov 12, 2026). A bug sweep of the app found problems where the fix changes how money is
counted. Asked each question, the owner answered "Yes to everything", then "m3: it should warn you" and, for closing a
card, chose "do 1" (a button on Close account, nothing else).

1. **Counts in a later month (spending).** A purchase whose "Counts in" is set to a later month counts as that month's
   spending and leaves the month it was made in. Before, it counted in neither month.
2. **Owed to you on a split line.** A split line marked Owed to you makes an owed item for that line's amount, the same
   as a whole purchase marked owed. Before, the line became spending with no category.
3. **Undo after Remove category** gives back the money that Remove moved to Ready to Assign. Before, the category came
   back at $0.
4. **Fill targets and Fund all** warn before Ready to Assign would go below zero; the owner can then go on. Before,
   they assigned it all with no warning.
5. **Remove category** also sends the money assigned to it in later months back to Ready to Assign. Before, only this
   month's available moved; later months' money stayed in the archived category.
6. **Closing a card whose payment category holds money:** Close account offers "Move $X to Ready to Assign", and the
   card can then be closed in the same sheet. Card payment categories stay out of Move money. Before, the sheet was a
   dead end.
