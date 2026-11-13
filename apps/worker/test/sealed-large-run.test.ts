// A new bank's first run of transactions brings 180 days of history (D-104): thousands of transactions, whose
// rows (the bank log, the bank's own rows, the budget's transactions) are several MB as JSON, more than the 16
// parts of one write. The device compresses the change set before it seals it (local/change-set.ts): the run is
// filed in one bank entry, and another device opens it and has the same rows.
import { PlaidProvider, type BankDataProvider } from '@ledgerline/bank-provider';
import {
  cursorHash,
  encodeEntry,
  KIND,
  MAX_PLAIN,
  MAX_WRITE_ENTRIES,
  openEntryBody,
  readEntry,
  serverKeys,
  startChain,
  toHex,
  type Entry,
} from '@ledgerline/seal';
import { tokenKeyBytes } from '@ledgerline/platform';
import { describe, expect, it } from 'vitest';
import { encodeChangeSet, openChangeSet } from '../src/local/change-set.js';
import { DeviceLog } from '../src/local/device-log.js';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import {
  LogSession,
  type FilingDeps,
  type LogTransport,
  type RunTransport,
} from '../src/local/log-session.js';
import { FILED_KEY, FILED_LINK } from '../src/local/sealed-filing.js';
import { SEALED_FETCH, sealedFetchHandler, type FetchState } from '../src/seal/fetch-job.js';
import { logAfter, logAppend, logHead } from '../src/seal/log-store.js';
import { LOG_SCHEMA_VERSION } from '../src/seal/log-versions.js';
import {
  keyStampStmts,
  lastCompleteRun,
  receiptHashes,
  runsAfter,
  sealedPageOf,
  startLinks,
} from '../src/seal/runs.js';
import { bankSync, plaidTxn } from './bank-sync.js';
import { copyOf } from './copy-of.js';
import { BUDGET, PHONE, T0 } from './log-writer.js';
import { LINK_A, ring, world, type World } from './sealed-world.js';
import { copyDb } from './store-db.js';
import { differences, rowsOf } from './twin.js';

const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
const CONN = `con_${LINK_A}`;
const plaid = new PlaidProvider({ clientId: 'x', secret: 'y', env: 'sandbox' });
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/**
 * Transactions in the history (a busy card's 180 days: D-104 guessed over a thousand), and how many a page of the
 * bank's sync holds (Plaid's most). Measured Nov 13, 2026 with these transactions: each brings 4 rows, about 2.6 KB
 * of change set as JSON and about 250 bytes compressed, so 2,000 are about 5.1 MB (79 parts) plain and 8 parts
 * compressed, and one write holds a run of about 4,000. (The test's copies are Durable Object SQLite, whose limit on
 * one value the queue of 4,000 passes; a phone's copy is sql.js, which has none that low.)
 */
const TXNS = 2000;
const PAGE = 500;

