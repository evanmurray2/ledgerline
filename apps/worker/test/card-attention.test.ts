// Budget's Needs attention lists a Short card with a Fund fix for the card debt no category will cover.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BudgetView } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const post = (p: string, body: unknown) => app(p, { method: 'POST', headers: H, body: JSON.stringify(body) });
const budget = async () => (await (await app('/api/budget/2026-11')).json()) as BudgetView;

describe('Needs attention: card payments', () => {
  beforeAll(async () => {
    expect((await post('/__dev/seed-november', {})).status).toBe(200);
  });

  it('a Short card gets a Fund fix, and funding it clears the item', async () => {
    const before = await budget();
    const sapphire = before.cards.find((c) => c.name === 'Sapphire Preferred')!;
    expect(sapphire.status).toBe('covered');
    expect(before.attention.some((a) => a.key === `card:${sapphire.accountId}`)).toBe(false);

    // Take $100 back from the card's payment category: now $100 of card debt has no money set aside.
    const back = await post('/api/budget/move', {
      month: '2026-11',
      from: sapphire.categoryId,
      to: 'rta',
      amount: 10_000,
    });
    expect(back.status).toBe(200);
    const short = await budget();
    expect(short.cards.find((c) => c.accountId === sapphire.accountId)).toMatchObject({
      status: 'short',
      short: 10_000,
    });
    const item = short.attention.find((a) => a.key === `card:${sapphire.accountId}`)!;
    expect(item).toMatchObject({
      section: 'Card payments',
      categoryId: sapphire.categoryId,
      accountId: sapphire.accountId,
      link: 'card',
      fix: { verb: 'Fund', amount: 10_000 },
    });

    // The Fund button assigns its amount to the payment category, as every other fix does.
    const fund = await post('/api/budget/assign', {
      month: '2026-11',
      items: [{ categoryId: item.categoryId, amount: item.fix!.amount }],
    });
    expect(fund.status).toBe(200);
    const after = await budget();
    expect(after.cards.find((c) => c.accountId === sapphire.accountId)!.status).toBe('covered');
    expect(after.attention.some((a) => a.key === `card:${sapphire.accountId}`)).toBe(false);
    expect(after.rta).toBe(before.rta);
  });
});
