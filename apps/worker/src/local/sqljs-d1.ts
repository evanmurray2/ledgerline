// A D1Database-shaped handle on sql.js (SQLite compiled to WebAssembly), so the phone's engine runs the server's own
// SQL unchanged (docs/phone-budget.md, D-44). Like store/adapter.ts, batch() is one transaction: a statement that
// throws rolls the whole batch back. There's no 10 ms limit on the phone, so D1's statement limits aren't copied.
import type { Database, SqlValue } from 'sql.js';

type Row = Record<string, unknown>;

function toValue(v: unknown): SqlValue {
  if (v === undefined) throw new Error('D1_TYPE_ERROR: Type undefined is not supported for value undefined');
  if (v === null || typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new Error(`D1_TYPE_ERROR: Type ${typeof v} is not supported`);
}

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;

function result<T>(rows: T[], changes: number): D1Result<T> {
  return {
    results: rows,
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: rows.length,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes,
    },
  } as unknown as D1Result<T>;
}

export class SqlJsStatement {
  constructor(
    private readonly d: SqlJsD1,
    readonly sql: string,
    readonly params: SqlValue[] = [],
  ) {}

  bind(...values: unknown[]): SqlJsStatement {
    return new SqlJsStatement(this.d, this.sql, values.map(toValue));
  }

  runSync(): D1Result<Row> {
    return this.d.execOne(this.sql, this.params);
  }

  async first<T = Row>(col?: string): Promise<T | null> {
    const row = this.runSync().results[0];
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }

  async all<T = Row>(): Promise<D1Result<T>> {
    return this.runSync() as unknown as D1Result<T>;
  }

  async run<T = Row>(): Promise<D1Result<T>> {
    return this.runSync() as unknown as D1Result<T>;
  }

  async raw<T = unknown[]>(opts?: { columnNames?: boolean }): Promise<T[]> {
    const r = this.runSync();
    const cols = r.results[0] ? Object.keys(r.results[0]) : [];
    const rows = r.results.map((x) => cols.map((c) => x[c])) as T[];
    return opts?.columnNames ? [cols as T, ...rows] : rows;
  }
}

export class SqlJsD1 {
  constructor(readonly db: Database) {}

  prepare(sql: string): SqlJsStatement {
    return new SqlJsStatement(this, sql);
  }

  execOne(sql: string, params: SqlValue[]): D1Result<Row> {
    const st = this.db.prepare(sql);
    try {
      if (params.length) st.bind(params);
      const rows: Row[] = [];
      while (st.step()) rows.push(st.getAsObject() as Row);
      return result(rows, WRITE.test(sql) ? this.db.getRowsModified() : 0);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      throw new Error(m.startsWith('D1_') ? m : `D1_ERROR: ${m}`);
    } finally {
      st.free();
    }
  }

  async batch<T = Row>(stmts: SqlJsStatement[]): Promise<D1Result<T>[]> {
    this.db.exec('BEGIN');
    try {
      const out = stmts.map((s) => s.runSync()) as unknown as D1Result<T>[];
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.db.exec(sql);
    return { count: 1, duration: 0 };
  }
}
