// Transfer matching that looks back at rows with no partner (D-86 A2, D-90).
import { describe, expect, it } from 'vitest';
import { parseCents as $ } from '../src/money.js';
import { detectTransfers, type TransferRow } from '../src/transfers.js';

const t = (
  key: string,
  accountId: string,
  amount: string,
  date: string,
  description = 'ONLINE TRANSFER',
): TransferRow => ({ key, accountId, amount: $(amount), date, description, providerCategory: null });
const none = new Set<string>();

describe('transfer matching looks back', () => {
  it('pairs a new inflow with the outflow that came alone in an earlier update', () => {
    // Monday: the checking side arrives alone, and the person is asked.
    const monday = [t('out', 'chk', '-500', '2026-11-09', 'ONLINE PMT TO CARD')];
    expect(detectTransfers(monday)).toEqual([{ kind: 'unclear', outKey: 'out', candidates: [] }]);
    // Tuesday: the card side arrives. The two pair, though they were never in one update.
    const tuesday = [t('in', 'card', '500', '2026-11-10', 'PAYMENT THANK YOU')];
    expect(detectTransfers(tuesday, none, monday)).toEqual([{ kind: 'paired', outKey: 'out', inKey: 'in' }]);
  });

  it('pairs a new outflow with the inflow that came alone in an earlier update', () => {
    const earlier = [t('in', 'savings', '250', '2026-11-08', 'DEPOSIT')];
    const update = [t('out', 'chk', '-250', '2026-11-10')];
    expect(detectTransfers(update, none, earlier)).toEqual([{ kind: 'paired', outKey: 'out', inKey: 'in' }]);
  });

  it('goes by the rows’ dates, 5 days at most, not by when they arrived', () => {
    const earlier = [t('out', 'chk', '-80', '2026-11-01')];
    expect(detectTransfers([t('in', 'savings', '80', '2026-11-06', 'DEPOSIT')], none, earlier)).toEqual([
      { kind: 'paired', outKey: 'out', inKey: 'in' },
    ]);
    // 6 days apart: no partner. The earlier outflow is not looked at again, and an inflow alone is never asked about.
    expect(detectTransfers([t('in', 'savings', '80', '2026-11-07', 'DEPOSIT')], none, earlier)).toEqual([]);
  });

  it('asks when there are two possible partners, earlier or new', () => {
    // One new outflow, and an inflow in each of two other accounts: one earlier, one new.
    const earlier = [t('m', 'marcus', '200', '2026-11-09', 'DEPOSIT')];
    const update = [t('o', 'chk', '-200', '2026-11-10'), t('a', 'ally', '200', '2026-11-11', 'DEPOSIT')];
    expect(detectTransfers(update, none, earlier)).toEqual([
      { kind: 'unclear', outKey: 'o', candidates: ['m', 'a'] },
    ]);
    // Two outflows, one earlier and one new, and one new inflow: either could be its other side.
    const o1 = [t('o1', 'chk', '-300', '2026-11-09')];
    const both = [
      t('o2', 'savings', '-300', '2026-11-10'),
      t('in', 'marcus', '300', '2026-11-11', 'DEPOSIT'),
    ];
    expect(detectTransfers(both, none, o1)).toEqual([
      { kind: 'unclear', outKey: 'o1', candidates: ['in'] },
      { kind: 'unclear', outKey: 'o2', candidates: ['in'] },
    ]);
  });

  it('a pair that was made stays: a later outflow of the same amount is asked about', () => {
    const monday = [t('o1', 'chk', '-500', '2026-11-09')];
    const tuesday = [t('in', 'card', '500', '2026-11-10', 'PAYMENT THANK YOU')];
    expect(detectTransfers(tuesday, none, monday)).toEqual([{ kind: 'paired', outKey: 'o1', inKey: 'in' }]);
    // Wednesday: the paired rows are no longer among the earlier ones.
    const wednesday = [t('o2', 'chk', '-500', '2026-11-11')];
    expect(detectTransfers(wednesday, none, [])).toEqual([{ kind: 'unclear', outKey: 'o2', candidates: [] }]);
    // The same, when the caller passes them and names them as paired.
    expect(detectTransfers(wednesday, new Set(['o1', 'in']), [...monday, ...tuesday])).toEqual([
      { kind: 'unclear', outKey: 'o2', candidates: [] },
    ]);
  });

  it('never pairs two earlier rows with each other: every decision holds a row of this update', () => {
    // Rows from before the rule: an outflow and its inflow, both without a partner.
    const earlier = [t('o', 'chk', '-40', '2026-11-03'), t('i', 'savings', '40', '2026-11-04', 'DEPOSIT')];
    expect(detectTransfers([t('x', 'chk', '-12', '2026-11-10', 'SAFEWAY')], none, earlier)).toEqual([]);
    expect(detectTransfers([], none, earlier)).toEqual([]);
    // But an earlier pair-in-waiting still counts as a rival: the new inflow makes two possible partners.
    expect(detectTransfers([t('i2', 'ally', '40', '2026-11-05', 'DEPOSIT')], none, earlier)).toEqual([
      { kind: 'unclear', outKey: 'o', candidates: ['i', 'i2'] },
    ]);
  });

  it('only a transfer-like outflow starts a pair, earlier or new', () => {
    const earlier = [t('o', 'chk', '-60', '2026-11-09', 'SAFEWAY')];
    expect(detectTransfers([t('i', 'savings', '60', '2026-11-10', 'DEPOSIT')], none, earlier)).toEqual([]);
  });

  it('gives the same answer whatever the order of the rows inside each list', () => {
    const earlier = [t('o1', 'chk', '-300', '2026-11-09'), t('m', 'marcus', '75', '2026-11-08', 'DEPOSIT')];
    const update = [
      t('o2', 'savings', '-75', '2026-11-10'),
      t('in', 'ally', '300', '2026-11-11', 'DEPOSIT'),
      t('o3', 'chk', '-20', '2026-11-10'),
    ];
    const sorted = (d: ReturnType<typeof detectTransfers>) =>
      [...d].sort((a, b) => a.outKey.localeCompare(b.outKey));
    const want = sorted(detectTransfers(update, none, earlier));
    expect(want).toEqual([
      { kind: 'paired', outKey: 'o1', inKey: 'in' },
      { kind: 'paired', outKey: 'o2', inKey: 'm' },
      { kind: 'unclear', outKey: 'o3', candidates: [] },
    ]);
    expect(sorted(detectTransfers([...update].reverse(), none, [...earlier].reverse()))).toEqual(want);
  });

  it('a row that is in both lists counts once, as new', () => {
    const out = t('out', 'chk', '-500', '2026-11-09');
    const inn = t('in', 'card', '500', '2026-11-10', 'PAYMENT THANK YOU');
    expect(detectTransfers([out, inn], none, [out])).toEqual([
      { kind: 'paired', outKey: 'out', inKey: 'in' },
    ]);
  });
});
