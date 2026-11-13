import type { SealedSession, Session } from '@ledgerline/contracts';
import { describe, expect, it } from 'vitest';
import { NOT_LOCKED, sessionFor, type SessionDeps } from '../src/copy/sealed-session';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const plain: Session = {
  user: { email: 'owner@example.com', login: null },
  budget: {
    id: BUDGET,
    name: 'Home',
    startMonth: '2026-01',
    timeZone: 'America/Chicago',
    currentMonth: '2026-11',
    today: '2026-11-12',
    setupStep: 'done',
  },
  settings: { tracking: true, noteButton: true },
  appVersion: '1.0.0',
  writeState: 'ok',
  readOnlyUntil: null,
  readsPaused: false,
  canLinkBanks: true,
  hostedLink: false,
} as Session;
const sealed: SealedSession = {
  sealed: true,
  user: { email: 'owner@example.com' },
  budgetId: BUDGET,
  appVersion: '2.0.0',
  writeState: 'readonly',
  readOnlyUntil: '2026-11-13T00:00:00.000Z',
  readsPaused: false,
  canLinkBanks: false,
};

const deps = (over: Partial<SessionDeps> = {}) => {
  const noted: SealedSession[] = [];
  const kept: Session[] = [];
  const d: SessionDeps = {
    ready: () => true,
    local: async () => ({ status: 200, body: JSON.stringify(plain) }),
    note: (s) => void noted.push(s),
    keep: async (s) => void kept.push(s),
    now: () => new Date('2026-11-12T10:00:00Z'),
    ...over,
  };
  return { d, noted, kept };
};

describe('the session of a sealed budget', () => {
  it('refuses an answer that says the budget is not locked: every budget is (D-102)', async () => {
    const { d, noted } = deps();
    await expect(sessionFor(plain, d)).rejects.toThrow(NOT_LOCKED);
    expect(noted).toEqual([]);
  });

  it('takes the mock API’s plain session as it is (dev and tests)', async () => {
    const { d, noted, kept } = deps({ mock: true });
    expect(await sessionFor(plain, d)).toBe(plain);
    expect(noted).toEqual([]);
    expect(kept).toEqual([]);
  });

  it('takes the budget from the copy and the account from the server, and keeps the result', async () => {
    const { d, noted, kept } = deps();
    const s = await sessionFor(sealed, d);
    expect(noted).toEqual([sealed]);
    expect(s.budget).toEqual(plain.budget);
    expect(s.settings).toEqual(plain.settings);
    expect(s).toMatchObject({
      appVersion: '2.0.0',
      writeState: 'readonly',
      readOnlyUntil: '2026-11-13T00:00:00.000Z',
      canLinkBanks: false,
    });
    expect(kept).toEqual([s]);
  });

  it('gives only what opens the copy while the copy is closed, or is of another budget', async () => {
    for (const over of [
      { ready: () => false },
      { local: async () => ({ status: 500, body: '{}' }) },
      {
        local: async () => ({
          status: 200,
          body: JSON.stringify({ ...plain, budget: { ...plain.budget, id: '01BX5ZZKBKACTAV9WEVGEMMVRZ' } }),
        }),
      },
    ] satisfies Partial<SessionDeps>[]) {
      const { d, kept } = deps(over);
      const s = await sessionFor(sealed, d);
      expect(s.budget).toMatchObject({ id: BUDGET, name: '', currentMonth: '2026-11', today: '2026-11-12' });
      expect(s.user.email).toBe('owner@example.com');
      expect(kept).toEqual([]);
    }
  });
});
