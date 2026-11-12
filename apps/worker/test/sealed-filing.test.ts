// A sealed budget's bank data, end to end (docs/privacy.md 5.4 and 5.5): the server fetches a run, seals it and
// signs it without keeping a readable word; a phone checks and opens it, files it on its copy, and sends the rows
// as a bank entry with the run's receipt; another phone takes the entry and has the same rows, and files the next
// run itself. Edits wait behind unfiled runs.
import { PlaidProvider, type BankDataProvider } from '@ledgerline/bank-provider';
import {
  cursorHash,
  encodeEntry,
  KIND,
  readEntry,
  RunError,
  serverKeys,
  startChain,
  toHex,
  type Entry,
} from '@ledgerline/seal';
import { tokenKeyBytes } from '@ledgerline/platform';
import { describe, expect, it } from 'vitest';
import { DeviceLog } from '../src/local/device-log.js';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import {
  LogSession,
  type FilingDeps,
  type LogTransport,
  type RunTransport,
} from '../src/local/log-session.js';
import { FILED_KEY, FILED_LINK, UnsupportedRun } from '../src/local/sealed-filing.js';
import type { SyncPage } from '../src/routes/sync.js';
import { SEALED_FETCH, sealedFetchHandler, type FetchState } from '../src/seal/fetch-job.js';
import { logAfter, logAppend, logHead } from '../src/seal/log-store.js';
import {
  keyStampStmts,
  lastCompleteRun,
  receiptHashes,
  runsAfter,
  sealedPageOf,
  startLinks,
} from '../src/seal/runs.js';
import { bankSync, pend, plaidTxn, removal } from './bank-sync.js';
import { BUDGET, PHONE, T0 } from './log-writer.js';
import { LINK_A, ring, world, type World } from './sealed-world.js';
import { storeDb } from './store-db.js';
import { differences, rowsOf } from './twin.js';

const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
const CONN = `con_${LINK_A}`;
const plaid = new PlaidProvider({ clientId: 'x', secret: 'y', env: 'sandbox' });
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** The bank: Plaid's own page format, by cursor, and its answer about balances. */
function plaidBank(pages: Record<string, { added?: unknown[]; removed?: unknown[]; next: string }>) {
  return {
    fetchSyncPage: async (_c: unknown, cursor: string | null) => {
      const p = pages[cursor ?? ''];
      if (!p) throw new Error(`no page at ${cursor}`);
      return {
        body: enc({
          added: p.added ?? [],
          modified: [],
          removed: p.removed ?? [],
          next_cursor: p.next,
          has_more: false,
        }),
        nextCursor: p.next,
        hasMore: false,
      };
    },
    parsePage: (body: string) => plaid.parsePage(body),
    getAccounts: async () => [
      {
        providerAccountId: 'pa_1',
        name: 'Card 1',
        currentBalance: 4_321,
        availableBalance: null,
        creditLimit: 500_000,
      },
    ],
    getLiabilities: async () => [],
  } as unknown as BankDataProvider;
}

/** The server fetches one run for the link, step by step, as its job does. */
async function fetchRun(x: World, provider: BankDataProvider, now: number): Promise<void> {
  const h = sealedFetchHandler({
    runs: x.d,
    provider: () => provider,
    pageSize: 100,
    budgetState: async () => 'normal',
  });
  let state: FetchState = { phase: 'begin', linkId: LINK_A };
  for (let i = 0; i < 20; i++) {
    const r = await h(
      { id: 'j', kind: SEALED_FETCH, connectionId: null, state, attempts: 1, recurring: false },
      now + i,
    );
    if ('done' in r) return;
    state = r.state as FetchState;
  }
  throw new Error('the fetch did not finish');
}

interface Device {
  engine: LocalEngine;
  log: DeviceLog;
  session: LogSession;
}

