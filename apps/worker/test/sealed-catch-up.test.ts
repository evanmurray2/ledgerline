// One order for everything, and the bank log in the copy (docs/privacy.md 5.4; D-102): a device back after days
// away works through the bank runs and the missed days' scans strictly by time, each scan at 5:00 that day; the
// bank log a filing writes travels in its bank entry, so the other device holds it too; a device that joins from a
// snapshot holds the bank log and files the next run; a copy's bank log from before entries carried it is sent once.
import { PlaidProvider, type BankDataProvider } from '@ledgerline/bank-provider';
import { tokenKeyBytes, ulid } from '@ledgerline/platform';
import { cursorHash, encodeEntry, KIND, readEntry, serverKeys, startChain, toHex } from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import { scanTime } from '../src/daily-scan.js';
import { DeviceLog } from '../src/local/device-log.js';
import {
  differingTables,
  openSnapshot,
  tableHashes,
  writeSnapshot,
  type SnapshotTransport,
} from '../src/local/device-snapshot.js';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import {
  LogSession,
  type FilingDeps,
  type LogTransport,
  type RunTransport,
} from '../src/local/log-session.js';
import { FILED_KEY, FILED_LINK } from '../src/local/sealed-filing.js';
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
import {
  publicAfter,
  snapshotBegin,
  snapshotChunk,
  snapshotChunkOf,
  snapshotList,
  snapshotManifest,
} from '../src/seal/snapshot-store.js';
import { bankSync, plaidTxn } from './bank-sync.js';
import { BUDGET, PHONE, T0 } from './log-writer.js';
import { LINK_A, ring, world, type World } from './sealed-world.js';
import { storeDb } from './store-db.js';
import { differences, rowsOf } from './twin.js';

const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
const TABLET = '01DX5ZZKBKACTAV9WEVGEMMVRZ';
const CONN = `con_${LINK_A}`;
const DAY = 86_400_000;
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

