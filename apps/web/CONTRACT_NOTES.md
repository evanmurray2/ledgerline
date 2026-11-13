# Contract notes (web)

Gaps found while building the SPA against `packages/contracts` and `docs/api.md`. Each one is worked around in
the UI; none of them edits the contract.

## Missing data

| Screen                                       | Gap                                                                                                     | Workaround                                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transfer: pick the other side                | No list of candidate deposits for an unclear transfer (`TxnSheet` and `ActivityView` don't carry them). | The sheet loads the other accounts' registers and offers deposits of the opposite amount within 5 days. `TransferPick.otherKey` is that row's key. A `candidates` array on `TxnSheet` would be cheaper.                 |
| New month starts                             | `BudgetView` has no carry-over summary (last month's leftover, paybacks, fronted money, new income).    | When the viewed month is the current one, today is the 1st and nothing is assigned yet, Budget shows "December has started" with Ready to Assign, and a Fill targets button built from `AssignView` target suggestions. |
| Owed to you · Paid back recently             | `OwedView` lists owed items, not the inflows that paid them back.                                       | Lists items with `matched > 0` and the amount matched.                                                                                                                                                                  |
| Upcoming rows                                | `TxnListRow` has no repeat interval ("monthly").                                                        | Shown only if the server puts it in `categoryLabel`.                                                                                                                                                                    |
| Match money back · "something I didn't mark" | `MatchView.open` has only items already marked owed; no recent unmarked purchases.                      | Shows a hint to mark the purchase as owed first.                                                                                                                                                                        |

## Missing actions

| Screen                                                      | Gap                                                                                                 | Workaround                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Check these · "Cleared $4.10 higher"                        | No action to accept a changed amount.                                                               | OK calls `POST /api/transactions/:key/pending` with `keep_waiting`. No Undo.                   |
| Check not cleared · Fix the amount or date                  | `TxnPatch` can't change a manual entry's amount or date.                                            | The amount is sent as `estimatedAmount`; the date field is left out.                           |
| Card refund · Not this purchase                             | Nothing makes a `refund_of` link outside the test data (D-80), so there is nothing to unlink.       | No control is shown.                                                                           |
| Transfer pick · Undo                                        | No action that returns a picked transfer to "unsorted".                                             | Undo calls `POST /api/transfers/:key/unpair`.                                                  |
| Transaction · It's a transfer to an unlinked account (D-20) | `TxnPatch` has no transfer target.                                                                  | "Transfer to account…" options are listed but disabled.                                        |
| Settings · stop tracking                                    | The design offers to delete the stored log when tracking is turned off; there's no delete endpoint. | Shows that collection stopped and that raw events age out after 90 days.                       |
| Repair                                                      | `LinkExchange` is for new Items; Plaid update mode returns no new public token to exchange.         | After Link succeeds in repair mode the app calls `POST /api/settings/connections/:id/refresh`. |

## Assumptions

- The Worker reports the daily limit with error code `read_only` (or `readonly`). The app then refetches
  `GET /api/session` and shows the banner with `readOnlyUntil` in Pacific time. `writeState: 'paused'` (70%) is
  treated as writable.
- A Needs attention item in section `Ready to Assign` (negative Ready to Assign) has no category; the Budget
  screen shows a "Take it back from" list that calls `POST /api/budget/move` to `rta`.
- Mutations with no body (`unlink`, `unpair`, `refresh`, `apply`) send `{}` so they still carry
  `content-type: application/json`.
- Sign out calls `POST /api/settings/security/sign-out` (passkeys, D-27).
