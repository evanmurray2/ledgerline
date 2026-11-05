import { describe, expect, it } from 'vitest';
import { FIRST_SYNC_MS, SETTLE_DAYS, startRole, type LinkInfo } from '../src/budget/start.js';

const H = 60 * 60 * 1000;
const D = 24 * H;
const LINK = Date.UTC(2026, 10, 1, 18, 0);
const link: LinkInfo = { linkedAt: LINK, firstSeen: LINK + 60_000 };
const FROM = '2026-11-01';
const row = (o: Partial<Parameters<typeof startRole>[0]>) => ({
  source: 'bank' as const,
  status: 'posted' as const,
  date: '2026-10-31',
  firstSeenAt: LINK + 60_000,
  pendingAtLink: false,
  ...o,
});

describe('startRole (D-?)', () => {
  it('a row posted before the link, in the first sync, is history', () => {
    expect(startRole(row({}), FROM, link)).toBeNull();
    expect(startRole(row({ firstSeenAt: link.firstSeen! + FIRST_SYNC_MS }), FROM, link)).toBeNull();
  });

  it('a row pending at link, or pending now, joins the starting balance', () => {
    expect(startRole(row({ pendingAtLink: true, firstSeenAt: LINK + 30 * D }), FROM, link)).toBe('before');
    expect(startRole(row({ status: 'pending', date: '2026-09-01' }), FROM, link)).toBe('before');
  });

  it('a posted row from before the start that arrives after the first sync joins it while settling', () => {
    expect(startRole(row({ firstSeenAt: LINK + 3 * D }), FROM, link)).toBe('before');
    expect(startRole(row({ firstSeenAt: LINK + SETTLE_DAYS * D }), FROM, link)).toBe('before');
    // After settling, or older than the window (Plaid's late history): history, and the bank difference shows it.
    expect(startRole(row({ firstSeenAt: LINK + SETTLE_DAYS * D + 1 }), FROM, link)).toBeNull();
    expect(startRole(row({ firstSeenAt: LINK + 3 * D, date: '2026-10-18' }), FROM, link)).toBe('before');
    expect(startRole(row({ firstSeenAt: LINK + 3 * D, date: '2026-10-17' }), FROM, link)).toBeNull();
  });

  it('a first-sync row dated on or after the start is a link-day row; later rows are plain budget rows', () => {
    expect(startRole(row({ date: FROM }), FROM, link)).toBe('linkDay');
    expect(startRole(row({ date: FROM, firstSeenAt: LINK + 2 * H }), FROM, link)).toBeNull();
    expect(startRole(row({ date: FROM, status: 'pending' }), FROM, link)).toBeNull();
    // A first sync hours after the link can't show what the balance at link held.
    const slow: LinkInfo = { linkedAt: LINK, firstSeen: LINK + 2 * H };
    expect(startRole(row({ date: FROM, firstSeenAt: LINK + 2 * H }), FROM, slow)).toBeNull();
  });

  it('CSV and manual rows, and a connection with no rows yet, have no role unless pending', () => {
    expect(startRole(row({ firstSeenAt: LINK + 3 * D }), FROM, null)).toBeNull();
    expect(startRole(row({ source: 'manual', status: 'pending' }), FROM, link)).toBeNull();
    expect(startRole(row({ date: FROM }), FROM, { linkedAt: LINK, firstSeen: null })).toBeNull();
  });

  it('a row that arrived before a later save of the balance (Setup) is in that balance', () => {
    const saved: LinkInfo = { ...link, balanceAt: LINK + 5 * H };
    expect(startRole(row({ firstSeenAt: LINK + 4 * H }), FROM, saved)).toBeNull();
    expect(startRole(row({ firstSeenAt: LINK + 6 * H }), FROM, saved)).toBe('before');
    expect(startRole(row({ date: FROM, firstSeenAt: LINK + 4 * H }), FROM, saved)).toBe('linkDay');
  });

  it('a link made before the budget start (a stored balance not taken at link) keeps only the pending rule', () => {
    const early: LinkInfo = { linkedAt: Date.UTC(2026, 9, 1), firstSeen: LINK };
    expect(startRole(row({ date: FROM }), FROM, early)).toBeNull();
    expect(startRole(row({ firstSeenAt: LINK + 3 * D }), FROM, early)).toBeNull();
    expect(startRole(row({ status: 'pending' }), FROM, early)).toBe('before');
  });
});
