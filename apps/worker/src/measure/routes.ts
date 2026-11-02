// Local measuring routes (docs/measurements.md, tools/measure). Served inside the dev user's BudgetStore, on its own
// database, only when MEASURE=1 outside production (index.ts and BudgetStore.dev both check).
import { Hono } from 'hono';
import { encryptToken, parseKeyring, ulid } from '@ledgerline/platform';
import type { Env } from '../env.js';
import type { AppEnv } from '../http/context.js';
import { cents, changeHash, computeBudget, encodeMonth, type Month } from '@ledgerline/domain';
import { lineFromRow } from '../budget/recompute.js';
import { seedBudget } from './budget-seed.js';
import { acquire } from '../sync/lease.js';
import { applyPage, beginRun, fetchPage, planApply, planStage, type StepContext } from '../sync/steps.js';
import { connectionToken, makeProvider } from '../sync/provider.js';

export const measure = new Hono<AppEnv>();

measure.post('/seed', async (c) => {
  const env = c.env;
  const now = Date.now();
  const budgetId = c.get('budgetId');
  const connectionId = `con_${ulid()}`;
  const provider = makeProvider(env);
  const link = await provider.sandboxCreateItem();
  const { enc, keyVersion } = await encryptToken(
    parseKeyring(env.TOKEN_KEYS, env.TOKEN_KEY_CURRENT),
    link.accessToken,
    connectionId,
  );
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE budget SET budget_start_month = coalesce(budget_start_month, '2023-11'), updated_at = ?2 WHERE id = ?1`,
    ).bind(budgetId, now),
    env.DB.prepare(
      `INSERT INTO connection (id, budget_id, provider, provider_item_id, institution_name, access_token_enc, key_version, linked_at, created_at, updated_at)
       VALUES (?1, ?2, 'plaid', ?3, 'Sandbox', ?4, ?5, ?6, ?6, ?6)`,
    ).bind(connectionId, budgetId, link.providerItemId, enc, keyVersion, now),
  ]);
  return c.json({ budgetId, connectionId });
});

function ctx(env: Env, b: { connectionId: string; budgetId: string; holder: string }): StepContext {
  return {
    db: env.DB,
    connectionId: b.connectionId,
    budgetId: b.budgetId,
    holder: b.holder,
    now: Date.now(),
  };
}

measure.post('/acquire', async (c) => {
  const b = await c.req.json<{ connectionId: string; budgetId: string }>();
  const holder = `run_${ulid()}`;
  const ok = await acquire(c.env.DB, b.connectionId, holder, Date.now());
  if (!ok) return c.json({ ok }, 409);
  const st = await beginRun(ctx(c.env, { ...b, holder }), 'measure');
  return c.json({ holder, state: st });
});

measure.post('/fetch', async (c) => {
  const b = await c.req.json<{
    connectionId: string;
    budgetId: string;
    holder: string;
    page: number;
    cursor: string | null;
    count: number;
  }>();
  const token = await connectionToken(c.env, b.connectionId);
  const r = await fetchPage(
    ctx(c.env, b),
    makeProvider(c.env),
    token,
    b.holder,
    0,
    b.page,
    b.cursor,
    b.count,
  );
  return c.json(r);
});

measure.post('/apply', async (c) => {
  const b = await c.req.json<{
    connectionId: string;
    budgetId: string;
    holder: string;
    page: number;
    chunk?: number;
  }>();
  const r = await applyPage(ctx(c.env, b), makeProvider(c.env), b.holder, b.page, b.chunk ?? 0);
  return c.json(r);
});

/** A whole sync as the app runs it: the store's sync job, one alarm step at a time. */
measure.post('/sync', async (c) => {
  const b = await c.req.json<{ connectionId: string }>();
  const runId = `run_${ulid()}`;
  if (!c.env.JOBS || !(await acquire(c.env.DB, b.connectionId, runId, Date.now())))
    return c.json({ ok: false }, 409);
  await c.env.JOBS.sync(runId, b.connectionId, 'measure');
  return c.json({ id: runId });
});

/** 'running' while the sync's job is queued; then 'complete' or 'errored' from its run. */
measure.get('/sync/:id', async (c) => {
  const id = c.req.param('id');
  const job = await c.env.DB.prepare(`SELECT failed_at, last_error FROM job WHERE id = ?1`)
    .bind(id)
    .first<{ failed_at: number | null; last_error: string | null }>();
  if (job) return c.json({ status: job.failed_at ? 'errored' : 'running', error: job.last_error });
  const run = await c.env.DB.prepare(`SELECT phase FROM sync_run ORDER BY started_at DESC LIMIT 1`).first<{
    phase: string;
  }>();
  return c.json({ status: run?.phase === 'done' ? 'complete' : 'errored', phase: run?.phase ?? null });
});

measure.get('/count', async (c) => {
  const r = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT count(*) AS n FROM bank_event`),
    c.env.DB.prepare(`SELECT count(*) AS n FROM bank_txn`),
    c.env.DB.prepare(
      `SELECT phase, pages_fetched, applied_through, restart_count FROM sync_run ORDER BY started_at DESC LIMIT 1`,
    ),
    c.env.DB.prepare(`SELECT cursor, sync_lock FROM connection ORDER BY created_at DESC LIMIT 1`),
  ]);
  return c.json(r.map((x) => x.results));
});