describe('a sealed budget: the server seals bank runs, the phones file them', () => {
  it('two phones file runs in turn and stay equal; edits wait behind runs; a changed run is refused', async () => {
    const old = bankSync(`sealed-filing-${Math.random()}`, BUDGET, CONN, 2, T0);
    await old.setup();
    // One update the server itself filed, before the cutover.
    await old.sync([plaidTxn('a-1', 1, 12.5, '2026-11-05', 'BLUE BOTTLE COFFEE')], [], T0);

    await world(
      async (x) => {
        let clock = T0 + 10_000;
        const transport: LogTransport = {
          after: async (n) => (await logAfter(x.db, n, 100)).map((e) => e.bytes),
          append: async (base, entries) =>
            logAppend(
              {
                db: x.db,
                budgetId: BUDGET,
                now: clock,
                resting: false,
                freshWay: false,
                lastCompleteRun: await lastCompleteRun(x.db),
                receiptHashes: (from, to) => receiptHashes(x.db, from, to),
                stamps: (before, after) => keyStampStmts(x.d, before, after, clock),
              },
              base,
              entries,
            ),
        };
        const src: RunTransport = {
          runs: (after) => runsAfter(x.db, after, 64),
          page: async (run, page) => (await sealedPageOf(x.db, run, page))!,
        };
        const k = await serverKeys(await tokenKeyBytes(ring.keys[1]!), 1);
        const filing = (): FilingDeps => ({
          workerKeys: new Map([[1, (k.runSign as { pub: Uint8Array }).pub]]),
          provider: plaid,
          now: clock,
        });
        const genesis = x.w.last!;

        /** A phone at the cutover: the budget as the old server had it, and where filing starts. */
        const device = async (name: string, deviceId: string): Promise<Device> => {
          const db = storeDb(`${name}-${Math.random()}`);
          await migrateLocal(db, T0);
          const engine = new LocalEngine(
            db,
            { budgetId: BUDGET, userId: 'phone', email: 'o@example.com' },
            () => clock,
          );
          for (let n = 0; ; n++) {
            if (n > 50) throw new Error('sync did not finish');
            const { since, cursor } = await engine.nextRequest();
            const q = new URLSearchParams({ since: String(since), limit: '200' });
            if (cursor) q.set('cursor', cursor);
            const r = await old.call('GET', `/api/sync?${q}`);
            if ((await engine.apply(r.json as SyncPage)).caughtUp) break;
          }
          const st = await engine.state();
          // The copy now stands at the log's first entry, and filing starts after the server's own last update.
          await engine.apply({
            format: st.format,
            epoch: st.epoch!,
            serverTime: clock,
            through: 1,
            more: false,
            cursor: null,
            rows: [],
          });
          const set = (key: string, value: string) =>
            db
              .prepare(`INSERT INTO setting (budget_id, key, value, updated_at) VALUES (?1, ?2, ?3, 0)`)
              .bind(BUDGET, key, value)
              .run();
          await set(
            FILED_KEY,
            JSON.stringify({ v: 1, run: 0, hash: '0'.repeat(64), time: 0, inbox: 0, seqBase: 1 }),
          );
          await set(`${FILED_LINK}${LINK_A}`, toHex(await cursorHash('cur1')));
          const log = new DeviceLog(
            x.w.keys,
            await startChain(genesis, { now: clock, schemaVersion: 1 }, BUDGET),
            deviceId,
            () => clock,
          );
          return { engine, log, session: new LogSession(engine, log, transport, encodeEntry) };
        };
        const a = await device('sealed-a', PHONE);
        const b = await device('sealed-b', LAPTOP);
        const same = async () => differences(await rowsOf(a.engine), await rowsOf(b.engine));
        expect(await same()).toEqual([]);
        // The server: the link starts at its cutover cursor.
        await startLinks(x.d, [{ linkId: LINK_A, cursor: 'cur1' }], clock);

        const txns = async (d: Device) =>
          (
            await d.engine.db
              .prepare(
                `SELECT provider_txn_id FROM bank_txn WHERE removed_at IS NULL ORDER BY provider_txn_id`,
              )
              .all<{ provider_txn_id: string }>()
          ).results.map((r) => r.provider_txn_id);
        const lastEntry = async (): Promise<Entry> =>
          readEntry((await logAfter(x.db, (await logHead(x.db)) - 1, 1))[0]!.bytes);

        // ---- run 1: phone A files it
        clock += 60_000;
        await fetchRun(
          x,
          plaidBank({
            cur1: {
              added: [
                plaidTxn('a-2', 1, 80, '2026-11-06', 'SHELL OIL'),
                pend('p-1', 1, 30, '2026-11-07', 'MARRIOTT'),
              ],
              next: 'cur2',
            },
          }),
          clock,
        );
        expect(await lastCompleteRun(x.db)).toBe(1);
        // Nothing to file is not an error, and filing is: one run, in the log as a bank entry.
        clock += 1000;
        expect(await a.session.fileRuns(src, filing())).toEqual({ filed: 1, waiting: false, lost: 0 });
        expect(await txns(a)).toEqual(['a-1', 'a-2', 'p-1']);
        expect(await a.engine.queue()).toEqual([]);
        const first = await lastEntry();
        expect(first.header).toMatchObject({ kind: KIND.bank, number: 2, filedThrough: 1, deviceId: PHONE });
        expect((await a.engine.state()).through).toBe(2);
        expect(await a.session.fileRuns(src, filing())).toEqual({ filed: 0, waiting: false, lost: 0 });

        // Phone B takes the entry: the same rows, and it ran nothing.
        expect(await txns(b)).toEqual(['a-1']);
        expect(await b.session.pull()).toMatchObject({ entries: 1 });
        expect(await same()).toEqual([]);
        expect(await txns(b)).toEqual(['a-1', 'a-2', 'p-1']);

        // ---- run 2: phone B files it, from the filing state phone A's entry brought
        clock += 3_600_000;
        await fetchRun(
          x,
          plaidBank({
            cur2: {
              added: [plaidTxn('a-3', 1, 34.2, '2026-11-08', 'MARRIOTT', { pending_transaction_id: 'p-1' })],
              removed: [removal('p-1', 1)],
              next: 'cur3',
            },
          }),
          clock,
        );
        clock += 1000;
        expect(await b.session.fileRuns(src, filing())).toEqual({ filed: 1, waiting: false, lost: 0 });
        expect(await txns(b)).toEqual(['a-1', 'a-2', 'a-3']);
        expect(await a.session.pull()).toMatchObject({ entries: 1 });
        expect(await same()).toEqual([]);

        // ---- run 3: an edit made on phone A waits behind the run, then goes
        clock += 3_600_000;
        await fetchRun(
          x,
          plaidBank({
            cur3: { added: [plaidTxn('a-4', 2, 4.75, '2026-11-09', 'BLUE BOTTLE COFFEE')], next: 'cur4' },
          }),
          clock,
        );
        clock += 1000;
        const edit = await a.engine.enqueue({
          id: 'edit-behind-run-xxxxxx',
          at: clock,
          method: 'POST',
          path: '/api/budget/assign',
          body: { month: '2026-11', items: [{ categoryId: 'dining', amount: 5_500 }] },
        });
        expect(edit.response.status).toBe(200);
        // The log refuses the edit while a run waits: it stays in the queue, and nothing is lost.
        expect(await a.session.flush()).toEqual({ sent: 0, lost: 0 });
        expect((await a.engine.queue()).map((e) => e.id)).toEqual(['edit-behind-run-xxxxxx']);
        expect(await a.session.fileRuns(src, filing())).toEqual({ filed: 1, waiting: false, lost: 0 });
        // The run went under the edit: both are in the copy, and the edit still waits, on the new base.
        expect(await txns(a)).toEqual(['a-1', 'a-2', 'a-3', 'a-4']);
        expect((await a.engine.queue()).map((e) => [e.id, e.through])).toEqual([
          ['edit-behind-run-xxxxxx', 4],
        ]);
        expect(await a.session.flush()).toEqual({ sent: 1, lost: 0 });
        expect((await lastEntry()).header).toMatchObject({ kind: KIND.edit, number: 5, filedThrough: 3 });
        expect(await b.session.pull()).toMatchObject({ entries: 2 });
        expect(await same()).toEqual([]);
        expect(
          await b.engine.db
            .prepare(`SELECT amount FROM assignment WHERE month = '2026-11' AND category_id = 'dining'`)
            .first(),
        ).toEqual({ amount: 5_500 });

        // ---- run 4: both phones file it; one entry wins, and the other phone takes its rows
        clock += 3_600_000;
        await fetchRun(
          x,
          plaidBank({ cur4: { added: [plaidTxn('a-5', 1, 9.99, '2026-11-10', 'SPOTIFY')], next: 'cur5' } }),
          clock,
        );
        clock += 1000;
        // Phone A files the run on its copy and is cut off before it can send.
        const cut: RunTransport = src;
        const offline = new LogSession(
          a.engine,
          a.log,
          {
            after: transport.after,
            append: async () => ({ ok: false, why: 'limit', detail: 'cut off', retry: true }),
          },
          encodeEntry,
        );
        expect(await offline.fileRuns(cut, filing())).toMatchObject({ filed: 0, waiting: true });
        expect((await a.engine.queue()).map((e) => !!e.bank)).toEqual([true]);
        expect(await txns(a)).toContain('a-5');
        expect(await b.session.fileRuns(src, filing())).toEqual({ filed: 1, waiting: false, lost: 0 });
        // Phone A reads the log: its own filing comes out, phone B's rows go in, and nothing is filed twice.
        expect(await a.session.fileRuns(src, filing())).toEqual({ filed: 0, waiting: false, lost: 0 });
        expect(await a.engine.queue()).toEqual([]);
        expect(await same()).toEqual([]);
        expect(await logHead(x.db)).toBe(6);

        // ---- run 5: a page changed in the server's store is refused, and the copy stays as it was
        clock += 3_600_000;
        await fetchRun(
          x,
          plaidBank({ cur5: { added: [plaidTxn('a-6', 1, 1, '2026-11-11', 'NOT FILED')], next: 'cur6' } }),
          clock,
        );
        clock += 1000;
        const before = await rowsOf(a.engine);
        const swapped: RunTransport = {
          runs: src.runs,
          page: async (run, page) => (await sealedPageOf(x.db, run - 1, page))!,
        };
        await expect(a.session.fileRuns(swapped, filing())).rejects.toBeInstanceOf(RunError);
        expect(differences(await rowsOf(a.engine), before)).toEqual([]);
        expect(await a.engine.queue()).toEqual([]);
        // A phone whose clock is far behind the run waits; it is not told the run is bad.
        expect(await a.session.fileRuns(src, { ...filing(), now: clock - 86_400_000 })).toEqual({
          filed: 0,
          waiting: true,
          lost: 0,
        });
        // The run as the Worker made it files.
        expect(await a.session.fileRuns(src, filing())).toEqual({ filed: 1, waiting: false, lost: 0 });
        expect(await txns(a)).toContain('a-6');
        expect(await b.session.pull()).toMatchObject({ entries: 1 });
        expect(await same()).toEqual([]);
      },
      { described: false },
    );
  }, 60_000);

  it('a run for a bank this copy does not know is not filed, and not skipped', async () => {
    const old = bankSync(`sealed-unknown-${Math.random()}`, BUDGET, 'con_01HCCCCCCCCCCCCCCCCCCCCCCC', 1, T0);
    await old.setup();
    await world(async (x) => {
      // The world's two links are described and filed by its own device state; this copy has neither.
      const db = storeDb(`sealed-unknown-phone-${Math.random()}`);
      await migrateLocal(db, T0);
      const engine = new LocalEngine(
        db,
        { budgetId: BUDGET, userId: 'phone', email: 'o@example.com' },
        () => T0,
      );
      for (;;) {
        const { since, cursor } = await engine.nextRequest();
        const q = new URLSearchParams({ since: String(since), limit: '200' });
        if (cursor) q.set('cursor', cursor);
        if ((await engine.apply((await old.call('GET', `/api/sync?${q}`)).json as SyncPage)).caughtUp) break;
      }
      const st = await engine.state();
      await engine.apply({
        format: st.format,
        epoch: st.epoch!,
        serverTime: T0,
        through: 1,
        more: false,
        cursor: null,
        rows: [],
      });
      const log = new DeviceLog(
        x.w.keys,
        await startChain(x.w.last!, { now: T0 + 5000, schemaVersion: 1 }, BUDGET),
        PHONE,
        () => T0 + 5000,
      );
      const session = new LogSession(
        engine,
        log,
        {
          after: async (n) => (await logAfter(x.db, n, 100)).map((e) => e.bytes),
          append: async () => ({ ok: false, why: 'limit', detail: '', retry: true }),
        },
        encodeEntry,
      );
      const k = await serverKeys(await tokenKeyBytes(ring.keys[1]!), 1);
      // Run 1 describes a link: this app can't add a bank to a sealed budget yet.
      await expect(
        session.fileRuns(
          {
            runs: (after) => runsAfter(x.db, after, 64),
            page: async (r, p) => (await sealedPageOf(x.db, r, p))!,
          },
          {
            workerKeys: new Map([[1, (k.runSign as { pub: Uint8Array }).pub]]),
            provider: plaid,
            now: T0 + 5000,
          },
        ),
      ).rejects.toBeInstanceOf(UnsupportedRun);
      expect(await engine.queue()).toEqual([]);
    });
  });
});
