// A D1Database-shaped adapter over a Durable Object's SQLite (docs/multi-user.md 5.5). Code written for D1 runs
// unchanged inside a Durable Object: prepare/bind/first/all/run/raw and batch(), with D1's meta fields and error
// wording. batch() is one transactionSync(), so a statement that throws (the lease_guard CHECK fence) rolls the whole
// batch back, as in D1. Limits match D1's so code that fits one fits the other.

type Value = string | number | null | ArrayBuffer;

export interface AdapterStats {
  statements: number;
  rowsRead: number;
  rowsWritten: number;
}

const MAX_PARAMS = 100;
const MAX_SQL = 100_000;

function toValue(v: unknown): Value {
  if (v === undefined) throw new Error('D1_TYPE_ERROR: Type undefined is not supported for value undefined');
  if (v === null || typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  throw new Error(`D1_TYPE_ERROR: Type ${typeof v} is not supported`);
}

function d1Error(e: unknown): Error {
  const m = e instanceof Error ? e.message : String(e);
  return new Error(m.startsWith('D1_') ? m : `D1_ERROR: ${m}`);
}

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;
const WITH_WRITE = /^\s*WITH\b[\s\S]*\b(INSERT|UPDATE|DELETE)\b/i;

export class SqlStatement {
  constructor(
    private readonly db: SqlD1,
    readonly sql: string,
    readonly params: Value[] = [],
  ) {}

  bind(...values: unknown[]): SqlStatement {
    if (values.length > MAX_PARAMS) throw new Error('D1_ERROR: too many SQL variables');
    return new SqlStatement(this.db, this.sql, values.map(toValue));
  }

  /** Runs now, synchronously; batch() calls this inside one transaction. */
  runSync(): D1Result<Record<string, unknown>> {
    return this.db.execOne(this.sql, this.params);
  }

  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = this.runSync().results[0];
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.runSync() as unknown as D1Result<T>;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.runSync() as unknown as D1Result<T>;
  }

  async raw<T = unknown[]>(opts?: { columnNames?: boolean }): Promise<T[]> {
    const r = this.runSync();
    const cols = r.results[0] ? Object.keys(r.results[0]) : [];
    const rows = r.results.map((x) => cols.map((c) => x[c])) as T[];
    return opts?.columnNames ? [cols as T, ...rows] : rows;
  }
}

export class SqlD1 {
  readonly stats: AdapterStats = { statements: 0, rowsRead: 0, rowsWritten: 0 };
  /** Set while a move or restore freezes this object (docs/multi-user.md 8.6): every write throws. */
  frozen = false;

  constructor(private readonly storage: DurableObjectStorage) {}

  prepare(sql: string): SqlStatement {
    if (sql.length > MAX_SQL) throw new Error('D1_ERROR: statement too long');
    return new SqlStatement(this, sql);
  }

  async batch<T = Record<string, unknown>>(stmts: SqlStatement[]): Promise<D1Result<T>[]> {
    if (stmts.length === 0) return [];
    try {
      return this.storage.transactionSync(() => stmts.map((s) => s.runSync())) as unknown as D1Result<T>[];
    } catch (e) {
      throw d1Error(e);
    }
  }

  /** Runs SQL text with no bindings (migrations). Statements are split by splitStatements(). */
  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const parts = splitStatements(sql);
    this.storage.transactionSync(() => {
      for (const p of parts) this.storage.sql.exec(p);
    });
    return { count: parts.length, duration: 0 };
  }

  execOne(sql: string, params: Value[]): D1Result<Record<string, unknown>> {
    const isWrite = WRITE.test(sql) || WITH_WRITE.test(sql);
    if (this.frozen && isWrite) throw new Error('D1_ERROR: frozen');
    let rows: Record<string, unknown>[];
    let read: number;
    let written: number;
    try {
      const c = this.storage.sql.exec(sql, ...params);
      rows = c.toArray() as Record<string, unknown>[];
      read = c.rowsRead;
      written = c.rowsWritten;
    } catch (e) {
      throw d1Error(e);
    }
    let changes = 0;
    let lastRowId = 0;
    if (isWrite) {
      const m = this.storage.sql.exec('SELECT changes() AS c, last_insert_rowid() AS r').one() as {
        c: number;
        r: number;
      };
      changes = Number(m.c);
      lastRowId = Number(m.r);
    }
    this.stats.statements++;
    this.stats.rowsRead += read;
    this.stats.rowsWritten += written;
    return {
      results: rows,
      success: true,
      meta: {
        changes,
        last_row_id: lastRowId,
        rows_read: read,
        rows_written: written,
        duration: 0,
        changed_db: written > 0,
        size_after: 0,
      },
    } as unknown as D1Result<Record<string, unknown>>;
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
