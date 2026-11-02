// Serving during the move (docs/multi-user.md 8.2). While move_state is 'frozen' (copying) or 'restoring' (the way
// back), D1 refuses every write (migration 0012). Screens keep working read-only: their own cache writes (recompute
// summaries, month totals, the monitor stamp) are skipped and stored values are shown. Edits and sign-ins get a
// "moving" answer the web app shows as a banner; Plaid webhooks wait in move_queue for the new databases.
import type { Env } from '../env.js';

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;
const WITH_WRITE = /^\s*WITH\b[\s\S]*\b(INSERT|UPDATE|DELETE)\b/i;
const isWrite = (sql: string) => WRITE.test(sql) || WITH_WRITE.test(sql);

const skipped = () =>
  ({
    results: [],
    success: true,
    meta: {
      changes: 0,
      last_row_id: 0,
      rows_read: 0,
      rows_written: 0,
      duration: 0,
      changed_db: false,
      size_after: 0,
    },
  }) as unknown as D1Result;

interface Wrapped {
  __inner: D1PreparedStatement;
  __sql: string;
}

function wrap(inner: D1PreparedStatement, sql: string): D1PreparedStatement {
  const w = {
    __inner: inner,
    __sql: sql,
    bind: (...v: unknown[]) => wrap(inner.bind(...v), sql),
    first: (col?: string) =>
      isWrite(sql) ? Promise.resolve(null) : (inner.first as (c?: string) => Promise<unknown>)(col),
    all: () => (isWrite(sql) ? Promise.resolve(skipped()) : inner.all()),
    run: () => (isWrite(sql) ? Promise.resolve(skipped()) : inner.run()),
    raw: (o?: { columnNames?: boolean }) => (isWrite(sql) ? Promise.resolve([]) : inner.raw(o as never)),
  };
  return w as unknown as D1PreparedStatement;
}

/** D1 with every write skipped: for screens served while D1 is frozen. */
export function readOnlyD1(db: D1Database): D1Database {
  return new Proxy(db, {
    get(t, k) {
      if (k === 'prepare') return (sql: string) => wrap(t.prepare(sql), sql);
      if (k === 'batch')
        return async (stmts: D1PreparedStatement[]) => {
          const ws = stmts as unknown as Wrapped[];
          const reads = ws.filter((s) => !isWrite(s.__sql)).map((s) => s.__inner);
          const res = reads.length ? await t.batch(reads) : [];
          let i = 0;
          return ws.map((s) => (isWrite(s.__sql) ? skipped() : res[i++]!));
        };
      const v = Reflect.get(t, k) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

export const MOVING = { error: 'moving', message: 'Moving your data. Try again in a few minutes.' } as const;

/** A Plaid webhook that arrives during the freeze, kept for the new databases to replay after the switch. */
export async function queueWebhook(env: Env, itemId: string, type: string, now: number): Promise<void> {
  await env.DB.prepare(`INSERT INTO move_queue (kind, payload, created_at) VALUES ('webhook', ?1, ?2)`)
    .bind(JSON.stringify({ itemId, type }), now)
    .run();
}