describe('a sealed budget catches up by time, and its bank log travels', () => {
  it('scans and runs in one order; the bank log in entries and snapshots; an old bank log sent once', async () => {
    const old = bankSync(`catch-up-${Math.random()}`, BUDGET, CONN, 2, T0);
    await old.setup();
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
        const a = await device('catch-a', PHONE);
        const b = await device('catch-b', LAPTOP);
        await startLinks(x.d, [{ linkId: LINK_A, cursor: 'cur1' }], clock);
        const tz = (await a.engine.db.prepare(`SELECT time_zone FROM budget`).first<{ time_zone: string }>())!
          .time_zone;
        const headers = async (after: number) => {
          const out = [];
          for (const e of await logAfter(x.db, after, 100)) out.push((await readEntry(e.bytes)).header);
          return out;
        };
        const bankLog = async (e: LocalEngine) =>
          (
            await e.db
              .prepare(`SELECT id, sync_run_id, kind, provider_txn_id FROM bank_event ORDER BY id`)
              .all<Record<string, unknown>>()
          ).results;

        // ---- today's scan: the log's scan date
        clock += 1000;
        expect(await a.session.scan(clock)).toBe(1);
        const start = await logHead(x.db);

        // ---- three days away: a run after each of the next two days' scans
        const s1 = scanTime(clock + DAY, tz);
        const s2 = scanTime(clock + 2 * DAY, tz);
        const s3 = scanTime(clock + 3 * DAY, tz);
        await fetchRun(
          x,
          plaidBank({ cur1: { added: [plaidTxn('a-2', 1, 80, '2026-11-06', 'SHELL OIL')], next: 'cur2' } }),
          s1 + 3_600_000,
        );
        await fetchRun(
          x,
          plaidBank({ cur2: { added: [plaidTxn('a-3', 1, 9, '2026-11-07', 'CAFE')], next: 'cur3' } }),
          s2 + 3_600_000,
        );
        expect(await lastCompleteRun(x.db)).toBe(2);
        clock = s3 + 3_600_000;
        // One order: the scan of day 1, run 1, the scan of day 2, run 2, the scan of day 3.
        expect(await a.session.catchUp(src, filing(), clock)).toEqual({
          filed: 2,
          scans: 3,
          waiting: false,
          lost: 0,
        });
        const day = (t: number) => Math.floor(t / DAY);
        expect((await headers(start)).map((h) => [h.kind, h.filedThrough, h.scanThrough])).toEqual([
          [KIND.scan, 0, day(s1)],
          [KIND.bank, 1, day(s1)],
          [KIND.scan, 1, day(s2)],
          [KIND.bank, 2, day(s2)],
          [KIND.scan, 2, day(s3)],
        ]);
        expect(await a.session.catchUp(src, filing(), clock)).toEqual({
          filed: 0,
          scans: 0,
          waiting: false,
          lost: 0,
        });

        // ---- the bank log went with the runs: phone B holds the same log, and the same table hashes
        expect((await bankLog(a.engine)).length).toBeGreaterThan(0);
        expect(await b.session.pull()).toMatchObject({ entries: 6 });
        expect(await bankLog(b.engine)).toEqual(await bankLog(a.engine));
        expect(differences(await rowsOf(a.engine), await rowsOf(b.engine))).toEqual([]);
        expect(differingTables(await tableHashes(a.engine.db), await tableHashes(b.engine.db))).toEqual([]);

        // ---- a snapshot holds the bank log: a new device joins from it and files the next run
        clock += 1000;
        const sdeps = () => ({ db: x.db, budgetId: BUDGET, now: clock, resting: false });
        const snapshots: SnapshotTransport = {
          list: () => snapshotList(x.db),
          manifest: (id) => snapshotManifest(x.db, id),
          chunk: (id, k) => snapshotChunkOf(x.db, id, k),
          begin: (s) => snapshotBegin(sdeps(), s),
          put: (id, k, bytes) => snapshotChunk(sdeps(), id, k, bytes),
          check: async () => ({ ok: false }),
          publics: async () => (await publicAfter(x.db, 0, 1000)).map((e) => e.bytes),
          after: transport.after,
        };
        expect(await writeSnapshot(a.engine, a.log, snapshots, ulid(clock))).toMatchObject({ written: true });
        const cdb = storeDb(`catch-c-${Math.random()}`);
        await migrateLocal(cdb, T0);
        const c = new LocalEngine(
          cdb,
          { budgetId: BUDGET, userId: 'phone', email: 'o@example.com' },
          () => clock,
        );
        const logC = await openSnapshot(c, snapshots, {
          keys: [x.w.keys],
          budgetId: BUDGET,
          deviceId: TABLET,
          clock: () => clock,
        });
        expect(await bankLog(c)).toEqual(await bankLog(a.engine));
        const sessionC = new LogSession(c, logC, transport, encodeEntry);
        clock += 3_600_000;
        await fetchRun(
          x,
          plaidBank({ cur3: { added: [plaidTxn('a-4', 1, 5, '2026-11-08', 'BAKERY')], next: 'cur4' } }),
          clock,
        );
        clock += 1000;
        expect(await sessionC.catchUp(src, filing(), clock)).toMatchObject({ filed: 1, waiting: false });
        expect(await a.session.pull()).toMatchObject({ entries: 1 });
        expect(await bankLog(a.engine)).toEqual(await bankLog(c));
        expect(differences(await rowsOf(a.engine), await rowsOf(c))).toEqual([]);

        // ---- a copy's own bank log, from before entries carried it, is sent once: phone B lacks run 1's rows
        // (as a copy that took run 1 from an entry of the older app), and phone A sends its own
        await b.session.pull();
        await b.engine.db.prepare(`DELETE FROM bank_event WHERE sync_run_id = 'sealed:1'`).run();
        await b.engine.db.prepare(`DELETE FROM bank_page WHERE sync_run_id = 'sealed:1'`).run();
        expect((await bankLog(b.engine)).length).toBeLessThan((await bankLog(a.engine)).length);
        clock += 1000;
        expect(await a.session.shareBankLog(clock)).toBe(1);
        expect(await a.session.shareBankLog(clock)).toBe(0);
        expect(await a.session.flush()).toEqual({ sent: 1, lost: 0 });
        expect(await b.session.pull()).toMatchObject({ entries: 1 });
        expect(await bankLog(b.engine)).toEqual(await bankLog(a.engine));
        expect(differingTables(await tableHashes(a.engine.db), await tableHashes(b.engine.db))).toEqual([]);
        // A copy made from a snapshot has nothing of its own to send.
        await c.note(LogSession.BANK_LOG_SHARED, '1');
        expect(await sessionC.shareBankLog(clock)).toBe(0);
      },
      { described: false },
    );
  }, 180_000);
});
