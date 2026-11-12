// The rest of the budget (GET /api/sync/rest; LocalEngine.applyRest): the undo record and the moved keys, which a
// sync never sends, reach a phone whole, and again after later edits.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { RowsRefused, type LocalEngine } from '../src/local/engine.js';
import type { RestBatch } from '../src/routes/sync.js';
import { syncPhone } from './phone.js';
import { ownerDb } from './store-db.js';
import { newPhone } from './twin.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
const post = (path: string, body: unknown) =>
  SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

/** The phone reads the rest to its end; gives how many requests it took. */
async function rest(e: LocalEngine): Promise<number> {
  for (let n = 1; ; n++) {
    if (n > 500) throw new Error('the rest did not end');
    const ask = await e.restRequest();
    if (!ask) return n - 1;
    const q = new URLSearchParams({ table: ask.table });
    if (ask.after !== null) q.set('after', String(ask.after));
    const r = await SELF.fetch(`${ORIGIN}/api/sync/rest?${q}`);
    expect(r.status).toBe(200);
    await e.applyRest((await r.json()) as RestBatch);
  }
}
const audit = async (db: { prepare: LocalEngine['db']['prepare'] }) =>
  JSON.stringify((await db.prepare(`SELECT * FROM audit_log ORDER BY id`).all()).results);

describe('the rest of the budget', () => {
  beforeAll(async () => {
    expect((await post('/__dev/seed-november', {})).status).toBe(200);
  });

  it('reaches a phone whole, and again after later edits', async () => {
    // Edits on the server leave undo records.
    for (let i = 1; i <= 5; i++)
      expect(
        (await post('/api/budget/assign', { month: '2026-11', items: [{ categoryId: 'rent', amount: i }] }))
          .status,
      ).toBe(200);
    const server = ownerDb();
    const count = async () =>
      (await server.prepare(`SELECT count(*) AS n FROM audit_log`).first<{ n: number }>())!.n;
    expect(await count()).toBeGreaterThanOrEqual(5);

    const phone = await syncPhone(await newPhone());
    expect(await audit(phone.db)).toBe('[]');
    expect(await rest(phone)).toBeGreaterThanOrEqual(2);
    expect(await audit(phone.db)).toBe(await audit(server));
    expect(await phone.restRequest()).toBeNull();

    // Later edits: read on from where each table ended.
    expect(
      (await post('/api/budget/assign', { month: '2026-11', items: [{ categoryId: 'rent', amount: 9 }] }))
        .status,
    ).toBe(200);
    await phone.restAgain();
    await rest(phone);
    expect(await audit(phone.db)).toBe(await audit(server));
    // Read twice from the start, the rows are the same rows.
    const again = await syncPhone(await newPhone());
    await rest(again);
    await again.restAgain();
    await rest(again);
    expect(await audit(again.db)).toBe(await audit(server));
  });

  it('the moved keys are read whole each time: a row replaced or deleted on the server is so on the phone', async () => {
    const server = ownerDb();
    const moves = async (db: { prepare: LocalEngine['db']['prepare'] }) =>
      JSON.stringify((await db.prepare(`SELECT * FROM txn_key_move ORDER BY old_key`).all()).results);
    const put = (old: string, to: string) =>
      server
        .prepare(`INSERT OR REPLACE INTO txn_key_move (old_key, new_key, at) VALUES (?1, ?2, 5)`)
        .bind(old, to)
        .run();
    await put('k', 'k2');
    await put('m', 'm2');
    const phone = await syncPhone(await newPhone());
    await rest(phone);
    expect(await moves(phone.db)).toBe(await moves(server));
    // A new row with a lower key, a replaced row, a deleted row.
    await put('a', 'a2');
    await put('m', 'm3');
    await server.prepare(`DELETE FROM txn_key_move WHERE old_key = 'k'`).run();
    await phone.restAgain();
    await rest(phone);
    expect(await moves(phone.db)).toBe(await moves(server));
    // A copy that is thrown away and downloaded again holds nothing of the old rest.
    await phone.clear();
    expect(await moves(phone.db)).toBe('[]');
    expect(await audit(phone.db)).toBe('[]');
    await syncPhone(phone);
    await rest(phone);
    expect(await moves(phone.db)).toBe(await moves(server));
    expect(await audit(phone.db)).toBe(await audit(server));
    // A batch that says "more" and brings nothing is refused.
    await expect(
      phone.applyRest({ table: 'audit_log', rows: [], after: 1, more: true }),
    ).rejects.toBeInstanceOf(RowsRefused);
  });

  it('refuses a table that is not part of the rest, and rows that are not that table’s', async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/sync/rest?table=bank_txn`)).status).toBe(400);
    expect((await SELF.fetch(`${ORIGIN}/api/sync/rest?table=audit_log&after=x`)).status).toBe(400);
    expect((await SELF.fetch(`${ORIGIN}/api/sync/rest`)).status).toBe(400);
    const phone = await newPhone();
    await expect(
      phone.applyRest({ table: 'bank_txn', rows: [], after: null, more: false }),
    ).rejects.toBeInstanceOf(RowsRefused);
    await expect(
      phone.applyRest({
        table: 'audit_log',
        rows: [{ t: 'txn_key_move', k: ['a'], d: { old_key: 'a', new_key: 'b', at: 1 } }],
        after: 1,
        more: false,
      }),
    ).rejects.toBeInstanceOf(RowsRefused);
    await expect(
      phone.applyRest({
        table: 'audit_log',
        rows: [{ t: 'audit_log', k: [1], d: { id: 1, 'x; DROP TABLE budget': 1 } }],
        after: 1,
        more: false,
      }),
    ).rejects.toBeInstanceOf(RowsRefused);
  });
});
