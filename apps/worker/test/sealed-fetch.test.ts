// The fetch job of a sealed budget (src/seal/fetch-job.ts): the steps of a bank run, one per alarm, and what
// ends a run early. The budget store runs only this work for a budget marked sealed.
import { ProviderError, type BankDataProvider } from '@ledgerline/bank-provider';
import { afterRun, openRun, randomBytes, toHex } from '@ledgerline/seal';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  queueSealedFetch,
  SEALED_FETCH,
  sealedBackstopHandler,
  sealedFetchHandler,
  sealedFetchId,
  sealedWebhook,
  type FetchDeps,
  type FetchState,
} from '../src/seal/fetch-job.js';
import { lastCompleteRun, STAGE_MAX_MS, stageOf } from '../src/seal/runs.js';
import type { BudgetStore } from '../src/store/budget-store.js';
import { nextUtcMidnight } from '../src/store/jobs.js';
import { T0 } from './log-writer.js';
import { bank, handed, LINK_A, LINK_B, text, TWO_PAGES, world, type World } from './sealed-world.js';

const ACCOUNTS = [
  {
    providerAccountId: 'acc-1',
    name: 'Checking',
    currentBalance: 12_300,
    availableBalance: 12_000,
    creditLimit: null,
  },
];
const LIABILITIES = [{ providerAccountId: 'card-1', statementBalance: 4_500 }];

/** The bank of the run tests, with its answers about accounts and card statements. */
function fullBank(
  pages: Parameters<typeof bank>[0],
  o: { accounts?: () => Promise<unknown>; liabilities?: unknown[]; fetch?: () => Promise<never> } = {},
) {
  const b = bank(pages);
  const asked = { accounts: 0, liabilities: 0 };
  const provider = Object.assign(b.provider, {
    getAccounts: async () => {
      asked.accounts++;
      return o.accounts ? o.accounts() : ACCOUNTS;
    },
    getLiabilities: async () => {
      asked.liabilities++;
      return o.liabilities ?? LIABILITIES;
    },
    ...(o.fetch ? { fetchSyncPage: o.fetch } : {}),
  }) as unknown as BankDataProvider;
  return { provider, calls: b.calls, asked };
}

const deps = (x: World, provider: BankDataProvider, o: Partial<FetchDeps> = {}): FetchDeps => ({
  runs: x.d,
  provider: () => provider,
  pageSize: 100,
  budgetState: async () => 'normal',
  ...o,
});

/** Runs a job to its end, step by step; gives the phase after each step and the last clock. */
async function drive(d: FetchDeps, linkId: string, start: number, max = 40) {
  const h = sealedFetchHandler(d);
  let state: FetchState = { phase: 'begin', linkId };
  let now = start;
  const phases: string[] = [];
  for (let i = 0; i < max; i++) {
    const r = await h(
      {
        id: sealedFetchId(linkId),
        kind: SEALED_FETCH,
        connectionId: null,
        state,
        attempts: 1,
        recurring: false,
      },
      now,
    );
    if ('done' in r) return { phases, now, state };
    state = r.state as FetchState;
    phases.push(state.phase);
    now = Math.max(now + 1, r.runAt);
  }
  return { phases, now, state, unfinished: true };
}

const linkRow = (x: World, id: string) =>
  x.db
    .prepare(
      `SELECT status, error_code, last_fetched_at, last_attempt_at, fetch_requested FROM bank_link WHERE id = ?1`,
    )
    .bind(id)
    .first<{
      status: string;
      error_code: string | null;
      last_fetched_at: number | null;
      last_attempt_at: number | null;
      fetch_requested: number;
    }>();

