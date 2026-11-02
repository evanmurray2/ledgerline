// The mock API (VITE_MOCK=1, used by the mock e2e suite) must answer every screen in the shape the real Worker
// does: both are checked against the same list (packages/contracts/src/screens.ts; the Worker side is
// apps/worker/test/screens.test.ts).
import { describe, expect, it } from 'vitest';
import { AccountsView, ActivityView, BudgetView } from '@ledgerline/contracts';
import { SCREENS, fillScreen, screenIds } from '@ledgerline/contracts/screens';
import { MockServer } from '../src/mock/server';
import type { Scenario } from '../src/mock/db';

const SCENARIOS: Scenario[] = ['default', 'firstrun', 'empty', 'readonly', 'syncfail', 'newmonth'];

describe('mock API matches the contracts', () => {
  for (const scenario of SCENARIOS)
    it(`every screen, scenario ${scenario}`, () => {
      const server = new MockServer(scenario);
      const get = (path: string) => {
        const r = server.handle('GET', path, {}, undefined);
        expect(r.status, path).toBe(200);
        return r.body;
      };
      const month = BudgetView.parse(get('/api/budget/2026-11')).currentMonth;
      const ids = screenIds(
        month,
        BudgetView.parse(get(`/api/budget/${month}`)),
        ActivityView.parse(get('/api/activity')),
        AccountsView.parse(get('/api/accounts')),
      );
      let checked = 0;
      for (const s of SCREENS) {
        const path = fillScreen(s.path, ids);
        if (!path) continue;
        const r = s.schema.safeParse(get(path));
        expect(
          r.success,
          `${path}: ${r.error?.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        ).toBe(true);
        checked++;
      }
      expect(checked).toBeGreaterThanOrEqual(SCREENS.length - 4);
    });
});