const MERCHANTS = [
  ['BLUE BOTTLE COFFEE', 'FOOD_AND_DRINK_COFFEE'],
  ['SHELL OIL 57444', 'TRANSPORTATION_GAS'],
  ['SAFEWAY #1234', 'FOOD_AND_DRINK_GROCERIES'],
  ['AMAZON MKTPL*2K4', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES'],
  ['UBER *TRIP HELP.UBER.COM', 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES'],
  ['NETFLIX.COM', 'ENTERTAINMENT_TV_AND_MOVIES'],
  ['TRADER JOE S #552', 'FOOD_AND_DRINK_GROCERIES'],
  ['PG&E WEB ONLINE', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY'],
  ['CHIPOTLE 1873', 'FOOD_AND_DRINK_FAST_FOOD'],
  ['WALGREENS #3381', 'MEDICAL_PHARMACIES_AND_SUPPLEMENTS'],
] as const;

/** A random id as Plaid makes them: 37 letters and digits, which don't compress. */
function plaidId(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(37)), (b) => abc[b % abc.length]).join('');
}

/** 180 days of a busy card's history, newest first, in pages as the bank's sync sends them. */
function history(): Record<string, { added: unknown[]; next: string; more: boolean }> {
  const day = 86_400_000;
  const end = Date.UTC(2026, 10, 12);
  const txns = Array.from({ length: TXNS }, (_, i) => {
    const [name, category] = MERCHANTS[i % MERCHANTS.length]!;
    const date = new Date(end - Math.floor((i * 180) / TXNS) * day).toISOString().slice(0, 10);
    return plaidTxn(plaidId(), 1 + (i % 2), Math.round(((i * 7919) % 20_000) + 99) / 100, date, name, {
      merchant_name: name.split(/[ *#]/)[0],
      merchant_entity_id: plaidId().slice(0, 22),
      personal_finance_category: {
        primary: category.split('_')[0],
        detailed: category,
        confidence_level: 'HIGH',
      },
    });
  });
  const pages: Record<string, { added: unknown[]; next: string; more: boolean }> = {};
  for (let p = 0; p * PAGE < TXNS; p++)
    pages[p === 0 ? 'cur1' : `h${p}`] = {
      added: txns.slice(p * PAGE, (p + 1) * PAGE),
      next: (p + 1) * PAGE < TXNS ? `h${p + 1}` : 'cur2',
      more: (p + 1) * PAGE < TXNS,
    };
  return pages;
}

/** The bank: Plaid's own page format, by cursor, and its answer about balances. */
function plaidBank(pages: Record<string, { added: unknown[]; next: string; more: boolean }>) {
  return {
    fetchSyncPage: async (_c: unknown, cursor: string | null) => {
      const p = pages[cursor ?? ''];
      if (!p) throw new Error(`no page at ${cursor}`);
      return {
        body: enc({ added: p.added, modified: [], removed: [], next_cursor: p.next, has_more: p.more }),
        nextCursor: p.next,
        hasMore: p.more,
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
async function fetchRun(x: World, provider: BankDataProvider, now: number): Promise<number> {
  const h = sealedFetchHandler({
    runs: x.d,
    provider: () => provider,
    pageSize: PAGE,
    budgetState: async () => 'normal',
  });
  let state: FetchState = { phase: 'begin', linkId: LINK_A };
  for (let i = 0; i < 200; i++) {
    const r = await h(
      { id: 'j', kind: SEALED_FETCH, connectionId: null, state, attempts: 1, recurring: false },
      now + i,
    );
    if ('done' in r) return i + 1;
    state = r.state as FetchState;
  }
  throw new Error('the fetch did not finish');
}

describe('a first run of 180 days', () => {
  it('is filed in one compressed bank entry, and another device opens it', { timeout: 240_000 }, async () => {
    const old = bankSync(`sealed-large-${Math.random()}`, BUDGET, CONN, 2, T0);
    await old.setup();

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
        const device = async (name: string, deviceId: string) => {
          const db = copyDb(`${name}-${Math.random()}`);
          await migrateLocal(db, T0);
          const engine = new LocalEngine(
            db,
            { budgetId: BUDGET, userId: 'phone', email: 'o@example.com' },
            () => clock,
          );
          await copyOf(old.db, engine, clock);
          const st = await engine.state();
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
        const a = await device('large-a', PHONE);
        const b = await device('large-b', LAPTOP);
        await startLinks(x.d, [{ linkId: LINK_A, cursor: 'cur1' }], clock);

        clock += 60_000;
        await fetchRun(x, plaidBank(history()), clock);

        expect(await lastCompleteRun(x.db)).toBe(1);
        clock += 1000;
        expect(await a.session.fileRuns(src, filing())).toEqual({ filed: 1, waiting: false, lost: 0 });
        expect(await a.engine.queue()).toEqual([]);

        // One bank entry, in at most 16 parts, under the version that compresses.
        const head = await logHead(x.db);
        const entries: Entry[] = [];
        for (const r of await logAfter(x.db, 1, 100)) entries.push(await readEntry(r.bytes));
        expect(entries.length).toBe(head - 1);
        expect(entries.every((e) => e.header.kind === KIND.bank && e.header.filedThrough === 1)).toBe(true);
        expect(entries.length).toBeLessThanOrEqual(MAX_WRITE_ENTRIES);
        expect(new Set(entries.map((e) => e.header.schemaVersion))).toEqual(new Set([LOG_SCHEMA_VERSION]));
        const bodies = await Promise.all(entries.map((e) => openEntryBody(e, x.w.keys)));
        const body = new Uint8Array(bodies.reduce((n, p) => n + p.length, 0));
        bodies.reduce((at, p) => (body.set(p, at), at + p.length), 0);
        const set = await openChangeSet(body, LOG_SCHEMA_VERSION);
        const plain = encodeChangeSet(set).length;
        // Plain, the rows would need more parts than one write holds; compressed, they take a few.
        expect(Math.ceil(plain / MAX_PLAIN)).toBeGreaterThan(MAX_WRITE_ENTRIES);
        expect(body.length * 4).toBeLessThan(plain);

        // The other phone takes the entry: the same rows, every transaction, and it ran nothing.
        expect(await b.session.pull()).toMatchObject({ entries: entries.length });
        expect(differences(await rowsOf(a.engine), await rowsOf(b.engine))).toEqual([]);
        expect(
          await b.engine.db.prepare(`SELECT count(*) AS n FROM bank_txn WHERE removed_at IS NULL`).first(),
        ).toEqual({ n: TXNS });
      },
      { described: false },
    );
  });
});
