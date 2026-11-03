// sql.js (SQLite compiled to WebAssembly) as the app's database (packages/db/src/sql.ts), so the phone's engine runs
// the server's own SQL unchanged (docs/phone-budget.md, D-45). batch() is one transaction, as on the server.
import type { Database } from 'sql.js';
import { SqliteDb, isWrite, type Result, type SqlValue } from '@ledgerline/db/sql';

export class SqlJsDb extends SqliteDb {
  constructor(readonly db: Database) {
    super();
  }

  protected execute(sql: string, params: readonly SqlValue[]): Result<Record<string, unknown>> {
    const st = this.db.prepare(sql);
    try {
      if (params.length)
        st.bind(params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p)) as never);
      const results: Record<string, unknown>[] = [];
      while (st.step()) results.push(st.getAsObject() as Record<string, unknown>);
      const changes = isWrite(sql) ? this.db.getRowsModified() : 0;
      return { results, changes, rowsRead: results.length, rowsWritten: changes };
    } finally {
      st.free();
    }
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
