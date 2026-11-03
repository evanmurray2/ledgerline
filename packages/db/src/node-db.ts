// node:sqlite as the app's database (sql.ts), for measuring hot paths in Node (apps/worker/measure). In a Durable
// Object SQLite runs on the same thread as the app, so its time counts here too.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { SqliteDb, isWrite, type Result, type SqlValue } from './sql.js';

export class NodeDb extends SqliteDb {
  readonly db: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(path = ':memory:') {
    super();
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = OFF;');
  }

  protected execute(sql: string, params: readonly SqlValue[]): Result<Record<string, unknown>> {
    let st = this.cache.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.cache.set(sql, st);
    }
    const args = params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p));
    if (!isWrite(sql) || /\bRETURNING\b/i.test(sql)) {
      const results = st.all(...args) as Record<string, unknown>[];
      const changes = isWrite(sql) ? results.length : 0;
      return { results, changes, rowsRead: results.length, rowsWritten: changes };
    }
    const changes = Number(st.run(...args).changes);
    return { results: [], changes, rowsRead: 0, rowsWritten: changes };
  }

  protected transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** Applies every migration file in order. */
export function applyMigrations(d: NodeDb, files: { name: string; sql: string }[]): void {
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) d.db.exec(f.sql);
}
