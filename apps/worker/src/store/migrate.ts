// Schema migrations inside a Durable Object (docs/multi-user.md 5.7). Runs at object start, before any request
// (the caller wraps it in blockConcurrencyWhile). Each migration is applied in its own transactionSync together
// with its record in _migrations, so a failure leaves no half-applied migration and running twice does nothing.
// A failing migration throws: the object then refuses requests with that error rather than serving a half-migrated
// schema, and the deploy smoke test (health()) fails before anyone else is affected.
import { splitStatements } from './adapter.js';
import type { StoreMigration } from './migrations.gen.js';

export interface MigrationResult {
  applied: string[];
  total: number;
}

export function migrate(
  storage: DurableObjectStorage,
  migrations: StoreMigration[],
  now: number,
): MigrationResult {
  const sql = storage.sql;
  sql.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const done = new Set(
    sql
      .exec(`SELECT name FROM _migrations`)
      .toArray()
      .map((r) => String(r.name)),
  );
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    const parts = splitStatements(m.sql);
    storage.transactionSync(() => {
      for (const p of parts) sql.exec(p);
      sql.exec(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`, m.name, now);
    });
    applied.push(m.name);
  }
  return { applied, total: migrations.length };
}

export function appliedMigrations(storage: DurableObjectStorage): string[] {
  return storage.sql
    .exec(`SELECT name FROM _migrations ORDER BY name`)
    .toArray()
    .map((r) => String(r.name));
}
