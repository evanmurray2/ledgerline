// The bank log on a device (docs/privacy.md 5.4): the server sends `bank_event` and `bank_page` in batches, after
// the newest row the device holds, and the device's log ends equal to the server's. The log is append-only on
// both sides.
import { describe, expect, it } from 'vitest';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import type { BankLogBatch } from '../src/routes/sync.js';
import { bankSync, plaidTxn } from './bank-sync.js';
import { storeDb } from './store-db.js';

const B = 'b_banklog';
const NOW = Date.UTC(2026, 10, 8, 18, 0);
const h = bankSync('bank-log', B, 'c_banklog', 2, NOW);

async function phone(name: string): Promise<LocalEngine> {
  const db = storeDb(name);
  await migrateLocal(db, NOW);
  return new LocalEngine(db, { budgetId: B, userId: 'phone', email: 'owner@example.com' });
}

/** Downloads the bank log until the server has no more; gives how many requests it took. */
async function pull(e: LocalEngine): Promise<number> {
  for (let n = 1; ; n++) {
    if (n > 50) throw new Error('the bank log did not finish');
    const { after, pagesAfter } = await e.bankLogRequest();
    const q = new URLSearchParams({ after: String(after) });
    if (pagesAfter) q.set('pagesAfter', pagesAfter);
    const r = await h.call('GET', `/api/sync/bank-log?${q}`);
    expect(r.status).toBe(200);
    if ((await e.applyBankLog(r.json as BankLogBatch)).caughtUp) return n;
  }
}

const log = async (db: { prepare: LocalEngine['db']['prepare'] }) => ({
  events: (await db.prepare(`SELECT * FROM bank_event ORDER BY id`).all()).results,
  pages: (await db.prepare(`SELECT * FROM bank_page ORDER BY sync_run_id, page`).all()).results,
});

describe('the bank log on a device', () => {
  it('downloads whole, in batches, and then only what is new', async () => {
    await h.setup();
    // Three bank updates: 130 rows, then 5, then a removal.
    await h.sync(
      Array.from({ length: 130 }, (_, i) =>
        plaidTxn(`t-${i}`, 1 + (i % 2), 100 + i, '2026-11-05', `SHOP ${i}`),
      ),
    );
    await h.sync(
      Array.from({ length: 5 }, (_, i) => plaidTxn(`u-${i}`, 1, 7 + i, '2026-11-06', `CAFE ${i}`)),
    );
    await h.sync([], [{ transaction_id: 't-3', account_id: 'pa_2' }]);

    const server = await log(h.db);
    expect(server.events.length).toBe(136);
    expect(server.pages.length).toBeGreaterThanOrEqual(3);

    const a = await phone('bank-log-phone-a');
    // 136 events at 100 a batch: two requests.
    expect(await pull(a)).toBe(2);
    expect(await log(a.db)).toEqual(server);

    // Nothing new: one request, nothing added. A new bank update: only its rows come.
    expect(await pull(a)).toBe(1);
    await h.sync([plaidTxn('v-0', 2, 42, '2026-11-07', 'LATE ROW')]);
    const { after } = await a.bankLogRequest();
    const next = (await h.call('GET', `/api/sync/bank-log?after=${after}`)).json as BankLogBatch;
    expect(next.events.length).toBe(1);
    expect(await pull(a)).toBe(1);
    expect(await log(a.db)).toEqual(await log(h.db));

    // A batch that arrives twice changes nothing, and the copy's log can't be changed or deleted.
    await a.applyBankLog(next);
    expect(await log(a.db)).toEqual(await log(h.db));
    await expect(a.db.prepare(`DELETE FROM bank_event`).run()).rejects.toThrow(/append-only/);
    await expect(a.db.prepare(`UPDATE bank_page SET bytes = 0`).run()).rejects.toThrow(/append-only/);
  });

  it('refuses a cursor that is not one', async () => {
    expect((await h.call('GET', '/api/sync/bank-log?after=-1')).status).toBe(400);
    expect((await h.call('GET', '/api/sync/bank-log?after=0&pagesAfter=nonsense')).status).toBe(400);
  });
});