measure.post('/noop', (c) => c.json({ ok: true }));
measure.post('/burn', async (c) => {
  const { iters } = await c.req.json<{ iters: number }>();
  let x = 0;
  for (let i = 0; i < iters; i++) x = (x * 31 + i) % 1000003;
  return c.json({ x });
});

// Kernel timing: the step's own compute repeated `reps` times inside one request, so local emulator noise
// (in-process D1 simulator, tracing) averages out. D1 statements are recorded and serialized the way the D1
// client does (JSON request body), without I/O.
const recorder = {
  prepare(sql: string) {
    const st = {
      sql,
      params: [] as unknown[],
      bind(...p: unknown[]) {
        return { ...st, params: p };
      },
    };
    return st;
  },
} as unknown as Pick<D1Database, 'prepare'>;

measure.post('/kernel', async (c) => {
  const { count, reps, kind } = await c.req.json<{ count: number; reps: number; kind: 'apply' | 'fetch' }>();
  // One real page from the mock (or Sandbox), fetched outside the timed loop by the harness first.
  const res = await fetch(`${c.env.PLAID_BASE_URL}/transactions/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'x', secret: 'y', access_token: 'z', count }),
  });
  const bodyBytes = new Uint8Array(await res.arrayBuffer());
  return c.json(await runKernel(kind, bodyBytes, reps, makeProvider(c.env)));
});

async function runKernel(
  kind: 'apply' | 'fetch',
  bodyBytes: Uint8Array,
  reps: number,
  provider: ReturnType<typeof makeProvider>,
) {
  let bytes = 0;
  let stmtCount = 0;
  for (let r = 0; r < reps; r++) {
    if (kind === 'fetch') {
      // The fetch step scans the tail of the bytes, decodes them once and sends the text to D1 as one parameter
      // (decisions.md D-26).
      const st = planStage(bodyBytes);
      const text = new TextDecoder().decode(bodyBytes);
      const sha = 'none';
      const req = JSON.stringify({
        statements: [
          { sql: 'INSERT INTO raw_page ...', params: ['k', 'b', text, sha, bodyBytes.length, 0] },
          {
            sql: 'INSERT INTO sync_page ...',
            params: ['run', 0, 'b', 0, 'k', sha, bodyBytes.length, st.nextCursor, 1, 0],
          },
        ],
      });
      bytes += req.length;
      stmtCount = 3;
    } else {
      // The apply step gets the page text from D1 (parsed out of the D1 response), then plans the batch.
      const body = JSON.parse(JSON.stringify(new TextDecoder().decode(bodyBytes))) as string;
      const { stmts } = await planApply(
        recorder,
        { connectionId: 'con', budgetId: 'bud', holder: 'run', now: 1 },
        'run',
        r,
        0,
        false,
        {
          raw_key: 'raw/b/c/run/0-0000-x',
          sha256: 'x',
          bytes: bodyBytes.length,
          next_cursor: 'c',
          has_more: 1,
        },
        provider,
        body,
      );
      // ... and the D1 client's request serialization of the batch.
      const req = JSON.stringify({
        statements: (stmts as unknown as { sql: string; params: unknown[] }[]).map((s) => ({
          sql: s.sql,
          params: s.params,
        })),
      });
      bytes += req.length;
      stmtCount = stmts.length;
    }
  }
  return {
    reps,
    requestBytesPerRep: Math.round(bytes / reps),
    statements: stmtCount,
    bodyBytes: bodyBytes.length,
  };
}

// The I/O a sync step makes besides its compute, with trivial payloads: lease renewal, one read batch and one
// write batch. Repeated `reps` times so the per-step overhead can be separated from request overhead.
measure.post('/io-shell', async (c) => {
  const { reps } = await c.req.json<{ reps: number }>();
  const db = c.env.DB;
  for (let r = 0; r < reps; r++) {
    await db
      .prepare(`UPDATE connection SET lock_expires = lock_expires WHERE id = ?1 AND sync_lock IN (?2, ?3)`)
      .bind('x', 'y', 'z')
      .run();
    await db.batch([
      db.prepare(`SELECT raw_key, sha256 FROM sync_page WHERE sync_run_id = ?1 AND page = ?2`).bind('r', r),
      db.prepare(`SELECT applied_through FROM sync_run WHERE id = ?1`).bind('r'),
    ]);
    await db.batch([
      db.prepare(`INSERT OR REPLACE INTO lease_guard (id, ok) VALUES (2, 1)`),
      db.prepare(`UPDATE sync_run SET updated_at = ?1 WHERE id = ?2`).bind(r, 'none'),
      db.prepare(`UPDATE apply_counter SET seq = seq WHERE id = 1`),
    ]);
  }
  return c.json({ reps });
});

// Budget-edit kernel: everything the recompute does in Worker CPU for a first-month edit on the 36-month,
// 60-category dataset, repeated `reps` times: parse D1's response JSON, map rows to lines, computeBudget(), encode
// and hash every month, and serialize the write batch.
measure.post('/kernel-budget', async (c) => {
  const { reps, months } = await c.req.json<{ reps: number; months?: number }>();
  const seed = seedBudget(months ?? 36);
  // The read batch's response as D1 returns it (rows as objects).
  const cols = [
    'txn_key',
    'line',
    'month',
    'date',
    'seq',
    'kind',
    'account_id',
    'card',
    'category_id',
    'amount',
    'ref',
  ];
  const response = JSON.stringify([
    { results: [] },
    { results: seed.categories },
    { results: seed.lines.map((l) => Object.fromEntries(cols.map((k, i) => [k, l[i]]))) },
    { results: seed.assignments },
    { results: seed.months.map((m) => ({ month: m, hash: '00000000' })) },
    { results: [] },
  ]);
  let written = 0;
  for (let r = 0; r < reps; r++) {
    const [, cats, lines, asg] = JSON.parse(response) as { results: Record<string, unknown>[] }[];
    const result = computeBudget({
      startMonth: seed.startMonth as Month,
      currentMonth: seed.months[seed.months.length - 1] as Month,
      categories: cats!.results.map((x) => ({
        id: x.id as string,
        kind: x.kind as 'spending',
        cardAccountId: x.card_account_id as string | null,
      })),
      assignments: asg!.results.map((a) => ({
        categoryId: a.category_id as string,
        month: a.month as Month,
        amount: cents(a.amount as number),
      })),
      lines: lines!.results.map((x) =>
        lineFromRow([
          x.txn_key,
          x.line,
          x.month,
          x.date,
          x.seq,
          x.kind,
          x.account_id,
          x.card,
          x.category_id,
          x.amount,
          x.ref,
        ]),
      ),
      refundTargets: new Set(),
    });
    const stmts: { sql: string; params: unknown[] }[] = [];
    for (const m of result.months) {
      const json = JSON.stringify(encodeMonth(m));
      stmts.push({ sql: 'INSERT INTO month_snapshot ...', params: ['b', m.month, json, changeHash(json)] });
    }
    written += JSON.stringify({ statements: stmts }).length;
  }
  return c.json({ reps, responseBytes: response.length, requestBytesPerRep: Math.round(written / reps) });
});
