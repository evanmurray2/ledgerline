// Emptying a sealed budget's old tables, and the check 30 days later (src/seal/purge.ts; docs/privacy.md section
// 8, steps 8 and 9). On a sealed store with a first log entry, two stamped links and their first runs
// (sealed-world.ts), and old tables that hold rows, append-only pages and the triggers the old code had.
import { describe, expect, it } from 'vitest';
import {
  CHECK_AFTER_MS,
  KEPT_TABLES,
  oldTables,
  PURGE,
  PURGE_ID,
  PURGE_ROWS_PER_DAY,
  purgeFindings,
  purgeHandler,
  purgeStart,
  purgeStatus,
  type PurgeDeps,
  type PurgeState,
} from '../src/seal/purge.js';
import { WAY_BACK_MS } from '../src/seal/cutover.js';
import { cutoverBack } from '../src/seal/cutover.js';
import { BUDGET, T0 } from './log-writer.js';
import { world, type World } from './sealed-world.js';

const CUT = T0 + 10_000;
const CLOSED = CUT + WAY_BACK_MS + 60_000;

/** The old tables as the old code left them: a budget, links, payees (with their change log), bank pages. */
async function oldBudget(x: World, payees = 450) {
  await x.db
    .prepare(`INSERT INTO budget (id, name, created_at, updated_at) VALUES (?1, 'Our house budget', 1, 1)`)
    .bind(BUDGET)
    .run();
  // A link of the old code: its trigger copies it into bank_link, and a delete would take that row too.
  await x.db
    .prepare(
      `INSERT INTO connection (id, budget_id, provider, provider_item_id, institution_name, cursor, setup_done, linked_at, created_at, updated_at)
       VALUES ('con_01HCCCCCCCCCCCCCCCCCCCCCCC', ?1, 'plaid', 'item-old', 'Old Bank', 'c', 1, 5, 6, 6)`,
    )
    .bind(BUDGET)
    .run();
  const stmts = [];
  for (let i = 0; i < payees; i++)
    stmts.push(
      x.db
        .prepare(`INSERT INTO payee (id, budget_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, 1, 1)`)
        .bind(`p${i}`, BUDGET, `Payee ${i}`),
    );
  await x.db.batch(stmts);
  const big = 'x'.repeat(150_000);
  for (let i = 0; i < 6; i++)
    await x.db
      .prepare(
        `INSERT INTO raw_page (key, budget_id, body, sha256, bytes, created_at) VALUES (?1, ?2, ?3, 'h', 150000, 1)`,
      )
      .bind(`page-${i}`, BUDGET, big)
      .run();
  for (let i = 1; i <= 120; i++)
    await x.db
      .prepare(
        `INSERT INTO bank_event (id, budget_id, connection_id, sync_run_id, page, position, apply_seq, kind, provider_txn_id, payload, raw_ref, sha256, created_at)
         VALUES (?1, ?2, 'con_01HCCCCCCCCCCCCCCCCCCCCCCC', 'run', 0, ?1, ?1, 'added', ?3, '{"name":"Coffee"}', 'page-0#0', 'h', 1)`,
      )
      .bind(i, BUDGET, `t${i}`)
      .run();
  await x.db
    .prepare(
      `INSERT INTO setting (budget_id, key, value, updated_at) VALUES (?1, 'note', 'a readable note', 1)`,
    )
    .bind(BUDGET)
    .run();
}

const seal = (x: World, at = CUT) => {
  x.sql(`INSERT INTO store_mark (key, at) VALUES ('sealed', ?)`, at);
  x.sql(`INSERT INTO store_note (key, value) VALUES ('cutover_at', ?)`, at);
};

/** Every kept table's rows, to compare before and after. */
async function kept(x: World): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of KEPT_TABLES) {
    if (t === 'job' || t === 'store_note' || t === 'budget') continue;
    const r = await x.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all();
    out[t] = JSON.stringify(r.results, (_k, v: unknown) =>
      v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? [...new Uint8Array(v as ArrayBuffer)].join() : v,
    );
  }
  return out;
}

