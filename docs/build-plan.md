# Build plan

Open work only, one line per item. Add an item when you find work that is left; delete its line in the PR that finishes it. Don't log finished work here: the PR's title and description record it. Work up to Nov 4, 2026 is in `docs/build-history.md` (D-59).

This file merges with `merge=union` (`.gitattributes`): after a local merge, check for an item listed twice.

Legend: **(manual)** needs the owner (Cloudflare, Plaid Production, GitHub settings).

## Open

- [ ] Activity screen: check CPU on the real app's analytics; build a stored recent-rows list only if p95 is 8 ms or more.
- [ ] Later, only if wanted: invites, People with a reset link, Plaid link slots per user, account deletion, an isolation test (`docs/multi-user.md` 7.3, 7.4, 9.1, 10, 11).
- [ ] A way to match a pending row to a posted row by hand (an `ambiguous_match` alert on Accounts only opens the posted row today).
- [ ] Payee names from Plaid and no cleanup of bank text, in payees and the pending matcher (`docs/payee-names.md`); waits for the owner's OK to its section 9.
- [ ] On the owner's iPhone after deploy: PRF in the Home Screen app with the existing passkey, first download time, Face ID unlock with no signal.

## Contract gaps (not blocking)

The UI works around these (details in `apps/web/CONTRACT_NOTES.md`):

- [ ] Candidate deposits for an unclear transfer in the API (the UI searches other registers today).
- [ ] Endpoints: reopen an owed item, accept a changed amount, edit a manual entry's amount or date, unlink a refund, mark a transfer to an unlinked account by hand.
- [ ] Extra fields: the new-month carry-over summary, recent paybacks, the repeat interval on upcoming rows, per-filter register counts, amounts on Move money options.
- [ ] Desktop: account registers in the side panel, and a per-row category dropdown in Activity.
