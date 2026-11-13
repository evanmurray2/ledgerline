// A device files a bank update itself (docs/privacy.md 5.4, phase 4): given the pages the bank sent, it ends with
// the rows the server has after filing the same update. The server here is the real pipeline (bank-sync.ts).
import { PlaidProvider } from '@ledgerline/bank-provider';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import { fileRun, type RunPackage } from '../src/local/file-run.js';
import { alignCounter } from '../src/local/shadow.js';
import type { BankLogBatch, SyncPage } from '../src/routes/sync.js';
import { endOfUpdate, type BankState } from '../src/sync/process.js';
import { bankSync, pend, plaidTxn } from './bank-sync.js';
import { storeDb } from './store-db.js';
import { differences, rowsOf } from './twin.js';

const B = 'b_filerun';
const C = 'c_filerun';
const NOW = Date.UTC(2026, 10, 8, 18, 0);
const h = bankSync('file-run', B, C, 2, NOW);
const provider = new PlaidProvider({ clientId: 'x', secret: 'y', env: 'sandbox' });

async function phone(name: string): Promise<LocalEngine> {
  const db = storeDb(name);
  await migrateLocal(db, NOW);
  return new LocalEngine(db, { budgetId: B, userId: 'phone', email: 'owner@example.com' }, () => NOW);
}
/** The phone takes what changed on the server (the tables it syncs). */
async function sync(e: LocalEngine): Promise<void> {
  for (let n = 0; ; n++) {
    if (n > 100) throw new Error('sync did not finish');
    const { since, cursor } = await e.nextRequest();
    const q = new URLSearchParams({ since: String(since), limit: '200' });
    if (cursor) q.set('cursor', cursor);
    const r = await h.call('GET', `/api/sync?${q}`);
    expect(r.status).toBe(200);
    if ((await e.apply(r.json as SyncPage)).caughtUp) return;
  }
}
async function bankLog(e: LocalEngine): Promise<void> {
  for (;;) {
    const { after, pagesAfter } = await e.bankLogRequest();
    const q = new URLSearchParams({ after: String(after) });
    if (pagesAfter) q.set('pagesAfter', pagesAfter);
    const r = await h.call('GET', `/api/sync/bank-log?${q}`);
    if ((await e.applyBankLog(r.json as BankLogBatch)).caughtUp) return;
  }
}
/** The newest update the server filed, as it was fetched. */
async function lastRun(): Promise<Omit<RunPackage, 'bank'>> {
  const run = (await h.db
    .prepare(`SELECT id, connection_id, fetched_at, fetch_seq FROM sync_run ORDER BY fetch_seq DESC LIMIT 1`)
    .first<{ id: string; connection_id: string; fetched_at: number; fetch_seq: number }>())!;
  const pages = (
    await h.db
      .prepare(
        `SELECT p.raw_key, r.body, p.next_cursor, p.has_more, p.sha256 FROM sync_page p JOIN raw_page r ON r.key = p.raw_key
         WHERE p.sync_run_id = ?1 ORDER BY p.page`,
      )
      .bind(run.id)
      .all<{ raw_key: string; body: string; next_cursor: string | null; has_more: number; sha256: string }>()
  ).results;
  return {
    runId: run.id,
    connectionId: run.connection_id,
    fetchedAt: run.fetched_at,
    fetchSeq: run.fetch_seq,
    pages: pages.map((p) => ({
      key: p.raw_key,
      body: p.body,
      nextCursor: p.next_cursor,
      hasMore: p.has_more === 1,
      sha256: p.sha256,
    })),
  };
}
const log = async (db: LocalEngine['db']) => ({
  events: (await db.prepare(`SELECT * FROM bank_event ORDER BY id`).all()).results,
  pages: (await db.prepare(`SELECT * FROM bank_page ORDER BY sync_run_id, page`).all()).results,
});

/**
 * The link's "updated" time is the one place a device and the server differ: the server's own end of an update
 * writes its step clock (in this test it never runs), the device the update's time (a sealed budget's only writer).
 */