const deps = (x: World, o: Partial<PurgeDeps> = {}): PurgeDeps => ({
  db: x.db,
  budgetState: async () => 'normal',
  directoryName: async () => 'My budget',
  ...o,
});

/** Runs the job step by step, like the alarm does; gives each step's rows read and written. */
async function drive(x: World, d: PurgeDeps, start: number, max = 2000) {
  let state: PurgeState = { phase: 'triggers' };
  let now = start;
  const steps: { phase: string; read: number; written: number }[] = [];
  for (let i = 0; i < max; i++) {
    const before = { read: 0, written: 0 };
    const counted = countingDb(x, before);
    const r = await purgeHandler({ ...d, db: counted })(
      { id: PURGE_ID, kind: PURGE, connectionId: null, state, attempts: 1, recurring: false },
      now,
    );
    steps.push({ phase: state.phase, ...before });
    if ('done' in r) return { steps, now, done: true };
    state = r.state as PurgeState;
    if (state.phase === 'check') return { steps, now: r.runAt, done: false, state };
    now = Math.max(now, r.runAt);
  }
  throw new Error('the job did not end');
}

/** A Db that adds up what each statement read and wrote. */
function countingDb(x: World, sum: { read: number; written: number }): PurgeDeps['db'] {
  const db = x.db;
  const wrap = (s: ReturnType<typeof db.prepare>): ReturnType<typeof db.prepare> => ({
    get sql() {
      return s.sql;
    },
    get params() {
      return s.params;
    },
    bind: (...v: unknown[]) => wrap(s.bind(...v)),
    first: async (col?: string) => {
      const r = await s.all();
      sum.read += r.rowsRead;
      const row = r.results[0] ?? null;
      return (col && row ? (row as Record<string, unknown>)[col] : row) as never;
    },
    all: async () => {
      const r = await s.all();
      sum.read += r.rowsRead;
      sum.written += r.rowsWritten;
      return r as never;
    },
    run: async () => {
      const r = await s.run();
      sum.read += r.rowsRead;
      sum.written += r.rowsWritten;
      return r as never;
    },
  });
  return {
    prepare: (q: string) => wrap(db.prepare(q)),
    batch: async (stmts) => {
      const rs = await db.batch(stmts.map((s) => db.prepare(s.sql).bind(...s.params)));
      for (const r of rs) {
        sum.read += r.rowsRead;
        sum.written += r.rowsWritten;
      }
      return rs as never;
    },
  };
}

const count = async (x: World, t: string) =>
  (await x.db.prepare(`SELECT count(*) AS n FROM ${t}`).first<{ n: number }>())!.n;

