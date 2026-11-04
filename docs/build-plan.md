# Build plan

Open work only, one line per item. Add an item when you find work that is left; delete its line in the PR that finishes it. Don't log finished work here: the PR's title and description record it. Work up to Nov 4, 2026 is in `docs/build-history.md` (D-59).

This file merges with `merge=union` (`.gitattributes`): after a local merge, check for an item listed twice.

Legend: **(manual)** needs the owner (Cloudflare, Plaid Production, GitHub settings).

## Open

- [ ] Activity screen: check CPU on the real app's analytics; build a stored recent-rows list only if p95 is 8 ms or more.
- [ ] Later, only if wanted: invites, People with a reset link, Plaid link slots per user, account deletion, an isolation test (`docs/multi-user.md` 7.3, 7.4, 9.1, 10, 11).
- [ ] A way to match a pending row to a posted row by hand, and a screen for `ambiguous_match` and `vanished_pending` alerts (the alert table is not shown anywhere yet).
- [ ] On the owner's iPhone after deploy: PRF in the Home Screen app with the existing passkey, first download time, Face ID unlock with no signal.
- [ ] The mock API (`apps/web/src/mock`) still has its own engine for the mock tests; replace it with a sample sync dataset fed to the real engine.
- [ ] Payees and categories, suggest then OK (`docs/payees.md`, agreed Nov 4): left: 4. "New" payees and the suggested Join.

## Contract gaps (not blocking)

The UI works around these (details in `apps/web/CONTRACT_NOTES.md`):

- [ ] Candidate deposits for an unclear transfer in the API (the UI searches other registers today).
- [ ] Endpoints: reopen an owed item, accept a changed amount, edit a manual entry's amount or date, unlink a refund, mark a transfer to an unlinked account by hand, create a payee from a rule.
- [ ] Extra fields: default selection on Assign suggestions, the new-month carry-over summary, recent paybacks, the repeat interval on upcoming rows, per-filter register counts, amounts on Move money options.
- [ ] Desktop: account registers in the side panel, and a per-row category dropdown in Activity.
