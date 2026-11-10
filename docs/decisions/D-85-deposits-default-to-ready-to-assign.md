# D-85: Money into checking or savings goes to Ready to Assign with nothing chosen (Nov 10, 2026)

**Decided by the owner** (chat, Nov 10, 2026): "I want to default to ready to assign on inflows. The problem is
that I still have to choose a category."

**Before.** A deposit the bank sent had no category and was not in Ready to Assign: it counted as uncategorized and
waited in Activity's Needs category. Its sheet still showed "Goes to: Ready to Assign now" (the sheet is the income
sheet for any money into checking or savings), and Save changed nothing, so the row stayed in Needs category.

**Decision.**

1. **Money into a checking or savings account that has no category is in Ready to Assign**, in its budget month.
   The rule is worked out when the budget is, not stored: `rtaByDefault` in `apps/worker/src/ledger/ledger.ts`
   (`to_rta` stays 0 until you choose). It applies to deposits already in the budget and to entries you add.
2. **It doesn't wait in Needs category**, on Activity, the badge or an account's Needs filter.
3. **What comes first is unchanged:** Waiting to match, a transfer (paired, to sort out, or to an account that isn't
   linked) and a split are checked before it, as they are before a chosen Ready to Assign.
4. **A credit on a card still needs a category** (a refund goes back to the purchase's category; rewards go to Ready
   to Assign, D-13): the card's payment category depends on which.
5. **You can still give a deposit a category.** The income sheet now has the Category field, which reads Ready to
   Assign; "Needs a category" isn't one of its choices for money in. "Goes to" (now, or saved for next month) shows
   while the category is Ready to Assign.
6. "Which account sent this money?" answered "It was income" puts the deposit in Ready to Assign.

No migration: nothing stored changes.
