# D-121: An archived category takes no new money or spending (Nov 16, 2026)

The two-devices hunt (`docs/hunts.md`, `apps/worker/test/two-devices.test.ts`) found that an archived category could
end with money or overspent. One device archives a category; another, offline, assigns money to it or puts a
purchase in it. When the second device syncs, its edit is run again after the archive and went through. D-79 refuses
to archive an overspent category because Budget lists no overspending for archived ones, so this hid it again.
The owner said yes to refusing these edits (Nov 16, 2026).

1. **New money is refused.** `POST /api/budget/assign`, `/set` and `/move` answer 422 `archived` when a category
   that is archived would hold more than before. Taking money out of one is allowed, so a category left with money
   can still be emptied. Moving a purchase out of an archived category frees what it spent there, so an archived
   category may hold money, but it is never overspent.
2. **New spending is refused.** A row put in an archived category (`PATCH /api/transactions/:key` with
   `categoryId`), a split line in one, and a new entry in one answer 422 `archived`. A row that is already in the
   category may keep it, and a split of it may keep a line there: the split sheet sends every line again.
3. **An archive sent at 0 is checked too.** An archive (or a remove that archives) sent with `through` is refused
   with 409 `changed` when the copy changed after `through`, whatever `available` it sent. Before, only an archive
   that moved money was checked, so an archive worked out at 0 went through after another device's edit had put
   money in the category.

An edit refused this way while it waited in a device's queue is lost, and the app says so, as for any edit that no
longer passes. Restore the category in Settings to use it again. Tests: `apps/worker/test/archived-edits.test.ts`.