describe('emptying the old tables of a sealed budget', () => {
  it('refuses a budget that is not sealed; a sealed one may be emptied while the way back is open', async () => {
    await world(async (x) => {
      await oldBudget(x, 5);
      const enqueue = async () => {
        throw new Error('nothing may be queued');
      };
      expect(await purgeStart(x.db, CLOSED, enqueue)).toEqual({
        ok: false,
        why: 'This budget is not locked.',
      });
      expect((await purgeStatus(x.db, CLOSED)).stage).toBe('none');
      seal(x);
      // The owner may delete it before the way back closes: it is offered at once.
      expect((await purgeStatus(x.db, CUT + 1)).stage).toBe('ready');
      expect((await purgeStatus(x.db, CLOSED)).stage).toBe('ready');
    });
  });

  it('empties every old table in small steps, keeps the sealed tables, and the check finds nothing', async () => {
    await world(async (x) => {
      await oldBudget(x);
      seal(x);
      const before = await kept(x);
      expect(await count(x, 'change_log')).toBeGreaterThan(400);
      const queued: unknown[] = [];
      expect(
        await purgeStart(x.db, CLOSED, async (kind, o) => {
          queued.push({ kind, ...o });
        }),
      ).toEqual({ ok: true });
      expect(queued).toEqual([{ kind: PURGE, id: PURGE_ID, state: { phase: 'triggers' }, runAt: CLOSED }]);
      // The way back is shut for good once the purge has begun.
      expect(await cutoverBack({ db: x.db, now: CUT + 1, markNow: CUT + 1 })).toMatchObject({ ok: false });

      const r = await drive(x, deps(x), CLOSED);
      expect(r.done).toBe(false);
      // Each step is small: a few hundred rows written at most, and a few thousand read (dropping a trigger
      // reads the schema; docs/measurements.md).
      for (const s of r.steps) {
        expect(s.written).toBeLessThan(1_000);
        expect(s.read).toBeLessThan(s.phase === 'triggers' ? 6_000 : 2_000);
      }
      expect(r.steps.length).toBeGreaterThan(5);
      for (const t of await oldTables(x.db)) expect([t, await count(x, t)]).toEqual([t, 0]);
      // No trigger is left on an old table; the budget row stays, with no name.
      const triggers = await x.db
        .prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger'`)
        .all<{ name: string; tbl_name: string }>();
      for (const t of triggers.results)
        expect(KEPT_TABLES.has(t.tbl_name) && t.tbl_name !== 'budget').toBe(true);
      expect(await x.db.prepare(`SELECT id, name FROM budget`).all()).toMatchObject({
        results: [{ id: BUDGET, name: '' }],
      });
      // The sealed tables are as they were, the bank links too (the old link's copy included).
      expect(await kept(x)).toEqual(before);
      expect(await count(x, 'bank_link')).toBe(3);
      const done = await purgeStatus(x.db, r.now);
      expect(done).toMatchObject({ stage: 'done', rows: expect.any(Number) as number });
      expect(done.done).toBe(done.tables);
      expect(done.checkAt).toBe(done.doneAt! + CHECK_AFTER_MS);

      // 31 days later, the check.
      const end = await purgeHandler(deps(x))(
        { id: PURGE_ID, kind: PURGE, connectionId: null, state: r.state!, attempts: 1, recurring: false },
        r.now,
      );
      expect(end).toEqual({ done: true });
      expect(await purgeStatus(x.db, r.now)).toMatchObject({ stage: 'checked', clean: true });
    });
  });

  it('holds a day’s writes under its own limit and the breaker’s pause, and the check finds what is left', async () => {
    await world(async (x) => {
      await oldBudget(x, 20);
      seal(x);
      const h = purgeHandler(deps(x, { budgetState: async () => 'pause' }));
      const job = (state: PurgeState) => ({
        id: PURGE_ID,
        kind: PURGE,
        connectionId: null,
        state,
        attempts: 1,
        recurring: false,
      });
      // The triggers go even while paused; deleting waits for the next day.
      let st: PurgeState = { phase: 'triggers' };
      for (let i = 0; i < 20 && st.phase === 'triggers'; i++)
        st = ((await h(job(st), CLOSED)) as { state: PurgeState }).state;
      expect(st.phase).toBe('tables');
      const paused = await h(job(st), CLOSED);
      expect((paused as { runAt: number }).runAt).toBeGreaterThan(CLOSED);
      expect(await count(x, 'payee')).toBe(20);
      const day = Math.floor(CLOSED / 86_400_000);
      const full = await purgeHandler(deps(x))(
        job({ phase: 'tables', tables: ['payee'], i: 0, day, written: PURGE_ROWS_PER_DAY }),
        CLOSED,
      );
      expect((full as { runAt: number }).runAt).toBeGreaterThanOrEqual((day + 1) * 86_400_000);
      expect(await count(x, 'payee')).toBe(20);
      // A row someone wrote after the emptying, and a name in the Directory, show in the check.
      expect(await purgeFindings(deps(x, { directoryName: async () => 'Our house budget' }))).toEqual(
        expect.arrayContaining(['payee', 'budget name', 'budget name in the Directory']),
      );
    });
  });
});