const linkTimes = /^connection .*\.(last_synced_at|last_attempt_at):/;

describe('a device files a bank update', () => {
  it('ends with the server’s rows, update after update', async () => {
    await h.setup();
    const device = await phone('file-run-device');
    const reader = await phone('file-run-reader');
    await sync(device);

    const updates: [unknown[], { transaction_id: string; account_id: string }[]][] = [
      // New rows on two cards, with a pending one.
      [
        [
          plaidTxn('a-1', 1, 12.5, '2026-11-05', 'BLUE BOTTLE COFFEE'),
          plaidTxn('a-2', 2, 80, '2026-11-06', 'SHELL OIL'),
          pend('p-1', 1, 30, '2026-11-07', 'MARRIOTT'),
        ],
        [],
      ],
      // The pending row posts at another amount; the same shop again (its payee exists now).
      [
        [
          plaidTxn('a-3', 1, 34.2, '2026-11-08', 'MARRIOTT', { pending_transaction_id: 'p-1' }),
          plaidTxn('a-4', 1, 4.75, '2026-11-08', 'BLUE BOTTLE COFFEE'),
        ],
        [{ transaction_id: 'p-1', account_id: 'pa_1' }],
      ],
      // A removal only.
      [[], [{ transaction_id: 'a-2', account_id: 'pa_2' }]],
    ];
    let t = NOW;
    for (const [added, removed] of updates) {
      t += 3_600_000;
      h.setNow(t);
      await h.sync(added, removed, t);
      await h.heal();
      // What the bank says at the end of this update: a balance that moves, and a card statement.
      const bank: BankState = {
        accounts: [
          {
            providerAccountId: 'pa_1',
            currentBalance: 10_000 + (t % 977),
            availableBalance: null,
            creditLimit: 500_000,
          },
          { providerAccountId: 'pa_2', currentBalance: 8_000, availableBalance: null, creditLimit: null },
        ],
        liabilities: [
          {
            providerAccountId: 'pa_1',
            statementBalance: 4_200,
            statementDate: '2026-11-01',
            dueDate: '2026-11-25',
            minimumPayment: 2_500,
            aprBasisPoints: 2_199,
          },
        ],
      };
      await endOfUpdate(h.db, { budgetId: B, connectionId: C }, t, bank);
      // The device files the same update from its pages, on the copy it had before.
      const pkg = { ...(await lastRun()), bank };
      await fileRun({ ...env, DB: device.db } as never, B, pkg, provider);
      // A second phone only reads what the server filed.
      await sync(reader);
      await bankLog(reader);
      expect(
        differences(await rowsOf(device), await rowsOf(reader)).filter((d) => !linkTimes.test(d)),
      ).toEqual([]);
      expect(await log(device.db)).toEqual(await log(reader.db));
    }

    // A phone that only synced so far, as every phone today: it has no bank log and no event counter. It files the
    // next update once its counter continues from the budget's watermark (local/shadow.ts alignCounter), and
    // numbers the new bank events as the server does.
    const synced = await phone('file-run-synced');
    await sync(synced);
    expect((await log(synced.db)).events.length).toBe(0);
    t += 3_600_000;
    h.setNow(t);
    await h.sync([plaidTxn('a-9', 2, 19.99, '2026-11-09', 'SHELL OIL')], [], t);
    await h.heal();
    await alignCounter(synced.db, B);
    await fileRun({ ...env, DB: synced.db } as never, B, { ...(await lastRun()), bank: null }, provider);
    await sync(reader);
    expect(differences(await rowsOf(synced), await rowsOf(reader)).filter((d) => !linkTimes.test(d))).toEqual(
      [],
    );
    const mine = (await log(synced.db)).events as { id: number }[];
    const theirs = (await log(h.db)).events as { id: number }[];
    expect(mine.map((e) => e.id)).toEqual([theirs[theirs.length - 1]!.id]);
  });
});
