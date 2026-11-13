// "Which account got this money?" accepts every row the sheet offers: a deposit that came in a later sync, and a
// pick made from the deposit's side. A lone deposit that comes later pairs by itself (D-90).
import { beforeAll, describe, expect, it } from 'vitest';
import { bankSync, plaidTxn } from './bank-sync.js';

const NOW = Date.parse('2026-11-14T20:00:00Z');
const { db, setup, sync, keyOf, overlay, call } = bankSync('transfer-pick', 'b_tp', 'con_tp', 3, NOW);
const pick = (key: string, body: unknown) =>
  call('POST', `/api/transfers/${encodeURIComponent(key)}/pick`, body);
const link = (from: string) =>
  db
    .prepare(
      `SELECT from_key, to_key FROM txn_link WHERE kind = 'transfer' AND from_key = ?1 AND undone_at IS NULL`,
    )
    .bind(from)
    .first<{ from_key: string; to_key: string }>();

describe('Pick the other side of a transfer', () => {
  beforeAll(setup);

  it('a deposit that came in a later sync pairs by itself (D-90); a pair is not offered again', async () => {
    await sync([plaidTxn('out1', 1, 250, '2026-11-10', 'ONLINE TRANSFER TO SAVINGS')]);
    const out = await keyOf('out1');
    expect((await overlay(out))?.transfer_state).toBe('unsorted');
    await sync([plaidTxn('in1', 2, -250, '2026-11-11', 'DEPOSIT')]);
    const dep = await keyOf('in1');
    expect(await overlay(out)).toMatchObject({ transfer_state: 'paired', transfer_account_id: 'a_2' });
    expect(await overlay(dep)).toMatchObject({ transfer_state: 'paired', transfer_account_id: 'a_1' });
    // Nothing is left to pick.
    expect((await pick(out, { otherKey: dep })).status).toBe(422);
    // Already a transfer: it isn't offered again, and a later outflow of the same amount doesn't break the pair.
    await sync([plaidTxn('out1b', 3, 250, '2026-11-11', 'ONLINE TRANSFER TO SAVINGS')]);
    expect((await overlay(await keyOf('out1b')))?.transfer_state).toBe('unsorted');
    expect((await pick(await keyOf('out1b'), { otherKey: dep })).status).toBe(404);
    expect(await overlay(dep)).toMatchObject({ transfer_state: 'paired', transfer_account_id: 'a_1' });
  });

  it('pairs by hand a deposit that came in a later sync, when there were two to choose from', async () => {
    await sync([plaidTxn('out0', 1, 610, '2026-11-10', 'ONLINE TRANSFER TO SAVINGS')]);
    const out = await keyOf('out0');
    await sync([
      plaidTxn('in0a', 2, -610, '2026-11-11', 'DEPOSIT'),
      plaidTxn('in0b', 3, -610, '2026-11-11', 'DEPOSIT'),
    ]);
    const [a, b] = [await keyOf('in0a'), await keyOf('in0b')];
    for (const k of [out, a, b]) expect((await overlay(k))?.transfer_state, k).toBe('unsorted');
    // The sheet lists both deposits as the other side, each waiting for this answer too.
    const sheet = await call('GET', `/api/transactions/${encodeURIComponent(out)}`);
    const offered = (sheet.json as { candidates?: { key: string; accountId: string; sheet: string }[] })
      .candidates;
    expect(offered?.map((x) => x.key).sort()).toEqual([a, b].sort());
    expect(offered?.map((x) => x.sheet)).toEqual(['transfer', 'transfer']);
    const r = await pick(out, { otherKey: a });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await overlay(out)).toMatchObject({ transfer_state: 'paired', transfer_account_id: 'a_2' });
    expect(await overlay(a)).toMatchObject({ transfer_state: 'paired', transfer_account_id: 'a_1' });
    expect(await link(out)).toEqual({ from_key: out, to_key: a });
    // A pair has no other side to pick.
    const after = await call('GET', `/api/transactions/${encodeURIComponent(out)}`);
    expect((after.json as { candidates?: unknown }).candidates).toBeUndefined();
  });

  it('pairs from the deposit’s side; the other deposit counts as income', async () => {
    await sync([
      plaidTxn('out2', 1, 80, '2026-11-12', 'TRANSFER TO CARD'),
      plaidTxn('in2a', 2, -80, '2026-11-12', 'PAYMENT RECEIVED'),
      plaidTxn('in2b', 3, -80, '2026-11-13', 'PAYMENT RECEIVED'),
    ]);
    const [out, a, b] = [await keyOf('out2'), await keyOf('in2a'), await keyOf('in2b')];
    for (const k of [out, a, b]) expect((await overlay(k))?.transfer_state, k).toBe('unsorted');

    const r = await pick(a, { otherKey: out });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await overlay(a)).toMatchObject({ transfer_state: 'paired', transfer_account_id: 'a_1' });
    expect(await overlay(out)).toMatchObject({ transfer_state: 'paired', transfer_account_id: 'a_2' });
    expect(await link(out)).toEqual({ from_key: out, to_key: a });
    expect(await overlay(b)).toMatchObject({ transfer_state: null, to_rta: 1 });
  });

  it('a deposit from an account that isn’t linked', async () => {
    await sync([
      plaidTxn('out3', 1, 40, '2026-11-13', 'TRANSFER TO CARD'),
      plaidTxn('in3a', 2, -40, '2026-11-13', 'PAYMENT RECEIVED'),
      plaidTxn('in3b', 3, -40, '2026-11-13', 'PAYMENT RECEIVED'),
    ]);
    const b = await keyOf('in3b');
    expect((await pick(b, { otherKey: null, unlinked: true })).status).toBe(200);
    expect((await overlay(b))?.transfer_state).toBe('manual');
    // The outflow still waits for its answer.
    expect((await overlay(await keyOf('out3')))?.transfer_state).toBe('unsorted');
  });
});
