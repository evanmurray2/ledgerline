// Settings → Payees: the list, rename = merge (joining) with Undo, and the rename checks (docs/payees.md 5, 6).
import { app, phone } from './phone.js';
import { ownerDb } from './store-db.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MergeResult, PayeesView } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const view = async () => (await (await app('/api/settings/payees')).json()) as PayeesView;
const post = (p: string, body: unknown) => app(p, { method: 'POST', headers: H, body: JSON.stringify(body) });

describe('payees', () => {
  let a: PayeesView['payees'][number];
  let b: PayeesView['payees'][number];

  beforeAll(async () => {
    expect((await post('/__dev/seed-november', {})).status).toBe(200);
    const v = await view();
    a = v.payees[0]!;
    b = v.payees[1]!;
  });

  it('lists payees with budget transactions, their bank names, and counts', async () => {
    const v = await view();
    expect(v.payees.length).toBeGreaterThan(2);
    for (const p of v.payees) {
      expect(p.transactions).toBeGreaterThan(0);
      expect(p.bankNames.length).toBeGreaterThan(0);
      // Bank names count budget transactions only, not history before the budget start.
      if (p.bankNames.length < 10) expect(p.bankNames.reduce((t, x) => t + x.count, 0)).toBe(p.transactions);
    }
    expect(Array.isArray(v.others)).toBe(true);
  });

  it('refuses a join that isn’t two different payees', async () => {
    expect((await post('/api/settings/payees/merge', { keep: a!.id, ids: [a!.id, a!.id] })).status).toBe(422);
    expect((await post('/api/settings/payees/merge', { keep: 'nope', ids: ['nope', a!.id] })).status).toBe(
      409,
    );
  });

  it('refuses a rename to another payee’s name: that is a join', async () => {
    const r = await post(`/api/settings/payees/${b!.id}`, { name: ` ${a!.name.toUpperCase()} ` });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe('name_taken');
  });

  it('joins two payees and Undo puts them back', async () => {
    const r = await post('/api/settings/payees/merge', { keep: a!.id, ids: [a!.id, b!.id] });
    expect(r.status).toBe(200);
    const { undoId } = (await r.json()) as MergeResult;
    let v = await view();
    expect(v.payees.find((p) => p.id === b!.id)).toBeUndefined();
    expect(v.payees.find((p) => p.id === a!.id)!.transactions).toBe(a!.transactions + b!.transactions);
    // A rename queued for the joined payee is refused instead of renaming the one it joined.
    expect((await post(`/api/settings/payees/${b!.id}`, { name: 'Late rename' })).status).toBe(409);

    expect((await post(`/api/settings/payees/merge/${undoId}/undo`, {})).status).toBe(200);
    v = await view();
    expect(v.payees.find((p) => p.id === a!.id)).toMatchObject({
      name: a!.name,
      transactions: a!.transactions,
    });
    expect(v.payees.find((p) => p.id === b!.id)).toMatchObject({
      name: b!.name,
      transactions: b!.transactions,
    });
  });

  it('can’t undo a join once the payee changed since', async () => {
    const r = await post('/api/settings/payees/merge', { keep: a!.id, ids: [a!.id, b!.id] });
    const { undoId } = (await r.json()) as MergeResult;
    expect((await post(`/api/settings/payees/${a!.id}`, { name: 'Renamed after the join' })).status).toBe(
      200,
    );
    expect((await post(`/api/settings/payees/merge/${undoId}/undo`, {})).status).toBe(409);
  });

  it('a name you choose is yours: rename and the transaction sheet set named_by to user, on the phone too', async () => {
    const db = ownerDb();
    const namedBy = async (id: string) => {
      const q = `SELECT named_by FROM payee WHERE id = ?1`;
      const server = await db.prepare(q).bind(id).first<{ named_by: string }>();
      const copy = await (await phone()).db.prepare(q).bind(id).first<{ named_by: string }>();
      return [server?.named_by, copy?.named_by];
    };
    const c = (await view()).payees.find((p) => p.id !== a!.id && p.id !== b!.id)!;
    await db.prepare(`UPDATE payee SET named_by = 'sync' WHERE id IN (?1, ?2)`).bind(a!.id, c.id).run();
    expect((await post(`/api/settings/payees/${a!.id}`, { name: 'Chosen name' })).status).toBe(200);
    await view();
    expect(await namedBy(a!.id)).toEqual(['user', 'user']);
    const key = (await db
      .prepare(`SELECT key AS txn_key FROM v_transaction WHERE payee_id = ?1 AND date >= budget_from LIMIT 1`)
      .bind(c.id)
      .first<{ txn_key: string }>())!.txn_key;
    const r = await app(`/api/transactions/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ payeeName: 'Typed name' }),
    });
    expect(r.status, await r.clone().text()).toBe(200);
    await view();
    expect(await namedBy(c.id)).toEqual(['user', 'user']);
    // Both names you chose are now keys of their payees (docs/payee-names.md 4).
    const keys = await db
      .prepare(
        `SELECT pattern, payee_id FROM payee_alias WHERE pattern IN ('n:chosen name', 'n:typed name') ORDER BY pattern`,
      )
      .all<{ pattern: string; payee_id: string }>();
    expect(keys.results).toEqual([
      { pattern: 'n:chosen name', payee_id: a!.id },
      { pattern: 'n:typed name', payee_id: c.id },
    ]);
  });
});
