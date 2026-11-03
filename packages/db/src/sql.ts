// The one database interface the app's SQL goes through. It is SQLite in three places: a budget's or the
// Directory's Durable Object on the server (apps/worker/src/store/adapter.ts), sql.js in the phone's engine
// (apps/worker/src/local/sqljs-db.ts) and node:sqlite for measuring (node-db.ts). Each only says how to run one
// statement and how to run a transaction; statements, binding and batches are shared here.
//
// A statement is prepared, bound (?1, ?2, …) and then read with first(), all() or run(); batch() runs several in one
// transaction, so a statement that throws (the lease_guard CHECK fence) rolls the whole batch back. The calls are
// async because the app's code awaits them, though every SQLite here answers at once.

export type SqlValue = string | number | null | Uint8Array | ArrayBuffer;
export type Row = Record<string, unknown>;

export interface Result<T = unknown> {
  results: T[];
  /** Rows the statement inserted, updated or deleted (SQLite's changes()); 0 for a read. */
  changes: number;
  rowsRead: number;
  /** Rows written, counting index and trigger writes, as the platform bills them. */
  rowsWritten: number;
}

export interface Stmt {
  readonly sql: string;
  readonly params: readonly SqlValue[];
  bind(...values: unknown[]): Stmt;
  /** The first row, or one column of it; null when there is none. */
  first<T = Row>(col?: string): Promise<T | null>;
  all<T = Row>(): Promise<Result<T>>;
  run<T = Row>(): Promise<Result<T>>;
}

export interface Db {
  prepare(sql: string): Stmt;
  /** Runs every statement in one transaction and returns each one's result, in order. */
  batch<T = unknown>(stmts: Stmt[]): Promise<Result<T>[]>;
}

export interface DbStats {
  /** Calls the app made: a statement on its own or a batch. */
  queries: number;
  statements: number;
  rowsRead: number;
  rowsWritten: number;
}

/** Turns a JavaScript value into what SQLite stores (booleans are 0 or 1). */
export function toValue(v: unknown): SqlValue {
  if (v === undefined) throw new TypeError('undefined can’t be bound to a SQL parameter');
  if (v === null || typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError(`a ${typeof v} can’t be bound to a SQL parameter`);
}

/** Whether a statement changes rows, so its result needs SQLite's changes(). */
export function isWrite(sql: string): boolean {
  return (
    /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql) ||
    /^\s*WITH\b[\s\S]*\b(INSERT|UPDATE|DELETE)\b/i.test(sql)
  );
}

/** A SQLite database: the subclass runs one statement and wraps a transaction; everything else is shared. */
export abstract class SqliteDb implements Db {
  readonly stats: DbStats = { queries: 0, statements: 0, rowsRead: 0, rowsWritten: 0 };

  /** Runs one statement now. */
  protected abstract execute(sql: string, params: readonly SqlValue[]): Result<Row>;
  /** Runs fn() in one transaction: all of it or none of it. */
  protected abstract transaction<T>(fn: () => T): T;

  prepare(sql: string): Stmt {
    return new Statement(this, sql, []);
  }

  async batch<T = unknown>(stmts: Stmt[]): Promise<Result<T>[]> {
    if (stmts.length === 0) return [];
    this.stats.queries++;
    return this.transaction(() => stmts.map((s) => this.runOne(s))) as unknown as Result<T>[];
  }

  resetStats(): void {
    Object.assign(this.stats, { queries: 0, statements: 0, rowsRead: 0, rowsWritten: 0 });
  }

  /** @internal Runs one statement and counts it. */
  runOne(s: Stmt): Result<Row> {
    const r = this.execute(s.sql, s.params);
    this.stats.statements++;
    this.stats.rowsRead += r.rowsRead;
    this.stats.rowsWritten += r.rowsWritten;
    return r;
  }
}

class Statement implements Stmt {
  constructor(
    private readonly db: SqliteDb,
    readonly sql: string,
    readonly params: readonly SqlValue[],
  ) {}

  bind(...values: unknown[]): Stmt {
    return new Statement(this.db, this.sql, values.map(toValue));
  }

  private once(): Result<Row> {
    this.db.stats.queries++;
    return this.db.runOne(this);
  }

  async first<T = Row>(col?: string): Promise<T | null> {
    const row = this.once().results[0];
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }

  async all<T = Row>(): Promise<Result<T>> {
    return this.once() as unknown as Result<T>;
  }

  async run<T = Row>(): Promise<Result<T>> {
    return this.once() as unknown as Result<T>;
  }
}
