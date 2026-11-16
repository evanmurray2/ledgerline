// A split line takes only a category a whole row could take (routes/transactions.ts): one that exists and is no
// card's payment category. Found by the two-devices hunt (docs/hunts.md): a line took any id, and its money then
// counted in no category.
import { expect, it } from 'vitest';
import { newCopy, seed } from './phone.js';

it('a split line with no such category, or a card payment category, is refused like a whole row', async () => {
  const e = await seed(await newCopy());
  const t = (await e.db
    .prepare(
      `SELECT txn_key, amount FROM bank_txn WHERE removed_at IS NULL AND pending = 0 AND amount < -200 ORDER BY txn_key LIMIT 1`,
    )
    .first<{ txn_key: string; amount: number }>())!;
  const cat = (await e.db
    .prepare(`SELECT id FROM category WHERE kind = 'spending' ORDER BY id LIMIT 1`)
    .first<{ id: string }>())!.id;
  const card = (await e.db
    .prepare(`SELECT id FROM category WHERE kind = 'cc_payment' ORDER BY id LIMIT 1`)
    .first<{ id: string }>())!.id;
  const path = `/api/transactions/${encodeURIComponent(t.txn_key)}`;
  const half = Math.trunc(t.amount / 2);
  const split = (other: string) => ({
    split: [
      { categoryId: cat, amount: half, memo: null, absorbsRemainder: false },
      { categoryId: other, amount: t.amount - half, memo: null, absorbsRemainder: true },
    ],
  });
  for (const bad of ['no-such-category', card]) {
    expect((await e.request('PATCH', path, { categoryId: bad })).status, `whole row, ${bad}`).toBe(404);
    expect((await e.request('PATCH', path, split(bad))).status, `split line, ${bad}`).toBe(404);
  }
  expect(
    (await e.db
      .prepare(`SELECT count(*) AS n FROM txn_split WHERE txn_key = ?1`)
      .bind(t.txn_key)
      .first<{ n: number }>())!.n,
  ).toBe(0);
  // A split into two real categories still goes through.
  const other = (await e.db
    .prepare(`SELECT id FROM category WHERE kind = 'spending' AND id != ?1 ORDER BY id LIMIT 1`)
    .bind(cat)
    .first<{ id: string }>())!.id;
  expect((await e.request('PATCH', path, split(other))).status).toBe(200);
});
