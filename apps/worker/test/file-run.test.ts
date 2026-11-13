// A device files a bank update itself (docs/privacy.md 5.4): given the pages the bank sent, it ends with the rows
// the steps of the old server pipeline give for the same update (bank-sync.ts), which are the steps it runs.
import { PlaidProvider } from '@ledgerline/bank-provider';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import { fileRun, type RunPackage } from '../src/local/file-run.js';
import { SYNC_FORMAT, SYNC_TABLES, type SyncRow } from '../src/sync-tables.js';
import { endOfUpdate, type BankState } from '../src/sync/process.js';
import { bankSync, pend, plaidTxn } from './bank-sync.js';
import { copyDb } from './store-db.js';
import { differences, rowsOf } from './twin.js';

const B = 'b_filerun';
const C = 'c_filerun';
const NOW = Date.UTC(2026, 10, 8, 18, 0);
const h = bankSync('file-run', B, C, 2, NOW);
const provider = new PlaidProvider({ clientId: 'x', secret: 'y', env: 'sandbox' });

async function phone(name: string): Promise<LocalEngine> {
  const db = copyDb(name);
  await migrateLocal(db, NOW);
  return new LocalEngine(db, { budgetId: B, userId: 'phone', email: 'owner@example.com' }, () => NOW);
}
/** A copy that holds what the pipeline's budget holds now: every row of the tables a copy keeps. */
async function copyOf(e: LocalEngine): Promise<void> {
  const rows: SyncRow[] = [];
  for (const t of SYNC_TABLES) {
    const all = (await h.db.prepare(`SELECT * FROM ${t.name}`).all<Record<string, unknown>>()).results;
    for (const r of all) {
      const d = Object.fromEntries(Object.entries(r).filter(([c]) => !t.omit?.includes(c)));
      rows.push({ t: t.name, k: t.pk.map((c) => r[c]), d });
    }
  }
  const at = (await e.state()).through + 1;
  await e.apply({
    format: SYNC_FORMAT,
    epoch: 'test',
    serverTime: NOW,
    through: at,
    more: false,
    cursor: null,
    rows,
  });
}
/** The pipeline's own budget, read as a copy is. */
const pipeline = () => new LocalEngine(h.db, { budgetId: B, userId: 'pipeline', email: 'owner@example.com' });
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
  it('ends with the pipeline’s rows, update after update', async () => {
    await h.setup();
    const device = await phone('file-run-device');
    await copyOf(device);

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
      expect(
        differences(await rowsOf(device), await rowsOf(pipeline())).filter((d) => !linkTimes.test(d)),
      ).toEqual([]);
      expect(await log(device.db)).toEqual(await log(h.db));
    }

    // A copy that holds the budget but no bank log and no event counter, as a copy made before the log carried
    // it: it files the next update once its counter continues from the budget's watermark (sealed-filing.ts), and
    // numbers the new bank events as the pipeline does.
    const synced = await phone('file-run-synced');
    await copyOf(synced);
    expect((await log(synced.db)).events.length).toBe(0);
    t += 3_600_000;
    h.setNow(t);
    await h.sync([plaidTxn('a-9', 2, 19.99, '2026-11-09', 'SHELL OIL')], [], t);
    await h.heal();
    await synced.db.batch([
      synced.db.prepare(`INSERT OR IGNORE INTO apply_counter (id, seq) VALUES (1, 0)`),
      synced.db
        .prepare(
          `UPDATE apply_counter SET seq = max(seq, coalesce((SELECT processed_through FROM budget WHERE id = ?1), 0)) WHERE id = 1`,
        )
        .bind(B),
    ]);
    await fileRun({ ...env, DB: synced.db } as never, B, { ...(await lastRun()), bank: null }, provider);
    expect(
      differences(await rowsOf(synced), await rowsOf(pipeline())).filter((d) => !linkTimes.test(d)),
    ).toEqual([]);
    const mine = (await log(synced.db)).events as { id: number }[];
    const theirs = (await log(h.db)).events as { id: number }[];
    expect(mine.map((e) => e.id)).toEqual([theirs[theirs.length - 1]!.id]);
  });
});
