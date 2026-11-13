// D-105: a BudgetStore runs the budget migrations up to this one, then only its own (packages/db/store-migrations).
// Its old budget tables are dropped by store migration 0010; a later budget migration runs on the devices' copies
// only. Used by gen-store-migrations.mjs and tools/ci/migration-check.mjs.
export const STORE_LAST_BUDGET = '0012_release_waiting_to_match.sql';
