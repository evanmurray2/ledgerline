# Contract notes (web)

Gaps found while building the SPA against `packages/contracts` and `docs/api.md`. Each one is worked around in
the UI; none of them edits the contract.

## Blocking: `RuleCondition` can't parse

`RuleCondition` is `z.discriminatedUnion('field', …)` with two members whose discriminator is `'amount'`
(`equals` and `between`). Zod 4 throws `Duplicate discriminator value "amount"` the first time it parses
anything, so `RuleBody`, `RulesView` and anything built on them throw. This also affects the Worker: validating
`POST /api/settings/rules` and `POST /api/settings/rules/preview` with `RuleBody` will throw (500), not 400.

Suggested fix: make `RuleCondition` a plain `z.union`, or merge the two amount shapes into one member with
`op: z.enum(['equals', 'between'])`.

Workaround: `src/api/lenient.ts` restates the shapes with `z.union` and is used for `GET /api/settings/rules`
(and by the mock to validate rule bodies).

## Missing data

| Screen                                       | Gap                                                                                                                                                                                             | Workaround                                                                                                                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transfer: pick the other side                | No list of candidate deposits for an unclear transfer (`TxnSheet` and `ActivityView` don't carry them).                                                                                         | The sheet loads the other accounts' registers and offers deposits of the opposite amount within 5 days. `TransferPick.otherKey` is that row's key. A `candidates` array on `TxnSheet` would be cheaper.                 |
| Assign sheet                                 | `AssignSuggestion` has no "selected by default" flag; the prototype pre-ticks Overspent and Underfunded but not Low or Overfunded, and `reason` only distinguishes `cover` / `target` / `card`. | Pre-ticks `cover`, `card`, and `target` items whose `detail` starts with "Underfunded". A `preselected: boolean` would remove the text match.                                                                           |
| New month starts                             | `BudgetView` has no carry-over summary (last month's leftover, paybacks, fronted money, new income).                                                                                            | When the viewed month is the current one, today is the 1st and nothing is assigned yet, Budget shows "December has started" with Ready to Assign, and a Fill targets button built from `AssignView` target suggestions. |
| Owed to you · Paid back recently             | `OwedView` lists owed items, not the inflows that paid them back.                                                                                                                               | Lists items with `matched > 0` and the amount matched.                                                                                                                                                                  |
| Upcoming rows                                | `TxnListRow` has no repeat interval ("monthly").                                                                                                                                                | Shown only if the server puts it in `categoryLabel`.                                                                                                                                                                    |
| Card register chips                          | `RegisterView` has no per-filter counts (Pending 3, Needs category 2, Transfers 3).                                                                                                             | Counts come from the `show=all` response; the filtered list uses `show=`.                                                                                                                                               |
| Category sheet · Move money                  | `moveOptions` has labels only, so the amount can't be prefilled with what the other category needs.                                                                                             | Amount starts empty.                                                                                                                                                                                                    |
| Match money back · "something I didn't mark" | `MatchView.open` has only items already marked owed; no recent unmarked purchases.                                                                                                              | Shows a hint to mark the purchase as owed first.                                                                                                                                                                        |

## Missing actions

| Screen                                                      | Gap                                                                                                           | Workaround                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Close out (Owed to you)                                     | `OwedAction` has `close`, `cancel`, `snooze` but no reopen, so Close out and Remove the mark can't be undone. | Undo is offered only after "Give it more time" (snooze back to the old date).                  |
| Check these · "Cleared $4.10 higher"                        | No action to accept a changed amount.                                                                         | OK calls `POST /api/transactions/:key/pending` with `keep_waiting`. No Undo.                   |
| Check not cleared · Fix the amount or date                  | `TxnPatch` can't change a manual entry's amount or date.                                                      | The amount is sent as `estimatedAmount`; the date field is left out.                           |
| Card refund · Not this purchase                             | `TxnPatch` has no way to unlink a refund from its purchase (`refundOf`).                                      | The toggle is local only until saved; nothing is sent.                                         |
| Transfer pick · Undo                                        | No action that returns a picked transfer to "unsorted".                                                       | Undo calls `POST /api/transfers/:key/unpair`.                                                  |
| Transaction · It's a transfer to an unlinked account (D-20) | `TxnPatch` has no transfer target.                                                                            | "Transfer to account…" options are listed but disabled.                                        |
| Edit rule · Rename payee to                                 | `set_payee` needs a `payeeId`, and there's no endpoint that creates a payee.                                  | Field left out.                                                                                |
| Settings · stop tracking                                    | The design offers to delete the stored log when tracking is turned off; there's no delete endpoint.           | Shows that collection stopped and that raw events age out after 90 days.                       |
| Repair                                                      | `LinkExchange` is for new Items; Plaid update mode returns no new public token to exchange.                   | After Link succeeds in repair mode the app calls `POST /api/settings/connections/:id/refresh`. |

## Assumptions

- The Worker reports the daily limit with error code `read_only` (or `readonly`). The app then refetches
  `GET /api/session` and shows the banner with `readOnlyUntil` in Pacific time. `writeState: 'paused'` (70%) is
  treated as writable.
- A Needs attention item in section `Ready to Assign` (negative Ready to Assign) has no category; the Budget
  screen shows a "Take it back from" list that calls `POST /api/budget/move` to `rta`.
- Mutations with no body (`unlink`, `unpair`, `refresh`, `apply`) send `{}` so they still carry
  `content-type: application/json`.
- Sign out links to `/cdn-cgi/access/logout` (Cloudflare Access).
