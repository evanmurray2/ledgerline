// Budget → Needs attention's bank warning (screens/DeviceAttention.tsx): a link with no complete fetch for a day.
import { describe, expect, it } from 'vitest';
import { BANK_BEHIND_MS, banksBehind } from '../src/screens/DeviceAttention';

const now = Date.UTC(2026, 10, 13, 12);
const link = (over: Partial<Parameters<typeof banksBehind>[0][number]>) => ({
  id: 'c1',
  institution: 'Bank',
  accounts: '',
  status: 'ok' as const,
  lastSynced: now - 3_600_000,
  linkedAt: now - 30 * 86_400_000,
  setupDone: true,
  ...over,
});

describe('banks behind', () => {
  it('names a link whose last fetch is more than a day old', () => {
    expect(banksBehind([link({ lastSynced: now - BANK_BEHIND_MS - 1 })], now)).toHaveLength(1);
    expect(banksBehind([link({ status: 'error', lastSynced: now - BANK_BEHIND_MS - 1 })], now)).toHaveLength(
      1,
    );
  });

  it('leaves out a fresh link, a removed one, one that needs a sign-in, and one still being set up', () => {
    const old = now - BANK_BEHIND_MS - 1;
    expect(
      banksBehind(
        [
          link({}),
          link({ status: 'removed', lastSynced: old }),
          link({ status: 'login_required', lastSynced: old }),
          link({ setupDone: false, lastSynced: old }),
        ],
        now,
      ),
    ).toEqual([]);
  });

  it('counts a link that never fetched from when it was linked', () => {
    expect(banksBehind([link({ lastSynced: null, linkedAt: now - 3_600_000 })], now)).toEqual([]);
    expect(banksBehind([link({ lastSynced: null, linkedAt: now - BANK_BEHIND_MS - 1 })], now)).toHaveLength(
      1,
    );
  });
});
