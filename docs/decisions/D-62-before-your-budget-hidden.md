# D-62: "Before your budget" rows are never listed (Nov 4, 2026)

**Decided by the owner.** D-61 left these rows (`isHistory` in `apps/worker/src/views/rows.ts`) out of Activity's lists, but a search still found them and the account's register still showed them. The owner asked for them to be hidden everywhere. Now no list shows them:

1. **Account register.** `GET /accounts/:id/register` leaves them out of every filter (All, Pending, Needs a category, Transfers). The running balance still walks back through them, so each day's balance is unchanged.
2. **Activity search.** A search applies the same budget-start condition as the month and plain lists (`IN_BUDGET` in `apps/worker/src/routes/activity.ts`).
3. **Category sheet.** Its recent rows and their count leave them out (`NOT_HISTORY` in `apps/worker/src/views/rows.ts`), for a row that already had a category in the budget's first month.

The rows stay in the database and stay read-only (D-61). A saved link to one still opens its read-only sheet. Reports, net worth, the drift check and the data exports still use them. Nothing about how money is counted changes. Owed to you items already marked on such a row (D-61 point 2) still show on Owed to you, since hiding them would hide money still owed.
