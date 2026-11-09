// An amount too large to add up safely is refused: two assignments of $90 trillion made the phone's budget throw
// ("Couldn't open your budget") on every device, since the server kept them.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BudgetView } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const call = (method: string, p: string, body: unknown) =>
  app(p, { method, headers: H, body: JSON.stringify(body) });

describe('Amount limit on assignments, moves and targets', () => {
  beforeAll(async () => {
    expect((await call('POST', '/__dev/seed-november', {})).status).toBe(200);
  });

  it('refuses more than $99,999,999.99 and says the limit', async () => {
    const huge = 9_000_000_000_000_000;
    for (const [method, p, body] of [
      ['POST', '/api/budget/set', { month: '2026-11', categoryId: 'groceries', assigned: huge }],
      ['POST', '/api/budget/set', { month: '2026-11', categoryId: 'groceries', assigned: -10_000_000_000 }],
      ['POST', '/api/budget/assign', { month: '2026-11', items: [{ categoryId: 'dining', amount: huge }] }],
      ['POST', '/api/budget/move', { month: '2026-11', from: 'rta', to: 'dining', amount: 10_000_000_000 }],
      [
        'PUT',
        '/api/categories/gifts/target',
        { categoryId: 'gifts', month: '2026-11', target: { type: 'set_aside', amount: huge } },
      ],
      [
        'PUT',
        '/api/categories/gifts/target',
        {
          categoryId: 'gifts',
          month: '2026-11',
          target: { type: 'no_date', amount: 100, monthly: 10_000_000_000 },
        },
      ],
    ] as const) {
      const r = await call(method, p, body);
      expect(r.status, p).toBe(422);
      expect(((await r.json()) as { message: string }).message).toBe('Enter an amount up to $99,999,999.99.');
    }
    const b = (await (await app('/api/budget/2026-11')).json()) as BudgetView;
    expect(b.rta).toBe(98190);
  });

  it('takes $99,999,999.99 exactly', async () => {
    const r = await call('POST', '/api/budget/set', {
      month: '2026-11',
      categoryId: 'groceries',
      assigned: 9_999_999_999,
    });
    expect(r.status).toBe(200);
    const b = (await (await app('/api/budget/2026-11')).json()) as BudgetView;
    expect(b.rta).toBe(98190 + 60000 - 9_999_999_999);
  });
});
