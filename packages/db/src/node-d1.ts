// A D1Database-compatible adapter over node:sqlite, for fast tests of the SQL itself (fences, triggers, migrations)
// and for the CPU harness. It reproduces the D1 client's own work (JSON-serializing every statement and parameter
// and parsing the results) and measures the SQLite execution separately, because in production that execution
// happens inside D1, not in the Worker's CPU time.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { cpuUsage } from 'node:process';

export interface NodeD1Stats {
  queries: number;
  statements: number;
  changes: number;
  rowsRead: number;
  /** CPU spent inside SQLite (excluded from Worker CPU estimates). */
  sqliteMicros: number;
  /** Of that, executing statements and building result rows (what in-process SQLite would add to CPU). */
  execMicros: number;
}

type Value = string | number | null | bigint | Uint8Array;

function toValue(v: unknown): Value {
  if (v === undefined) throw new TypeError('D1_TYPE_ERROR: undefined is not a supported bind value');
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new TypeError(`D1_TYPE_ERROR: unsupported bind value ${typeof v}`);
}

function micros(): number {
  const u = cpuUsage();
  return u.user + u.system;
}

export class NodeD1Statement {
  constructor(
    private readonly owner: NodeD1,
    readonly sql: string,
    readonly params: Value[] = [],
  ) {}

  bind(...values: unknown[]): NodeD1Statement {
    return new NodeD1Statement(this.owner, this.sql, values.map(toValue));
  }

  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const r = await this.owner.batchInternal([this], false);
    const row = r[0]!.results[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: Meta }> {
    const r = await this.owner.batchInternal([this], false);
    return r[0] as { results: T[]; success: true; meta: Meta };
  }

  async run(): Promise<{ results: unknown[]; success: true; meta: Meta }> {
    const r = await this.owner.batchInternal([this], false);
    return r[0] as { results: unknown[]; success: true; meta: Meta };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const r = await this.owner.batchInternal([this], false);
    return r[0]!.results.map((row) => Object.values(row as object)) as T[];
  }
}

interface Meta {
  changes: number;
  last_row_id: number;
  rows_read: number;
  rows_written: number;
  duration: number;
  changed_db: boolean;
  size_after: number;
}

export class NodeD1 {
  readonly db: DatabaseSync;
  readonly stats: NodeD1Stats = {
    queries: 0,
    statements: 0,
    changes: 0,
    rowsRead: 0,
    sqliteMicros: 0,
    execMicros: 0,
  };
  private cache = new Map<string, StatementSync>();

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = OFF;');
  }

  prepare(sql: string): NodeD1Statement {
    return new NodeD1Statement(this, sql);
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.db.exec(sql);
    return { count: 1, duration: 0 };
  }

  async batch(stmts: NodeD1Statement[]): Promise<{ results: unknown[]; success: true; meta: Meta }[]> {
    return this.batchInternal(stmts, true);
  }

  /** When set, SQLite time per distinct statement is added here (measurement only). */
  bySql: Map<string, { micros: number; calls: number }> | null = null;

  resetStats(): void {
    Object.assign(this.stats, {
      queries: 0,
      statements: 0,
      changes: 0,
      rowsRead: 0,
      sqliteMicros: 0,
      execMicros: 0,
    });
  }

  /** One D1 call: serialize like the D1 client, run in a transaction, serialize results back. */
  async batchInternal(
    stmts: NodeD1Statement[],
    _isBatch: boolean,
  ): Promise<{ results: unknown[]; success: true; meta: Meta }[]> {
    // Client-side work that does count in production: the request body.
    const body = JSON.stringify({
      statements: stmts.map((s) => ({
        sql: s.sql,
        params: s.params.map((p) => (typeof p === 'bigint' ? Number(p) : p)),
      })),
    });
    if (body.length < 0) throw new Error('unreachable');
    this.stats.queries++;
    this.stats.statements += stmts.length;
    const t0 = micros();
    const out: { results: unknown[]; success: true; meta: Meta }[] = [];
    const tx = stmts.length > 1;
    try {
      if (tx) this.db.exec('BEGIN');
      for (const s of stmts) {
        const ts = this.bySql ? micros() : 0;
        let st = this.cache.get(s.sql);
        if (!st) {
          st = this.db.prepare(s.sql);
          this.cache.set(s.sql, st);
        }
        const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(s.sql) || /\bRETURNING\b/i.test(s.sql);
        if (isRead) {
          const rows = st.all(...s.params) as Record<string, unknown>[];
          this.stats.rowsRead += rows.length;
          out.push({ results: rows, success: true, meta: meta(0, 0, rows.length) });
        } else {
          const r = st.run(...s.params);
          const changes = Number(r.changes);
          this.stats.changes += changes;
          out.push({ results: [], success: true, meta: meta(changes, Number(r.lastInsertRowid), 0) });
        }
        if (this.bySql) {
          const k = s.sql.replace(/\s+/g, ' ').trim();
          const e = this.bySql.get(k) ?? { micros: 0, calls: 0 };
          e.micros += micros() - ts;
          e.calls++;
          this.bySql.set(k, e);
        }
      }
      if (tx) this.db.exec('COMMIT');
    } catch (e) {
      if (tx) this.db.exec('ROLLBACK');
      this.stats.sqliteMicros += micros() - t0;
      this.stats.execMicros += micros() - t0;
      throw new Error(`D1_ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.stats.execMicros += micros() - t0;
    // Serializing the response happens in D1, so it is excluded; parsing it is client work and counts.
    const text = JSON.stringify(out);
    this.stats.sqliteMicros += micros() - t0;
    return JSON.parse(text) as typeof out;
  }
}

function meta(changes: number, lastRowId: number, rowsRead: number): Meta {
  return {
    changes,
    last_row_id: lastRowId,
    rows_read: rowsRead,
    rows_written: changes,
    duration: 0,
    changed_db: changes > 0,
    size_after: 0,
  };
}

/** Applies every migration file in order. */
export function applyMigrations(d: NodeD1, files: { name: string; sql: string }[]): void {
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) d.db.exec(f.sql);
}