describe('the fetch job of a sealed budget', () => {
  it("a new link: its description first, then its transactions with the bank's answers", async () => {
    await world(
      async (x) => {
        const b = fullBank(TWO_PAGES);
        const enqueued: unknown[] = [];
        await queueSealedFetch(x.d, async (...a) => (enqueued.push(a), 'id'), LINK_A, T0 + 3000);
        expect(enqueued).toEqual([
          [
            SEALED_FETCH,
            { id: sealedFetchId(LINK_A), state: { phase: 'begin', linkId: LINK_A }, runAt: T0 + 3000 },
          ],
        ]);
        expect((await linkRow(x, LINK_A))!.fetch_requested).toBe(1);

        const r = await drive(deps(x, b.provider), LINK_A, T0 + 3000);
        expect(r.phases).toEqual([
          'describe',
          'complete',
          'begin',
          'fetch',
          'fetch',
          'balances',
          'liabilities',
          'complete',
        ]);
        expect(await stageOf(x.d)).toBeNull();
        expect(await lastCompleteRun(x.db)).toBe(2);
        expect(await linkRow(x, LINK_A)).toMatchObject({
          status: 'ok',
          error_code: null,
          fetch_requested: 0,
        });
        expect((await linkRow(x, LINK_A))!.last_fetched_at).toBeGreaterThan(T0);

        // A device opens both runs.
        const first = await openRun(x.filing, await handed(x.db, 1));
        expect(first.pages.map((p) => p.what)).toEqual([3]);
        expect(JSON.parse(text(first.pages[0]!.payload))).toMatchObject({
          linkId: LINK_A,
          linkedAt: 5,
          accounts: [{ providerAccountId: 'acc-1', name: 'Checking' }],
        });
        const second = await openRun(afterRun(x.filing, first), await handed(x.db, 2));
        expect(second.manifest).toMatchObject({ run: 2, added: 5, modified: 1, removed: 4, flags: 3 });
        expect(second.pages.map((p) => p.what)).toEqual([0, 0, 1, 2]);
        // The balances page holds the balances and no name.
        expect(JSON.parse(text(second.pages[2]!.payload))).toEqual([
          { providerAccountId: 'acc-1', currentBalance: 12_300, availableBalance: 12_000, creditLimit: null },
        ]);
        expect(JSON.parse(text(second.pages[3]!.payload))).toEqual(LIABILITIES);
      },
      { described: false },
    );
  });

  it('one link at a time: the other waits, then fetches', async () => {
    await world(async (x) => {
      const a = fullBank(TWO_PAGES);
      const b = fullBank({ '': { added: 1, next: 'b1', more: false } });
      const ha = sealedFetchHandler(deps(x, a.provider));
      const hb = sealedFetchHandler(deps(x, b.provider));
      const job = (linkId: string, state: FetchState) => ({
        id: sealedFetchId(linkId),
        kind: SEALED_FETCH,
        connectionId: null,
        state,
        attempts: 1,
        recurring: false,
      });
      const ra = await ha(job(LINK_A, { phase: 'begin', linkId: LINK_A }), T0 + 3000);
      expect(ra).toMatchObject({ state: { phase: 'fetch', run: 3 } });
      const rb = await hb(job(LINK_B, { phase: 'begin', linkId: LINK_B }), T0 + 3000);
      expect(rb).toEqual({ state: { phase: 'begin', linkId: LINK_B, busy: 1 }, runAt: T0 + 23_000 });
      expect((await drive(deps(x, a.provider), LINK_A, T0 + 3001)).phases.at(-1)).toBe('complete');
      const r = await drive(deps(x, b.provider), LINK_B, T0 + 23_000);
      expect(r.phases).toEqual(['fetch', 'balances', 'liabilities', 'complete']);
      expect(await lastCompleteRun(x.db)).toBe(4);
      // A link that waits too long leaves it to the backstop; its request stays noted.
      await queueSealedFetch(x.d, async () => 'id', LINK_B, T0 + 30_000);
      await ha(job(LINK_A, { phase: 'begin', linkId: LINK_A }), T0 + 30_000);
      expect(await hb(job(LINK_B, { phase: 'begin', linkId: LINK_B, busy: 30 }), T0 + 30_001)).toEqual({
        done: true,
      });
      expect((await linkRow(x, LINK_B))!.fetch_requested).toBe(1);
    });
  });

  it('past 70% of a daily limit, nothing is begun or fetched until the next day', async () => {
    await world(async (x) => {
      const a = fullBank(TWO_PAGES);
      const h = sealedFetchHandler(deps(x, a.provider, { budgetState: async () => 'pause' }));
      const state: FetchState = { phase: 'begin', linkId: LINK_A };
      const r = await h(
        { id: 'j', kind: SEALED_FETCH, connectionId: null, state, attempts: 1, recurring: false },
        T0 + 3000,
      );
      expect(r).toEqual({ state, runAt: nextUtcMidnight(T0 + 3000) });
      expect(await stageOf(x.d)).toBeNull();
      expect(a.calls).toEqual([]);
    });
  });

  it('a link that needs a new sign-in: the run is given up and the link waits for a repair', async () => {
    await world(async (x) => {
      const a = fullBank(TWO_PAGES, {
        fetch: async () => {
          throw new ProviderError('ITEM_LOGIN_REQUIRED', 'sign in again', false);
        },
      });
      const r = await drive(deps(x, a.provider), LINK_A, T0 + 3000);
      expect(r.phases).toEqual(['fetch']);
      expect(await stageOf(x.d)).toBeNull();
      expect(await lastCompleteRun(x.db)).toBe(2);
      expect(await linkRow(x, LINK_A)).toMatchObject({
        status: 'needs_repair',
        error_code: 'ITEM_LOGIN_REQUIRED',
        last_attempt_at: T0 + 3001,
      });
      // The backstop leaves it alone, and asks for the other link.
      const queued: string[] = [];
      const back = sealedBackstopHandler(x.d, async (_k, o) => (queued.push(String(o.id)), 'id'));
      expect(await back({} as never, T0 + 5 * 3_600_000)).toEqual({
        state: {},
        runAt: T0 + 9 * 3_600_000,
      });
      expect(queued).toEqual([sealedFetchId(LINK_B)]);
      // The other link is not held back.
      const b = fullBank({ '': { added: 1, next: 'b1', more: false } });
      expect((await drive(deps(x, b.provider), LINK_B, T0 + 4000)).phases.at(-1)).toBe('complete');
      expect(await lastCompleteRun(x.db)).toBe(3);
    });
  });

  it('a fault that may pass is thrown, so the runner tries the step again', async () => {
    await world(async (x) => {
      const a = fullBank(TWO_PAGES, {
        fetch: async () => {
          throw new ProviderError('RATE_LIMIT', 'slow down', true);
        },
      });
      await expect(drive(deps(x, a.provider), LINK_A, T0 + 3000)).rejects.toMatchObject({
        code: 'RATE_LIMIT',
      });
      // The run stays, for the step to go on with.
      expect(await stageOf(x.d)).toMatchObject({ linkId: LINK_A, pages: 0 });
    });
  });

  it('a bank that will not say its balances: the run is stored without them', async () => {
    await world(async (x) => {
      const a = fullBank(TWO_PAGES, {
        accounts: async () => {
          throw new Error('bank is down');
        },
        liabilities: [],
      });
      const r = await drive(deps(x, a.provider), LINK_A, T0 + 3000);
      expect(r.phases.at(-1)).toBe('complete');
      const filed = await openRun(x.filing, await handed(x.db, 3));
      expect(filed.manifest.flags).toBe(0);
      expect(filed.pages.map((p) => p.what)).toEqual([0, 0]);
    });
  });

  it('a changed row ends the job, loudly, and seals nothing', async () => {
    await world(async (x) => {
      const a = fullBank(TWO_PAGES);
      x.sql(`UPDATE key_stamp SET pub = ?1 WHERE kind = 2`, toHex(randomBytes(32)));
      const r = await drive(deps(x, a.provider), LINK_A, T0 + 3000);
      expect(r.phases).toEqual([]);
      expect(a.calls).toEqual([]);
      expect(await linkRow(x, LINK_A)).toMatchObject({ status: 'ok', error_code: 'bad_stamp:inbox key' });
    });
    // In the middle of a run: the run is given up.
    await world(async (x) => {
      const a = fullBank(TWO_PAGES);
      const h = sealedFetchHandler(deps(x, a.provider));
      const job = (state: FetchState) => ({
        id: 'j',
        kind: SEALED_FETCH,
        connectionId: null,
        state,
        attempts: 1,
        recurring: false,
      });
      const one = await h(job({ phase: 'begin', linkId: LINK_A }), T0 + 3000);
      const two = await h(job((one as { state: FetchState }).state), T0 + 3001);
      x.sql(`UPDATE run_stage SET cursor = 'elsewhere'`);
      expect(await h(job((two as { state: FetchState }).state), T0 + 3002)).toEqual({ done: true });
      expect(await stageOf(x.d)).toBeNull();
      expect(await linkRow(x, LINK_A)).toMatchObject({ error_code: 'bad_stamp:run stage' });
      expect(await lastCompleteRun(x.db)).toBe(2);
    });
  });

  it("the bank's news: new data starts a fetch, an error asks for a repair, a repair fetches again", async () => {
    await world(async (x) => {
      const queued: string[] = [];
      const enqueue = async (_k: string, o: { id?: string }) => (queued.push(String(o.id)), 'id');
      const ev = (type: string, item: string | null, code = '') =>
        sealedWebhook(x.d, enqueue, { type, providerItemId: item, code } as never, T0 + 3000);
      await ev('sync_updates_available', `item-${LINK_A}`);
      expect(queued).toEqual([sealedFetchId(LINK_A)]);
      await ev('sync_updates_available', 'an item of another budget');
      await ev('sync_updates_available', null);
      await ev('other', `item-${LINK_A}`);
      expect(queued.length).toBe(1);
      await ev('item_error', `item-${LINK_B}`, 'ITEM_LOGIN_REQUIRED');
      expect(await linkRow(x, LINK_B)).toMatchObject({
        status: 'needs_repair',
        error_code: 'ITEM_LOGIN_REQUIRED',
      });
      expect(queued.length).toBe(1);
      await ev('login_repaired', `item-${LINK_B}`);
      expect(await linkRow(x, LINK_B)).toMatchObject({ status: 'ok', error_code: null, fetch_requested: 1 });
      expect(queued).toEqual([sealedFetchId(LINK_A), sealedFetchId(LINK_B)]);
      // A link with no stamp gets no fetch.
      x.sql(`UPDATE bank_link SET mac = NULL WHERE id = ?1`, LINK_A);
      await ev('sync_updates_available', `item-${LINK_A}`);
      expect(queued.length).toBe(2);
    });
  });

  it('a job whose run was replaced by another link does nothing to that run', async () => {
    await world(async (x) => {
      const a = fullBank(TWO_PAGES);
      const b = fullBank({ '': { added: 1, next: 'b1', more: false } });
      const ha = sealedFetchHandler(deps(x, a.provider));
      const hb = sealedFetchHandler(deps(x, b.provider));
      const job = (linkId: string, state: FetchState) => ({
        id: sealedFetchId(linkId),
        kind: SEALED_FETCH,
        connectionId: null,
        state,
        attempts: 1,
        recurring: false,
      });
      // Link A's job fetches all its pages, then is left alone for too long (a pause to the next day).
      let sa = (
        (await ha(job(LINK_A, { phase: 'begin', linkId: LINK_A }), T0 + 3000)) as { state: FetchState }
      ).state;
      sa = ((await ha(job(LINK_A, sa), T0 + 3001)) as { state: FetchState }).state;
      sa = ((await ha(job(LINK_A, sa), T0 + 3002)) as { state: FetchState }).state;
      expect(sa).toMatchObject({ phase: 'balances', run: 3 });
      // Link B's job takes the place: run 3 is link B's now.
      const late = T0 + 3003 + STAGE_MAX_MS;
      const sb = ((await hb(job(LINK_B, { phase: 'begin', linkId: LINK_B }), late)) as { state: FetchState })
        .state;
      expect(sb).toMatchObject({ phase: 'fetch', run: 3 });
      // Link A's job goes on from its saved state: it must not seal its balances into link B's run.
      const r = await ha(job(LINK_A, sa), late + 1);
      expect(r).toEqual({ state: { phase: 'begin', linkId: LINK_A, begins: 1 }, runAt: late + 1 });
      expect(await stageOf(x.d)).toMatchObject({ linkId: LINK_B, pages: 0 });
      expect(a.asked.accounts).toBe(1);
      // Nor complete it, nor mark link A as fetched.
      const c = await ha(job(LINK_A, { ...sa, phase: 'complete' }), late + 2);
      expect(c).toMatchObject({ state: { phase: 'begin' } });
      expect(await lastCompleteRun(x.db)).toBe(2);
      expect((await linkRow(x, LINK_A))!.last_fetched_at).toBeNull();
      // Link B's run goes on untouched, with its own balances.
      expect((await drive(deps(x, b.provider), LINK_B, late + 3)).phases.at(-1)).toBe('complete');
      const filed = await openRun({ ...x.filing, now: late + 60_000 }, await handed(x.db, 3));
      expect(filed.manifest.linkId).toBe(LINK_B);
      expect(filed.pages.map((p) => p.what)).toEqual([0, 1, 2]);
    });
  });

  it('a run that another step moved begins again, a few times only', async () => {
    await world(async (x) => {
      const a = fullBank(TWO_PAGES);
      const h = sealedFetchHandler(deps(x, a.provider));
      // A job that thinks it is fetching, with no run there.
      const r = await h(
        {
          id: 'j',
          kind: SEALED_FETCH,
          connectionId: null,
          state: { phase: 'fetch', linkId: LINK_A, run: 3 },
          attempts: 1,
          recurring: false,
        },
        T0 + 3000,
      );
      expect(r).toEqual({ state: { phase: 'begin', linkId: LINK_A, begins: 1 }, runAt: T0 + 3000 });
      const last = await h(
        {
          id: 'j',
          kind: SEALED_FETCH,
          connectionId: null,
          state: { phase: 'fetch', linkId: LINK_A, run: 3, begins: 5 },
          attempts: 1,
          recurring: false,
        },
        T0 + 3000,
      );
      expect(last).toEqual({ done: true });
      expect(await linkRow(x, LINK_A)).toMatchObject({ error_code: 'run_stopped' });
    });
  });
});

