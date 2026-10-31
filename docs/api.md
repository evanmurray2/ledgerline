# API

The Worker serves the SPA and a JSON API under `/api`. Every request must pass Cloudflare Access; the Worker also verifies the Access JWT itself. Mutations (`POST`, `PUT`, `PATCH`, `DELETE`) require `content-type: application/json`, the header `x-ledgerline: 1` and a same-origin `Origin`. Schemas and types are in `packages/contracts`. Money is integer cents; months are `YYYY-MM`.

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /api/session` | | `Session` |
| `GET /api/budget/:month` | | `BudgetView` |
| `POST /api/budget/assign` | `AssignRequest` (adds to each category) | `MutationResult` |
| `POST /api/budget/set` | `SetAssignedRequest` (sets one category's assigned) | `MutationResult` |
| `POST /api/budget/move` | `MoveRequest` | `MutationResult` |
| `GET /api/budget/:month/assign` | | `AssignView` (suggestions for the Assign sheet) |
| `GET /api/categories/:id/sheet?month=` | | `CategorySheet` |
| `PUT /api/categories/:id/target` | `TargetRequest` | `MutationResult` |
| `GET /api/activity?filter=all\|attention\|pending&q=&cursor=` | | `ActivityView` |
| `GET /api/transactions/:key` | | `TxnSheet` |
| `PATCH /api/transactions/:key` | `TxnPatch` | `MutationResult` |
| `POST /api/transactions/categorize` | `CategorizeRequest` | `MutationResult` |
| `POST /api/transactions` | `NewTxnRequest` (expected / upcoming) | `MutationResult` |
| `POST /api/transactions/:key/pending` | `PendingCheckAction` | `MutationResult` |
| `DELETE /api/transactions/:key` | (manual rows only) | `MutationResult` |
| `GET /api/match/:inflowKey` | | `MatchView` |
| `POST /api/match` | `MatchRequest` | `MutationResult` |
| `POST /api/match/:inflowKey/unlink` | | `MutationResult` |
| `POST /api/transfers/:key/pick` | `TransferPick` | `MutationResult` |
| `POST /api/transfers/:key/unpair` | | `MutationResult` |
| `GET /api/owed` | | `OwedView` |
| `POST /api/owed/:id` | `OwedAction` | `MutationResult` |
| `GET /api/accounts` | | `AccountsView` |
| `GET /api/accounts/:id/register?show=all\|pending\|needs\|transfers` | | `RegisterView` |
| `GET /api/reports?month=` | | `ReportsView` |
| `GET /api/settings/categories` | | `CategoriesView` |
| `POST /api/settings/categories` | `CategoryUpsert` | `{ ok, id }` |
| `POST /api/settings/groups` | `GroupUpsert` | `{ ok, id }` |
| `POST /api/settings/categories/:id/archive` | `ArchiveRequest` | `MutationResult` |
| `POST /api/settings/categories/reorder` | `ReorderRequest` | `{ ok }` |
| `GET /api/settings/rules` | | `RulesView` |
| `POST /api/settings/rules` | `RuleBody` | `{ ok, id }` |
| `POST /api/settings/rules/preview` | `RuleBody` | `RulePreview` |
| `POST /api/settings/rules/:id/apply` | | `MutationResult` (applies to uncategorized history) |
| `DELETE /api/settings/rules/:id` | | `{ ok }` |
| `GET /api/settings/rules/export` | | rules JSON |
| `GET /api/settings/payees` | | `PayeesView` |
| `POST /api/settings/payees/merge` | `MergePayees` | `{ ok }` |
| `POST /api/settings/payees/:id` | `RenamePayee` | `{ ok }` |
| `GET /api/settings/connections` | | `ConnectionsView` |
| `POST /api/settings/connections/link-token` | `LinkTokenRequest` | `{ linkToken }` |
| `POST /api/settings/connections/exchange` | `LinkExchange` | `{ ok, connectionId, accounts }` |
| `POST /api/settings/connections/:id/refresh` | | `{ ok }` (Refresh: syncs now) |
| `POST /api/setup/start` | `SetupStart` | `{ ok }` |
| `POST /api/setup/starting-balances` | `StartingBalances` | `MutationResult` |
| `PATCH /api/settings` | `SettingsPatch` | `{ ok }` |
| `POST /api/import/csv` | `ImportCsvRequest` | `ImportResult` |
| `GET /api/export/json` · `GET /api/export/csv` · `GET /api/export/usage` | | file download |
| `POST /api/usage` | `UsageBatch` | `204` |
| `POST /api/notes` | `NoteRequest` | `{ ok }` |
| `GET /api/health` | (Access service token) | `HealthView` |
| `POST /api/webhooks/plaid` | Plaid webhook (Access bypass; signature required) | `200` |
