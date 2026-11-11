# Build plan

Open work only, one line per item. Add an item when you find work that is left; delete its line in the PR that finishes it. Don't log finished work here: the PR's title and description record it. Work up to Nov 4, 2026 is in `docs/build-history.md` (D-59).

This file merges with `merge=union` (`.gitattributes`): after a local merge, check for an item listed twice.

Legend: **(manual)** needs the owner (Cloudflare, Plaid Production, GitHub settings).

## Open

- [ ] (waits for D-78) Accounts without a bank link: users who can't link banks (D-75) can't make an account at all. Needs the owner's Money-rules answers on starting balances first.
- [ ] (waits for D-78) Before `OTHER_USERS_BANKS` is on (Plaid Production): remove a deleted account's banks at Plaid. Today deleting an account with linked banks is refused, and only admins link banks (`docs/open-signup.md` 12).
- [ ] A way to match any pending row to a posted row by hand ("Same purchase?" on Activity covers only the rows the matcher asks about).
- [ ] Processing CPU when one sync brings many pending rows to a busy card: the 25-pending-row step is 11–17 ms (median 12) after the Nov 9 key-lookup fixes (`docs/measurements.md`); the posted step and the heal step are under 10 ms. What is left is cold JavaScript in the matching code and about 3 ms of writes. Smaller steps don't help: the cost is per step, and the number of "Same purchase?" questions changes (22, not 24).
- [ ] Find what read 327,000 and 413,000 BudgetStore rows in the hours of Nov 4 21:00 and Nov 5 14:00 UTC. It wasn't a phone full download: Workers Logs has no `sync_full` (or any line) in those hours, and a full download is about 2,300 rows. Since this line: a call that reads 20,000 rows or more logs `heavy_read` with its route or job kind (`apps/worker/src/store/heavy-reads.ts`); search Workers Logs for it after the next spike. A likely part of it: until Nov 9 the hot key lookups in processing read every bank row (`test/key-lookups.test.ts`).
- [ ] On the owner's iPhone after deploy: PRF in the Home Screen app with the existing passkey, first download time, Face ID unlock with no signal.
- [ ] Owed to you: each row's "Match money back" opens the first waiting deposit; open the match sheet with that row's item picked.
- [ ] Transaction sheet, income "Goes to": the toggle and its help line use different tests and can disagree for income already moved to next month.
- [ ] Offline, "Same as your {payee}?" hides, and "Use {n} suggestions" then includes those rows.
- [ ] Desktop Assign button (sidebar and Ready to Assign bar): grayed out offline or in view only with no reason shown.
- [ ] Full backup: the Why points to the restore guide, but restoring needs the browser console (`docs/runbooks/restore.md`); add a real restore path or a link.
- [ ] Two texts that never show: the passkey's "Use your passkey to continue" (NotAllowedError is read as Cancelled) and the "Your budget was restored" download reason (`copy.ts` never sets it).
- [ ] Payee names: the server takes a name of only spaces (min length is checked before trim) and NUL or right-to-left override characters.
- [ ] Activity search: "café" doesn't find "CAFÉ" on posted rows (SQLite `lower()` folds only ASCII).
- [ ] Signing in with a different user's passkey on the same browser leaves the earlier user's session row until it expires (24 h); it lists as another device.
- [ ] Desktop: the Assigned cell cuts off $99,999,999.99; group rows are keyed by name, so two groups with one name share a key.
- [ ] Full backup can't be restored: `BudgetStore.restoreDump` and `restoreVerify` work (tests only), but no route or tool reaches them, and a restore needs an empty budget. Design a runbook path (owner, Nov 9: a runbook step, not a button); `docs/runbooks/restore.md` says so today.
- [ ] Only if two devices ever show different numbers for the same data: a check where each device posts a hash of its month and Needs attention says when two differ (owner, Nov 9: skipped for now; `engine.test.ts` and `engine-upgrade.test.ts` cover the known causes).
- [ ] Card refunds can't be linked to their purchase: nothing makes a `refund_of` link outside the test data, so the payment category always gives back what it holds (Money rule 3, unlinked), and "Not this purchase" has nothing to unlink (D-80).
- [ ] Privacy design (`docs/privacy.md`; owner's decisions in D-85 to D-88): being built in the order of its section 10, one PR per step. Built: no name at sign-up; the rule that the owner merges key code; the key formats (`docs/privacy-keys.md`). The key code in `packages/seal` is being built part by part (`docs/privacy-keys.md` section 15 lists what is built); the owner merges each part (D-88). Still needs the owner when built: the exact transfer look-back rule (D-86 item 2), and each migration.
- [ ] Privacy design, for the Worker and the app when they use `packages/seal` (`docs/privacy-keys.md` 7.2, 8): check and store a write under one lock; keep the log state's device counters and public entries as rows, not one value; measure a 16-entry write on Cloudflare before raising that limit, and decide how a first bank run larger than 16 parts (about 1 MB of rows) is filed; keep the entry a snapshot stands at; count the never-held kinds per budget per day; show a notice on every device for a planned key change and for a way in another device added.
- [ ] Settings → Privacy (`apps/web/src/screens/settings/Privacy.tsx`) says what is true today: change its text in the same PR as each privacy phase that changes who can read what, and add the idle date and Delete account when those exist (`docs/privacy.md` 7).
- [ ] Hosted Link (`docs/privacy.md` 5.7): Plaid's "session finished" webhook is not used as a second way to finish a link; the routes for the old script flow (`link-token` without `hosted`, `exchange`) can go once no installed app is older than Nov 11, 2026.
- [ ] Cloudflare's invocation logs hold each request's IP address, location and full address for 3 days (`docs/privacy.md` 15.4). The owner keeps them for now (D-90). Turn them off (`invocation_logs` in `apps/worker/wrangler.jsonc`, an owner's path) before any claim about IP addresses and before other people are invited; then change the line on Settings → Privacy.
- [ ] `docs/privacy-policy.md` is a draft the owner has not read yet. Before other people are invited: the owner reads it, the **(later)** lines go, a page in the app shows it, and a contact is set (`docs/privacy.md` 11).
- [ ] One test in `apps/worker/test/objects` failed once in a local `pnpm check` (Nov 11, 2026) and passed in the 5 runs after it and in CI; its name was not caught. If it shows again, read the failing run's output before anything else.
- [ ] One time for each bank update (D-86 A1, `docs/privacy.md` 14.2): updates are now applied and filed one at a time in `sync_run.fetch_seq` order (`apps/worker/src/sync/turn.ts`), but every time a filing step writes is still that step's own clock. To build: read `sync_run.fetched_at` for a row's arrival and removal, a vanished pending row, the bank balance time and the start of a bank difference, the heal window, the "history changed" month (in the budget's time zone) and the liability snapshot day. Then A4: an edit never lands in the middle of an update. Ask the owner before each goes live.
- [ ] Privacy design, phase 0 checks still to do (`docs/privacy.md` 15.4). On the owner's iPhone **(manual)**: peak memory while a real budget is filed (the device checks passed on Nov 10, 2026 in Safari, the Home Screen app and a desktop browser; remove Settings → Device check when phase 0 ends). On Plaid, in Sandbox or repair mode only: whether an old cursor is accepted again. On Cloudflare: what a wiped store and deleted rows leave behind; the sealing steps' CPU (measured locally, `docs/measurements.md`).

## Contract gaps (not blocking)

The UI works around these (details in `apps/web/CONTRACT_NOTES.md`):

- [ ] Candidate deposits for an unclear transfer in the API (the UI searches other registers today).
- [ ] Endpoints: accept a changed amount, edit a manual entry's amount or date, mark any transaction (not only an unclear transfer) as a transfer to an unlinked account by hand.
- [ ] Extra fields: the new-month carry-over summary, recent paybacks, the repeat interval on upcoming rows, per-filter register counts, amounts on Move money options.
- [ ] Desktop: account registers in the side panel, and a per-row category dropdown in Activity.
