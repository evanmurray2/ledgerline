// The app's side of the shadow run (src/copy/shadow.ts): when it starts one, what it asks the inbox for, and what
// it reports. The filing and the comparison themselves are the engine's (apps/worker/test/inbox.test.ts).
import { describe, expect, it } from 'vitest';
import type { EngineHost, InboxRun, ShadowReport, SyncPage } from '../src/copy/host';
import { shadowBefore, shadowFinish } from '../src/copy/shadow';

const page = (o: Partial<SyncPage> = {}): SyncPage => ({
  format: 1,
  epoch: 'e',
  serverTime: 0,
  through: 10,
  more: false,
  cursor: null,
  rows: [],
  ...o,
});
const CLEAN: ShadowReport = { runs: 2, compared: true, differences: [] };

function setup(o: { seq?: string; inbox?: number[]; refuse?: ShadowReport } = {}) {
  const kv = new Map<string, string>(o.seq === undefined ? [] : [['shadow_seq', o.seq]]);
  const asked: string[] = [];
  const posted: unknown[] = [];
  let began: InboxRun[] | null = null;
  let steps = 0;
  const host = {
    get: async (k: string) => kv.get(k) ?? null,
    put: async (k: string, v: string | null) => void (v === null ? kv.delete(k) : kv.set(k, v)),
    shadowBegin: async (runs: InboxRun[]) => {
      began = runs;
      return o.refuse ?? null;
    },
    shadowStep: async () => ++steps < (began?.length ?? 0),
    shadowEnd: async () => CLEAN,
  } as unknown as EngineHost;
  const get = async (path: string) => {
    asked.push(path);
    const after = Number(new URL(path, 'https://x').searchParams.get('after'));
    const next = (o.inbox ?? []).find((n) => n > after);
    return { run: next === undefined ? null : ({ fetchSeq: next } as InboxRun), latest: 0 };
  };
  const post = async (_path: string, body: unknown) => void posted.push(body);
  return { host, kv, asked, posted, get, post, began: () => began, steps: () => steps };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the shadow run in the app', () => {
  it('the first time it only notes where the inbox is', async () => {
    const s = setup();
    expect(await shadowBefore(s.host, page({ inbox: 7 }), s.get, s.post)).toBeNull();
    expect(s.kv.get('shadow_seq')).toBe('7');
    expect(s.asked).toEqual([]);
  });

  it('does nothing for a download, a page with more to come, or no news in the inbox', async () => {
    const s = setup({ seq: '7' });
    for (const p of [
      page({ inbox: 9, more: true }),
      page({ inbox: 9, cursor: 'c' }),
      page(),
      page({ inbox: 7 }),
    ])
      expect(await shadowBefore(s.host, p, s.get, s.post)).toBeNull();
    expect(s.asked).toEqual([]);
    expect(s.kv.get('shadow_seq')).toBe('7');
  });

  it('takes the new updates in order, starts a run, and reports what it found', async () => {
    const s = setup({ seq: '7', inbox: [8, 9] });
    expect(await shadowBefore(s.host, page({ inbox: 9 }), s.get, s.post)).toBe(9);
    expect(s.asked).toEqual(['/api/sync/inbox?after=7', '/api/sync/inbox?after=8']);
    expect(s.began()?.map((r) => r.fetchSeq)).toEqual([8, 9]);
    expect(s.kv.get('shadow_seq')).toBe('9');
    await shadowFinish(s.host, 9, s.post);
    await settle();
    expect(s.steps()).toBe(2);
    expect(s.posted).toEqual([CLEAN]);
  });

  it('reports a run that could not start, and one the inbox could not complete', async () => {
    const refused: ShadowReport = { runs: 0, compared: false, why: 'edited_before', differences: [] };
    const a = setup({ seq: '7', inbox: [8], refuse: refused });
    expect(await shadowBefore(a.host, page({ inbox: 8 }), a.get, a.post)).toBeNull();
    await settle();
    expect(a.posted).toEqual([refused]);

    const b = setup({ seq: '7', inbox: [8] });
    expect(await shadowBefore(b.host, page({ inbox: 9 }), b.get, b.post)).toBeNull();
    await settle();
    expect(b.posted).toEqual([{ runs: 0, compared: false, why: 'incomplete', differences: [] }]);
    // It is not tried again.
    expect(b.kv.get('shadow_seq')).toBe('9');
  });

  it('says nothing was compared when a newer bank update reached the copy before the end', async () => {
    const s = setup({ seq: '7', inbox: [8] });
    expect(await shadowBefore(s.host, page({ inbox: 8 }), s.get, s.post)).toBe(8);
    s.kv.set('shadow_seq', '9');
    await shadowFinish(s.host, 8, s.post);
    await settle();
    expect(s.posted).toEqual([{ runs: 2, compared: false, why: 'incomplete', differences: [] }]);
  });
});