describe('the budget store, for a budget marked sealed', () => {
  it('runs the sealed jobs and drops any other job unrun; a budget not sealed drops the sealed jobs', async () => {
    const e = env as unknown as { BUDGET: DurableObjectNamespace<BudgetStore> };
    await runInDurableObject(
      e.BUDGET.get(e.BUDGET.idFromName(`sealed-jobs-${Math.random()}`)),
      async (o, state) => {
        const sql = (q: string, ...p: unknown[]) => state.storage.sql.exec(q, ...p).toArray();
        sql(
          `INSERT INTO budget (id, name, created_at, updated_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'B', 0, 0)`,
        );
        const add = (id: string, kind: string) =>
          sql(
            `INSERT INTO job (id, kind, state, run_at, recurring, created_at, updated_at) VALUES (?, ?, '{}', 1, 1, 1, 1)`,
            id,
            kind,
          );
        // Not sealed: a sealed job is dropped.
        add('sealed_backstop', 'sealed_backstop');
        await o.alarm();
        expect(sql(`SELECT id FROM job WHERE kind = 'sealed_backstop'`)).toEqual([]);

        sql(`INSERT INTO store_mark (key, at) VALUES ('sealed', 1)`);
        add('daily_scan', 'daily_scan');
        // The old purge and link check (D-105) are dropped unrun too.
        add('purge_old', 'purge_old');
        add('stamp_links', 'stamp_links');
        add('sealed_backstop', 'sealed_backstop');
        for (let i = 0; i < 4; i++) await o.alarm();
        // The old job is gone; the sealed backstop ran and comes again in 4 hours.
        expect(sql(`SELECT id FROM job WHERE kind IN ('daily_scan', 'purge_old', 'stamp_links')`)).toEqual(
          [],
        );
        const back = sql(`SELECT run_at, attempts FROM job WHERE kind = 'sealed_backstop'`) as {
          run_at: number;
          attempts: number;
        }[];
        expect(back.length).toBe(1);
        expect(back[0]!.run_at).toBeGreaterThan(Date.now() + 3 * 3_600_000);
      },
    );
  });
});
