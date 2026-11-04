// The mock API (VITE_MOCK=1, used by the mock e2e suite) runs the real engine; it must still answer every screen in
// the shape the real Worker does: both are checked against the same list (packages/contracts/src/screens.ts; the Worker side is
// apps/worker/test/screens.test.ts).
import { describe, expect, it } from 'vitest';
import { AccountsView, ActivityView, BudgetView } from '@ledgerline/contracts';
import { SCREENS, fillScreen, screenIds } from '@ledgerline/contracts/screens';
import { MockServer, type Scenario } from '../src/mock/server';
import { novemberCopy } from '../../worker/src/local/november-copy';

const SCENARIOS: Scenario[] = ['default', 'firstrun', 'empty', 'readonly', 'syncfail', 'newmonth'];

describe('mock API matches the contracts', () => {
  for (const scenario of SCENARIOS)
    it(`every screen, scenario ${scenario}`, async () => {
      const server = new MockServer(scenario, (now) => novemberCopy(now));
      const get = async (path: string) => {
        const r = await server.handle('GET', path, {}, undefined);
        expect(r.status, path).toBe(200);
        return r.body;
      };
      const month = BudgetView.parse(await get('/api/budget/2026-11')).currentMonth;
      const ids = screenIds(
        month,
        BudgetView.parse(await get(`/api/budget/${month}`)),
        ActivityView.parse(await get('/api/activity')),
        AccountsView.parse(await get('/api/accounts')),
      );
      let checked = 0;
      for (const s of SCREENS) {
        const path = fillScreen(s.path, ids);
        if (!path) continue;
        const r = s.schema.safeParse(await get(path));
        expect(
          r.success,
          `${path}: ${r.error?.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        ).toBe(true);
        checked++;
      }
      expect(checked).toBeGreaterThanOrEqual(SCREENS.length - 4);
    });
});
