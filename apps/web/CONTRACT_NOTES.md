# Contract notes (web)

Gaps found while building the SPA against `packages/contracts` and `docs/api.md`. Each one is worked around in
the UI; none of them edits the contract.

## Missing data

| Screen                                       | Gap                                                                                | Workaround                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| Match money back · "something I didn't mark" | `MatchView.open` has only items already marked owed; no recent unmarked purchases. | Shows a hint to mark the purchase as owed first. |

## Missing actions

| Screen                   | Gap                                                                                                 | Workaround                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Settings · stop tracking | The design offers to delete the stored log when tracking is turned off; there's no delete endpoint. | Shows that collection stopped and that raw events age out after 90 days.                       |
| Repair                   | `LinkExchange` is for new Items; Plaid update mode returns no new public token to exchange.         | After Link succeeds in repair mode the app calls `POST /api/settings/connections/:id/refresh`. |

## Assumptions

- The Worker reports the daily limit with error code `read_only` (or `readonly`). The app then refetches
  `GET /api/session` and shows the banner with `readOnlyUntil` in Pacific time. `writeState: 'paused'` (70%) is
  treated as writable.
- A Needs attention item in section `Ready to Assign` (negative Ready to Assign) has no category; the Budget
  screen shows a "Take it back from" list that calls `POST /api/budget/move` to `rta`.
- Mutations with no body (`unlink`, `unpair`, `refresh`, `apply`) send `{}` so they still carry
  `content-type: application/json`.
- Sign out calls `POST /api/settings/security/sign-out` (passkeys, D-27).
