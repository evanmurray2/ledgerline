// The app's side of the shadow run (src/copy/shadow.ts): when it starts one, what it asks the inbox for, and what
// it reports. The filing and the comparison themselves are the engine's (apps/worker/test/inbox.test.ts).
import { describe, expect, it } from 'vitest';
import type { EngineHost, InboxRun, ShadowReport, SyncPage } from '../src/copy/host';
import { MAX_RUNS, shadowBefore, shadowFinish } from '../src/copy/shadow';

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
const INCOMPLETE = { compared: false, why: 'incomplete', differences: [] };

function setup(o: { seq?: string; inbox?: number[]; refuse?: ShadowReport } = {}) {
  const kv = new Map<string, string>(o.seq === undefined ? [] : [['shadow_seq', o.seq]]);
  const asked: string[] = [];
  const posted: unknown[] = [];
  const calls: string[] = [];
  let runs: InboxRun[] = [];
  let steps = 0;
  const host = {
    get: async (k: string) => kv.get(k) ?? null,
    put: async (k: string, v: string | null) => void (v === null ? kv.delete(k) : kv.set(k, v)),
    shadowFork: async () => {
      calls.push('fork');
      return 5;
    },
    shadowBegin: async (_token: number, r: InboxRun[]) => {
      calls.push('begin');
      runs = r;
      return o.refuse ?? null;
    },
    shadowStep: async () => {
      calls.push('step');
      return ++steps < runs.length;
    },
    shadowEnd: async () => {
      calls.push('end');
      return runs.length ? CLEAN : { runs: 0, compared: false, why: 'failed', differences: [] };
    },
  } as unknown as EngineHost;
  const get = async (path: string) => {
    asked.push(path);
    const after = Number(new URL(path, 'https://x').searchParams.get('after'));
    const next = (o.inbox ?? []).find((n) => n > after);
    return { run: next === undefined ? null : ({ fetchSeq: next } as InboxRun), latest: 0 };
  };
  const post = async (_path: string, body: unknown) => void posted.push(body);
  return { host, kv, asked, posted, calls, get, post, runs: () => runs };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the shadow run in the app', () => {
  it('the first time it only notes where the inbox is', async () => {
    const s = setup();
    expect(await shadowBefore(s.host, page({ inbox: 7 }), true, s.post)).toBeNull();
    expect(s.kv.get('shadow_seq')).toBe('7');
    expect(s.calls).toEqual([]);
  });

  it('does nothing for a download, a page with more to come, or no news in the inbox', async () => {
    const s = setup({ seq: '7' });
    for (const p of [
      page({ inbox: 9, more: true }),
      page({ inbox: 9, cursor: 'c' }),
      page(),
      page({ inbox: 7 }),
    ])
      expect(await shadowBefore(s.host, p, true, s.post)).toBeNull();
    expect(s.calls).toEqual([]);
    expect(s.kv.get('shadow_seq')).toBe('7');
  });

  it('makes the scratch copy before the sync with no network, then files and reports after it', async () => {
    const s = setup({ seq: '7', inbox: [8, 9] });
    const started = await shadowBefore(s.host, page({ inbox: 9 }), true, s.post);
    expect(started).toEqual({ token: 5, from: 7, to: 9 });
    expect(s.calls).toEqual(['fork']);
    expect(s.asked).toEqual([]);
    expect(s.kv.get('shadow_seq')).toBe('9');
    await shadowFinish(s.host, started!, s.get, s.post);
    await settle();
    expect(s.asked).toEqual(['/api/sync/inbox?after=7', '/api/sync/inbox?after=8']);
    expect(s.runs().map((r) => r.fetchSeq)).toEqual([8, 9]);
    expect(s.calls).toEqual(['fork', 'begin', 'step', 'step', 'end']);
    expect(s.posted).toEqual([CLEAN]);
  });

  it('never starts from a sync that met the server filing, nor from the one after it', async () => {
    const s = setup({ seq: '7' });
    expect(await shadowBefore(s.host, page({ inbox: 7, filing: true }), true, s.post)).toBeNull();
    expect(s.kv.get('shadow_seq')).toBe('filing');
    // The update is done now, but this copy may already hold part of it: the device only notes the place.
    expect(await shadowBefore(s.host, page({ inbox: 8 }), true, s.post)).toBeNull();
    expect(s.kv.get('shadow_seq')).toBe('8');
    expect(s.calls).toEqual([]);
    // The next update is compared again.
    expect(await shadowBefore(s.host, page({ inbox: 9 }), true, s.post)).not.toBeNull();
  });

  it('skips, and says so, when the sync had several pages or too many updates waited', async () => {
    const a = setup({ seq: '7' });
    expect(await shadowBefore(a.host, page({ inbox: 8 }), false, a.post)).toBeNull();
    const b = setup({ seq: '7' });
    expect(await shadowBefore(b.host, page({ inbox: 7 + MAX_RUNS + 1 }), true, b.post)).toBeNull();
    await settle();
    for (const s of [a, b]) {
      expect(s.calls).toEqual([]);
      expect(s.posted).toEqual([{ runs: 0, ...INCOMPLETE }]);
    }
    // They are not tried again.
    expect(a.kv.get('shadow_seq')).toBe('8');
  });

  it('reports a run the engine refused, and one the inbox could not complete, and frees the scratch copy', async () => {
    const refused: ShadowReport = { runs: 0, compared: false, why: 'edited_before', differences: [] };
    const a = setup({ seq: '7', inbox: [8], refuse: refused });
    await shadowFinish(
      a.host,
      (await shadowBefore(a.host, page({ inbox: 8 }), true, a.post))!,
      a.get,
      a.post,
    );
    await settle();
    expect(a.posted).toEqual([refused]);
    expect(a.calls).toEqual(['fork', 'begin', 'end']);

    const b = setup({ seq: '7', inbox: [8] });
    await shadowFinish(
      b.host,
      (await shadowBefore(b.host, page({ inbox: 9 }), true, b.post))!,
      b.get,
      b.post,
    );
    await settle();
    expect(b.posted).toEqual([{ runs: 0, ...INCOMPLETE }]);
    expect(b.calls).toEqual(['fork', 'end']);
  });

  it('says nothing was compared when a newer sync reached the copy before the end', async () => {
    const s = setup({ seq: '7', inbox: [8] });
    const started = await shadowBefore(s.host, page({ inbox: 8 }), true, s.post);
    s.kv.set('shadow_seq', '9');
    await shadowFinish(s.host, started!, s.get, s.post);
    await settle();
    expect(s.posted).toEqual([{ runs: 2, ...INCOMPLETE }]);
  });
});
