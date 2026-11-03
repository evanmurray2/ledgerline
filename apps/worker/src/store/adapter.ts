// A Durable Object's own SQLite as the app's database (packages/db/src/sql.ts). batch() is one transactionSync(), so
// a statement that throws (the lease_guard CHECK fence) rolls the whole batch back. Statements run on the object's
// thread, so their CPU counts toward the 10 ms per request (docs/measurements.md).
import { SqliteDb, isWrite, type Result, type SqlValue } from '@ledgerline/db/sql';

export class DurableDb extends SqliteDb {
  constructor(private readonly storage: DurableObjectStorage) {
    super();
  }

  protected execute(sql: string, params: readonly SqlValue[]): Result<Record<string, unknown>> {
    const c = this.storage.sql.exec(sql, ...params);
    const results = c.toArray() as Record<string, unknown>[];
    const changes = isWrite(sql)
      ? Number((this.storage.sql.exec('SELECT changes() AS c').one() as { c: number }).c)
      : 0;
    return { results, changes, rowsRead: c.rowsRead, rowsWritten: c.rowsWritten };
  }

  protected transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  /** Runs SQL text with no bindings (migrations), split by splitStatements(), in one transaction. */
  exec(sql: string): void {
    const parts = splitStatements(sql);
    this.storage.transactionSync(() => {
      for (const part of parts) this.storage.sql.exec(part);
    });
  }
}

/**
 * Splits migration SQL into statements on `;` at the end of a statement, keeping trigger bodies
 * (`BEGIN … END;`) whole and ignoring `;` inside quotes and comments.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let i = 0;
  const word = (w: string) =>
    sql.slice(i, i + w.length).toUpperCase() === w &&
    !/[A-Za-z0-9_]/.test(sql[i - 1] ?? ' ') &&
    !/[A-Za-z0-9_]/.test(sql[i + w.length] ?? ' ');
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
      cur += '\n';
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === ch && sql[j + 1] !== ch)) j += sql[j] === ch ? 2 : 1;
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (word('BEGIN')) depth++;
    else if (word('END') && depth > 0) depth--;
    if (ch === ';' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
