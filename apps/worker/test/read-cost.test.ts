// D1 rows read per request, on about 600 transactions. The free plan allows 5 million reads a day, and every screen
// visit costs reads, so the screens shown everywhere (badges, session) must stay cheap. Fails if a change makes a
// request much more expensive.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';

let reads = 0;
const count = (r: unknown) => {
  const m = (r as { meta?: { rows_read?: number } })?.meta;
  if (m?.rows_read) reads += m.rows_read;
  return r;
};
function wrapStmt(st: D1PreparedStatement): D1PreparedStatement {
  return new Proxy(st, {
    get(t, k) {
      const v = Reflect.get(t, k);
      if (k === 'bind')
        return (...a: unknown[]) => wrapStmt((v as (...x: unknown[]) => D1PreparedStatement).apply(t, a));
      if (k === 'all' || k === 'run')
        return async (...a: unknown[]) =>
          count(await (v as (...x: unknown[]) => Promise<unknown>).apply(t, a));
      if (k === 'first')
        return async () => {
          const r = await t.all();
          count(r);
          return (r.results[0] ?? null) as never;
        };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}
const db = new Proxy(env.DB, {
  get(t, k) {
    const v = Reflect.get(t, k);
    if (k === 'prepare') return (sql: string) => wrapStmt(t.prepare(sql));
    if (k === 'batch')
      return async (stmts: D1PreparedStatement[]) => {
        const r = await t.batch(stmts);
        r.forEach(count);
        return r;
      };
    return typeof v === 'function' ? v.bind(t) : v;
  },
});
const call = async (p: string, method = 'GET') => {
  reads = 0;
  const r = await worker.fetch(
    new Request('https://ledgerline.test' + p, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-ledgerline': '1' },
      body: method === 'GET' ? undefined : '{}',
    }),
    { ...env, DB: db } as never,
    createExecutionContext(),
  );
  await r.text();
  return { p, status: r.status, reads };
};
describe('database reads per request', () => {
  it('stay within budget on about 600 transactions', async () => {
    await call('/__dev/seed-november', 'POST');
    // Inflate to about 600 bank transactions: copies of the seeded ones, dated in history (before budget_from).
    const cols = (await env.DB.prepare(`PRAGMA table_info(bank_txn)`).all<{ name: string }>()).results.map(
      (c) => c.name,
    );
    for (let i = 1; i <= 10; i++) {
      const sel = cols
        .map((c) =>
          c === 'txn_key'
            ? `txn_key || '-c${i}'`
            : c === 'provider_txn_id'
              ? `provider_txn_id || '-c${i}'`
              : c === 'date'
                ? `date(date, '-${i * 12} days')`
                : c,
        )
        .join(', ');
      await env.DB.prepare(
        `INSERT INTO bank_txn (${cols.join(', ')}) SELECT ${sel} FROM bank_txn WHERE txn_key NOT LIKE '%-c%'`,
      ).run();
      await env.DB.prepare(
        `INSERT INTO txn_overlay SELECT txn_key || '-c${i}', budget_id, payee_id, category_id, to_rta, income_tag, memo, budget_month, estimated_amount, wont_clear, transfer_state, transfer_account_id, wtm_state, categorized_by, rule_id, field_edits, reviewed_at, orphaned_at, pending_at_link, alert, created_at, updated_at FROM txn_overlay WHERE txn_key NOT LIKE '%-c%' AND txn_key IN (SELECT txn_key FROM bank_txn)`,
      ).run();
    }
    const n = await env.DB.prepare(
      'SELECT (SELECT count(*) FROM bank_txn) b, (SELECT count(*) FROM manual_pending) m, (SELECT count(*) FROM budget_line) l',
    ).first();
    console.log('data', JSON.stringify(n));
    const out: { p: string; status: number; reads: number }[] = [];
    for (const p of [
      '/api/badges',
      '/api/session',
      '/api/budget/2026-11',
      '/api/activity?filter=attention',
      '/api/activity',
      '/api/accounts',
      '/api/owed',
      '/api/reports?month=2026-11',
      '/api/settings/categories',
      '/api/settings/connections',
      '/api/settings/security',
      '/api/session',
    ])
      out.push(await call(p));
    const reads = Object.fromEntries(out.map((o) => [o.p, o.reads]));
    expect(n).toMatchObject({ b: 556 });
    for (const o of out) expect(o.status).toBe(200);
    // Shown on every screen.
    expect(reads['/api/badges']).toBeLessThan(2_500);
    expect(reads['/api/session']).toBeLessThan(100);
    // The heavy screens (measured Nov 1, 2026): keep them from growing further.
    expect(reads['/api/activity?filter=attention']).toBeLessThan(4_000);
    expect(reads['/api/budget/2026-11']).toBeLessThan(4_500);
    expect(reads['/api/activity']).toBeLessThan(8_000);
    expect(reads['/api/accounts']).toBeLessThan(6_000);
  });
});
