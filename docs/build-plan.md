# Build plan

Open work only, one line per item. Add an item when you find work that is left; delete its line in the PR that finishes it. Don't log finished work here: the PR's title and description record it. Work up to Nov 4, 2026 is in `docs/build-history.md` (D-59).

This file merges with `merge=union` (`.gitattributes`): after a local merge, check for an item listed twice.

Legend: **(manual)** needs the owner (Cloudflare, Plaid Production, GitHub settings).

## Open

- [ ] Activity screen: check CPU on the real app's analytics; build a stored recent-rows list only if p95 is 8 ms or more.
- [ ] Accounts without a bank link: users who can't link banks (D-75) can't make an account at all, since CSV import needs an existing one. Needs the owner's Money-rules answers on starting balances first.
- [ ] Before `OTHER_USERS_BANKS` is on (Plaid Production): remove a deleted account's banks at Plaid. Today deleting an account with linked banks is refused, and only admins link banks (`docs/open-signup.md` 12).
- [ ] A way to match any pending row to a posted row by hand ("Same purchase?" on Activity covers only the rows the matcher asks about).
- [ ] Processing CPU when one sync brings many pending rows to a busy card: 12–37 ms per step in `measure/entry-covers.measure.ts` (mostly the batch's writes; `docs/measurements.md`).
- [ ] Find what read 327,000 and 413,000 BudgetStore rows in the hours of Nov 4 21:00 and Nov 5 14:00 UTC. It wasn't a phone full download: Workers Logs has no `sync_full` (or any line) in those hours, and a full download is about 2,300 rows.
- [ ] On the owner's iPhone after deploy: PRF in the Home Screen app with the existing passkey, first download time, Face ID unlock with no signal.
- [ ] Owed to you: each row's "Match money back" opens the first waiting deposit; open the match sheet with that row's item picked.
- [ ] Removing a category: the confirm says nothing when the category is overspent; needs the owner's Money-rules answer on what happens to the negative amount.
- [ ] Transaction sheet, income "Goes to": the toggle and its help line use different tests and can disagree for income already moved to next month.
- [ ] Offline, "Same as your {payee}?" hides, and "Use {n} suggestions" then includes those rows.
- [ ] Desktop Assign button (sidebar and Ready to Assign bar): grayed out offline or in view only with no reason shown.
- [ ] Full backup: the Why points to the restore guide, but restoring needs the browser console (`docs/runbooks/restore.md`); add a real restore path or a link.
- [ ] Two texts that never show: the passkey's "Use your passkey to continue" (NotAllowedError is read as Cancelled) and the "Your budget was restored" download reason (`copy.ts` never sets it).
- [ ] CSV import: one request takes the whole file (up to 5 MB), so a file of thousands of rows likely passes 10 ms of CPU; measure it, and send it in parts if so (keep the duplicate check right across parts).
- [ ] CSV import into a linked account: history rows that Plaid also sent (before the budget start) count twice in Reports and net worth. Needs the owner's answer on how to tell them apart (dates differ by a day, names differ).
- [ ] CSV import into a card: some banks export purchases as positive amounts, which then read as credits. Needs the owner's answer on the sign for card files.
- [ ] Split amount changes: the "absorbs remainder" line never takes the difference when a split row's amount changes (an edit, a pending row posting at another amount), so the difference is in no category. Needs the owner's Money-rules answer.
- [ ] Your own entries dated before the budget start are accepted and counted; bank rows there are read-only history (D-61, D-67). Needs the owner's answer: refuse them, or keep them as uncleared checks.
- [ ] Payee names: the server takes a name of only spaces (min length is checked before trim) and NUL or right-to-left override characters.
- [ ] CSV export: cells that start with `=`, `+` or `@` can run as spreadsheet formulas; quote or prefix them.
- [ ] Activity search: "café" doesn't find "CAFÉ" on posted rows (SQLite `lower()` folds only ASCII).
- [ ] Signing in with a different user's passkey on the same browser leaves the earlier user's session row until it expires (24 h); it lists as another device.
- [ ] Desktop: the Assigned cell cuts off $99,999,999.99; group rows are keyed by name, so two groups with one name share a key.

## Contract gaps (not blocking)

The UI works around these (details in `apps/web/CONTRACT_NOTES.md`):

- [ ] Candidate deposits for an unclear transfer in the API (the UI searches other registers today).
- [ ] Endpoints: reopen an owed item, accept a changed amount, edit a manual entry's amount or date, unlink a refund, mark a transfer to an unlinked account by hand.
- [ ] Extra fields: the new-month carry-over summary, recent paybacks, the repeat interval on upcoming rows, per-filter register counts, amounts on Move money options.
- [ ] Desktop: account registers in the side panel, and a per-row category dropdown in Activity.
