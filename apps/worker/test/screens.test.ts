// The real Worker answers every screen in the shape the app expects, on the seeded November budget. The web app's
// mock API is checked against the same list (packages/contracts/src/screens.ts, apps/web/test/mock-contract.test.ts).
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { AccountsView, ActivityView, BudgetView } from '@ledgerline/contracts';
import { SCREENS, fillScreen, screenIds } from '@ledgerline/contracts/screens';

const get = async (path: string) => {
  const r = await app(path);
  expect(r.status, path).toBe(200);
  return r.json();
};

describe('Worker answers match the contracts', () => {
  beforeAll(async () => {
    const r = await app('/__dev/seed-november', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ledgerline': '1' },
      body: '{}',
    });
    expect(r.status).toBe(200);
  });

  it('every screen', async () => {
    const month = BudgetView.parse(await get('/api/budget/2026-11')).currentMonth;
    const ids = screenIds(
      month,
      BudgetView.parse(await get(`/api/budget/${month}`)),
      ActivityView.parse(await get('/api/activity')),
      AccountsView.parse(await get('/api/accounts')),
    );
    for (const s of SCREENS) {
      const path = fillScreen(s.path, ids);
      expect(path, s.path).not.toBeNull();
      const r = s.schema.safeParse(await get(path!));
      expect(
        r.success,
        `${path}: ${r.error?.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      ).toBe(true);
    }
  });
});
