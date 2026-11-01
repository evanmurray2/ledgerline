// D1 rows read per request. The free plan allows 5 million reads a day and every screen visit costs reads, so this
// test fails if a request grows past its budget. The data is shaped like a real first month: the November budget
// plus about 600 transactions of history before it, and two months of daily card statement snapshots.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';

let reads = 0;
const bySql = new Map<string, number>();
const sqlOf = new WeakMap<object, string>();

function tally(r: unknown, sql: string | undefined) {
  const n = (r as { meta?: { rows_read?: number } } | null)?.meta?.rows_read ?? 0;
  reads += n;
  const k = (sql ?? '?').replace(/\s+/g, ' ').slice(0, 160);
  bySql.set(k, (bySql.get(k) ?? 0) + n);
  return r;
}

function wrap(st: D1PreparedStatement, sql: string): D1PreparedStatement {
  const proxy: D1PreparedStatement = new Proxy(st, {
    get(t, k) {
      if (k === '__raw') return t;
      const v = Reflect.get(t, k) as unknown;
      if (k === 'bind')
        return (...a: unknown[]) => wrap((v as (...x: unknown[]) => D1PreparedStatement).apply(t, a), sql);
      if (k === 'all' || k === 'run')
        return async () => tally(await (v as () => Promise<unknown>).apply(t), sql);
      if (k === 'first')
        return async () => {
          const r = await t.all();
          tally(r, sql);
          return (r.results[0] ?? null) as never;
        };
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
  sqlOf.set(proxy, sql);
  return proxy;
}

const db = new Proxy(env.DB, {
  get(t, k) {
    const v = Reflect.get(t, k) as unknown;
    if (k === 'prepare') return (sql: string) => wrap(t.prepare(sql), sql);
    if (k === 'batch')
      return async (stmts: D1PreparedStatement[]) => {
        const r = await t.batch(
          stmts.map((x) => (x as unknown as { __raw?: D1PreparedStatement }).__raw ?? x),
        );
        r.forEach((x, i) => tally(x, sqlOf.get(stmts[i]!)));
        return r;
      };
    return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
  },
});

const call = async (p: string, method = 'GET', body: unknown = {}) => {
  reads = 0;
  const r = await worker.fetch(
    new Request('https://ledgerline.test' + p, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-ledgerline': '1' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    }),
    { ...env, DB: db } as never,
    createExecutionContext(),
  );
  await r.text();
  return { p, status: r.status, reads };
};

/** Copies of the seeded bank rows, dated 1–10 periods of 18 days before the budget start: history. */
async function addHistory() {
  const cols = (await env.DB.prepare(`PRAGMA table_info(bank_txn)`).all<{ name: string }>()).results.map(
    (c) => c.name,
  );
  for (let i = 1; i <= 10; i++) {
    const sel = cols
      .map((c) =>
        c === 'txn_key'
          ? `txn_key || '-h${i}'`
          : c === 'provider_txn_id'
            ? `provider_txn_id || '-h${i}'`
            : c === 'date' || c === 'authorized_date'
              ? `date('2026-11-01', '-${i * 18} days')`
              : c === 'pending'
                ? '0'
                : c,
      )
      .join(', ');
    await env.DB.prepare(
      `INSERT INTO bank_txn (${cols.join(', ')}) SELECT ${sel} FROM bank_txn WHERE txn_key NOT LIKE '%-h%'`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO txn_overlay (txn_key, budget_id, payee_id, category_id, created_at, updated_at)
       SELECT txn_key || '-h${i}', budget_id, payee_id, NULL, created_at, updated_at FROM txn_overlay
       WHERE txn_key NOT LIKE '%-h%' AND txn_key IN (SELECT txn_key FROM bank_txn)`,
    ).run();
  }
  // Two months of daily statement snapshots per card (one sync a day kept).
  for (let d = 1; d <= 60; d++)
    await env.DB.prepare(
      `INSERT INTO liability_snapshot (id, budget_id, provider_account_id, as_of, statement_balance, due_date, data, created_at)
       SELECT 'ls-' || provider_account_id || '-${d}', budget_id, provider_account_id, date('2026-11-14', '-${d} days'), 10000, '2026-12-01', '{}', ${d}
       FROM account WHERE kind = 'credit' AND provider_account_id IS NOT NULL`,
    ).run();
}

const SCREENS = [
  '/api/badges',
  '/api/session',
  '/api/budget/2026-11',
  '/api/activity?filter=attention',
  '/api/activity',
  '/api/accounts',
  '/api/owed',
  '/api/reports?month=2026-11',
  '/api/settings/categories',
];

describe('database reads per request', () => {
  it('stay within budget with six months of history', async () => {
    await call('/__dev/seed-november', 'POST');
    await addHistory();
    const n = await env.DB.prepare(`SELECT count(*) AS b FROM bank_txn`).first<{ b: number }>();
    expect(n!.b).toBeGreaterThan(550);

    const out = [];
    for (const p of SCREENS) out.push(await call(p));
    const t = await env.DB.prepare(
      `SELECT key FROM v_transaction WHERE category_id IS NULL AND date >= budget_from AND status = 'posted' LIMIT 1`,
    ).first<{ key: string }>();
    const cat = await env.DB.prepare(
      `SELECT id, name, group_id FROM category WHERE kind = 'spending' LIMIT 1`,
    ).first<{ id: string; name: string; group_id: string }>();
    // Accounts and Reports again: finished months' totals are stored now (ledger/totals.ts).
    out.push({ ...(await call('/api/accounts')), p: 'accounts again' });
    out.push({ ...(await call('/api/reports?month=2026-11')), p: 'reports again' });
    out.push(await call('/api/transactions/categorize', 'POST', { keys: [t!.key], categoryId: cat!.id }));
    out.push(
      await call('/api/budget/assign', 'POST', {
        month: '2026-11',
        items: [{ categoryId: cat!.id, amount: 1000 }],
      }),
    );
    const reads = Object.fromEntries(out.map((o) => [o.p, o.reads]));
    for (const o of out) expect(o.status, o.p).toBe(200);

    // The Activity list reads in date windows; paging through it still returns every posted row once, in order.
    const all = (
      await env.DB.prepare(
        `SELECT key FROM v_transaction WHERE status = 'posted' ORDER BY date DESC, seq DESC`,
      ).all<{ key: string }>()
    ).results.map((r) => r.key);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 40; i++) {
      const res = await worker.fetch(
        new Request(
          `https://ledgerline.test/api/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        ),
        env as never,
        createExecutionContext(),
      );
      const v = (await res.json()) as { posted: { key: string }[]; nextCursor: string | null };
      seen.push(...v.posted.map((r) => r.key));
      cursor = v.nextCursor;
      if (!cursor || v.posted.length < 50) break;
    }
    expect(seen).toEqual(all);

    const report = () =>
      JSON.stringify({ reads, top: [...bySql].sort((a, b) => b[1] - a[1]).slice(0, 12) }, null, 1);
    // Every screen.
    expect(reads['/api/badges'], report()).toBeLessThan(800);
    expect(reads['/api/session'], report()).toBeLessThan(100);
    // Screens: what you budget is November, so history must not be read.
    expect(reads['/api/budget/2026-11'], report()).toBeLessThan(1_500);
    expect(reads['/api/activity?filter=attention'], report()).toBeLessThan(1_500);
    expect(reads['/api/accounts'], report()).toBeLessThan(4_000);
    expect(reads['/api/owed'], report()).toBeLessThan(1_500);
    // The first Reports visit stores 13 months of totals (bounded; once per change to those months).
    expect(reads['/api/reports?month=2026-11'], report()).toBeLessThan(7_000);
    // The full Activity list pages through history 50 rows at a time.
    expect(reads['/api/activity'], report()).toBeLessThan(2_500);
    // Later visits read stored month totals; the first one after a change stores them.
    expect(reads['accounts again'], report()).toBeLessThan(1_200);
    expect(reads['reports again'], report()).toBeLessThan(1_500);
    // Edits.
    expect(reads['/api/transactions/categorize'], report()).toBeLessThan(500);
    expect(reads['/api/budget/assign'], report()).toBeLessThan(500);
  });
});
