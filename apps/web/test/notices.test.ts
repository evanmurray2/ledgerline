// Notices on every device of a locked budget (src/copy/notices.ts; docs/privacy.md 5.8), and which requests the
// app signs with the budget's key (src/api/signed-paths.ts; docs/privacy-keys.md 11).
import { afterEach, describe, expect, it } from 'vitest';
import { ACTION, type Entry, KIND } from '@ledgerline/seal';
import {
  ownWriters,
  rememberWriter,
  dismissedNotices,
  dismissNotice,
  NOTICE_MS,
  noteRecoveryKeyHere,
  noticesOf,
  takeRecoveryKeyHere,
} from '../src/copy/notices';
import { signedActionFor } from '../src/api/signed-paths';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-14T20:00:00Z');
const ME = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVS0';
const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const entry = (number: number, kind: number, deviceId: string, time: number) =>
  ({ header: { number, kind, deviceId, time } }) as unknown as Entry;

const base = {
  deviceIds: [ME],
  recoveryKeyUsedAt: null,
  now: NOW,
  dismissed: [] as string[],
  intents: new Map<number, { notBefore: number; slotIds: string[] }>(),
};

afterEach(() => localStorage.clear());

describe('notices on every device', () => {
  it('tells of a way in another device added, not of one this device added, and not after 14 days', () => {
    const n = noticesOf({
      ...base,
      entries: [
        entry(1, KIND.genesis, ME, NOW - 30 * DAY),
        entry(5, KIND.slotChange, OTHER, NOW - DAY),
        entry(7, KIND.slotChange, ME, NOW - DAY),
        entry(9, KIND.slotChange, OTHER, NOW - NOTICE_MS - 1),
        entry(11, KIND.keyChange, OTHER, NOW - DAY),
      ],
    });
    expect(n).toEqual([{ id: 'way:5', kind: 'way-added', at: NOW - DAY }]);
  });

  it('knows every id this device wrote the log as: a copy made again is a new writer', () => {
    rememberWriter(ME);
    rememberWriter(OTHER);
    rememberWriter(ME);
    expect(ownWriters()).toEqual([ME, OTHER]);
    const facts = { ...base, entries: [entry(5, KIND.slotChange, OTHER, NOW - DAY)] };
    expect(noticesOf({ ...facts, deviceIds: ownWriters() })).toEqual([]);
  });

  it('tells of a change planned on another device, and of any planned change on its day', () => {
    const intents = new Map([
      [4, { notBefore: NOW + 3 * DAY, slotIds: ['p:a'] }],
      [6, { notBefore: NOW + 3 * DAY, slotIds: ['p:b'] }],
      [8, { notBefore: NOW - 1, slotIds: ['r:old'] }],
    ]);
    const n = noticesOf({
      ...base,
      intents,
      entries: [
        entry(4, KIND.intent, OTHER, NOW - 4 * DAY),
        entry(6, KIND.intent, ME, NOW - 4 * DAY),
        entry(8, KIND.intent, ME, NOW - 8 * DAY),
      ],
    });
    // The reminder of a change that is due comes first.
    expect(n).toEqual([
      { id: 'due:8', kind: 'due', number: 8, notBefore: NOW - 1, slotIds: ['r:old'] },
      {
        id: 'plan:4',
        kind: 'planned',
        at: NOW - 4 * DAY,
        number: 4,
        notBefore: NOW + 3 * DAY,
        slotIds: ['p:a'],
      },
    ]);
    // A plan cancelled or carried out is no longer in the log's intents: no notice.
    expect(noticesOf({ ...base, entries: [entry(4, KIND.intent, OTHER, NOW - DAY)] })).toEqual([]);
  });

  it('tells of a recovery-key sign-in, except on the device where it happened', () => {
    const at = NOW - DAY;
    expect(noticesOf({ ...base, entries: [], recoveryKeyUsedAt: at })).toEqual([
      { id: `key:${at}`, kind: 'recovery-sign-in', at },
    ]);
    expect(noticesOf({ ...base, entries: [], recoveryKeyUsedAt: NOW - NOTICE_MS - 1 })).toEqual([]);
    // The device that signed in with the key dismisses its own notice the first time it learns the time.
    noteRecoveryKeyHere();
    takeRecoveryKeyHere(BUDGET, at);
    expect(dismissedNotices(BUDGET)).toEqual([`key:${at}`]);
    // A later sign-in elsewhere shows again.
    takeRecoveryKeyHere(BUDGET, at + 1000);
    expect(dismissedNotices(BUDGET)).toEqual([`key:${at}`]);
  });

  it('each device dismisses a notice for itself, newest first', () => {
    const facts = {
      ...base,
      entries: [entry(5, KIND.slotChange, OTHER, NOW - 2 * DAY), entry(6, KIND.slotChange, OTHER, NOW - DAY)],
    };
    expect(noticesOf(facts).map((n) => n.id)).toEqual(['way:6', 'way:5']);
    dismissNotice(BUDGET, 'way:6');
    dismissNotice(BUDGET, 'way:6');
    expect(dismissedNotices(BUDGET)).toEqual(['way:6']);
    expect(noticesOf({ ...facts, dismissed: dismissedNotices(BUDGET) }).map((n) => n.id)).toEqual(['way:5']);
    // Another budget on the same device keeps its own list.
    expect(dismissedNotices('01ARZ3NDEKTSV4RRFFQ69G5FAW')).toEqual([]);
  });
});

describe('the requests a locked budget signs', () => {
  it('names the same requests as the Worker, by path; a link’s finish only for a new bank', () => {
    const p = '/api/settings/connections';
    expect(signedActionFor('POST', `${p}/link-token`, { mode: 'new' })).toBe(ACTION.linkToken);
    expect(signedActionFor('POST', `${p}/link-token`, { mode: 'repair', connectionId: 'c' })).toBe(
      ACTION.linkToken,
    );
    expect(signedActionFor('POST', `${p}/link-finish`, { mode: 'new', linkToken: 't' })).toBe(
      ACTION.linkFinish,
    );
    expect(signedActionFor('POST', `${p}/link-finish`, { mode: 'repair', linkToken: 't' })).toBeNull();
    expect(signedActionFor('POST', `${p}/con_1/remove`, { connectionId: 'con_1' })).toBe(ACTION.removeBank);
    expect(signedActionFor('POST', `${p}/con_1/refresh`, {})).toBeNull();
    expect(signedActionFor('POST', '/api/cutover/purge', undefined)).toBeNull();
    expect(signedActionFor('POST', '/api/settings/security/delete-account', {})).toBe(ACTION.deleteAccount);
    expect(signedActionFor('POST', '/api/settings/security/recovery-key', {})).toBe(ACTION.setRecoverySignIn);
    expect(signedActionFor('GET', '/api/settings/security/recovery-key', undefined)).toBeNull();
  });
});
