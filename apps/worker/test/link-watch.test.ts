// A new bank's link finished by the server (src/seal/link-watch.ts; docs/privacy.md 5.5): a person who never comes
// back to the app still gets the link kept within minutes, from the store's watch of its link token; the app's own
// link-finish and the watch exchange a public token once between them. Plaid is faked at the fetch level.
import { decryptToken } from '@ledgerline/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.js';
import {
  finishNewLink,
  KEEP_DONE_MS,
  LINK_WATCH,
  linkRouteKey,
  linkTokenHash,
  linkWatchHandler,
  linkWatchId,
  WATCH_EVERY_MS,
  WATCH_FOR_MS,
  WATCH_LATER_MS,
  watchLink,
  type WatchState,
} from '../src/seal/link-watch.js';
import type { Enqueue, Job } from '../src/store/jobs.js';
import { BUDGET, T0 } from './log-writer.js';
import { ring, world, type World } from './sealed-world.js';

const TOKEN = 'link-new-7';

/** Plaid, at the fetch level: the newest Link session, and how many times a public token was exchanged. */
function fakePlaid() {
  const st = { sessions: [] as unknown[], exchanged: 0 };
  const real = globalThis.fetch;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== 'plaid.test') return real(input as RequestInfo, init);
    switch (url.pathname) {
      case '/link/token/get':
        return json({ link_sessions: st.sessions });
      case '/item/public_token/exchange':
        st.exchanged++;
        // Plaid takes a public token once.
        if (st.exchanged > 1)
          return new Response(JSON.stringify({ error_code: 'INVALID_PUBLIC_TOKEN', error_type: 'x' }), {
            status: 400,
          });
        return json({ access_token: 'access-new-7', item_id: 'item-new-7' });
      case '/item/get':
        return json({ item: { institution_id: 'ins_1' } });
      case '/institutions/get_by_id':
        return json({ institution: { name: 'Bank One' } });
      default:
        return json({});
    }
  });
  return st;
}

const FINISHED = [
  {
    started_at: '2026-11-14T19:00:00Z',
    finished_at: '2026-11-14T19:01:00Z',
    results: { item_add_results: [{ public_token: 'public-new-7' }] },
  },
];

/** The store's env, its job queue as rows, and what was asked of the Directory. */
function setup(x: World) {
  const routes: string[] = [];
  const dropped: string[] = [];
  const env = {
    DB: x.db,
    TOKEN_KEYS: '1:a passphrase of at least thirty-two characters!',
    TOKEN_KEY_CURRENT: '1',
    PLAID_ENV: 'sandbox',
    PLAID_CLIENT_ID: 'test-client',
    PLAID_SECRET: 'test-secret',
    PLAID_BASE_URL: 'http://plaid.test',
    ROUTE_LINK: async (item: string) => void routes.push(item),
    DROP_ROUTE: async (key: string) => void dropped.push(key),
  } as unknown as Env;
  const enqueue: Enqueue = async (kind, o) => {
    x.sql(
      `INSERT INTO job (id, kind, state, run_at, recurring, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0)`,
      o.id,
      kind,
      JSON.stringify(o.state),
      o.runAt,
    );
    return o.id!;
  };
  const job = async (hash: string): Promise<{ job: Job; runAt: number } | null> => {
    const r = await x.db
      .prepare(`SELECT id, kind, state, run_at FROM job WHERE id = ?1`)
      .bind(linkWatchId(hash))
      .first<{ id: string; kind: string; state: string; run_at: number }>();
    return r
      ? {
          job: {
            id: r.id,
            kind: r.kind,
            connectionId: null,
            state: JSON.parse(r.state),
            attempts: 0,
            recurring: false,
          },
          runAt: r.run_at,
        }
      : null;
  };
  let fetches = 0;
  const handler = linkWatchHandler({
    env,
    budgetId: async () => BUDGET,
    queueFetch: async () => void fetches++,
  });
  /** One step of the watch, as the job runner runs it: its new state saved, or the job deleted. */
  const step = async (hash: string, now: number) => {
    const j = (await job(hash))!;
    const r = await handler(j.job, now);
    if ('done' in r) x.sql(`DELETE FROM job WHERE id = ?`, j.job.id);
    else
      x.sql(`UPDATE job SET state = ?, run_at = ? WHERE id = ?`, JSON.stringify(r.state), r.runAt, j.job.id);
    return r;
  };
  const links = async () =>
    (
      await x.db
        .prepare(
          `SELECT connection_id, provider_item_id, fetch_requested, mac FROM bank_link WHERE id NOT LIKE '01H%'`,
        )
        .all<{ connection_id: string; provider_item_id: string; fetch_requested: number; mac: string }>()
    ).results;
  return { env, enqueue, job, step, links, routes, dropped, fetches: () => fetches };
}

describe('a new bank link the server finishes', () => {
  let p: ReturnType<typeof fakePlaid>;
  beforeEach(() => {
    p = fakePlaid();
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps the link when the person never comes back, and a late link-finish finds it', async () => {
    await world(async (x) => {
      const s = setup(x);
      const hash = await watchLink(s.env, s.enqueue, TOKEN, T0);
      const j = (await s.job(hash))!;
      expect(j.job.kind).toBe(LINK_WATCH);
      expect(j.runAt).toBe(T0 + WATCH_EVERY_MS);
      // The job holds the link token encrypted, and the Directory knows it only by a hash.
      const st = j.job.state as WatchState;
      expect(JSON.stringify(st)).not.toContain(TOKEN);
      expect(await decryptToken(ring, st.enc, st.keyVersion, linkWatchId(hash))).toBe(TOKEN);
      expect(hash).toBe(await linkTokenHash(TOKEN));

      // Still on Plaid's page: asked again in 3 minutes, then every 15 after the first half hour.
      expect(await s.step(hash, T0 + WATCH_EVERY_MS)).toMatchObject({ runAt: T0 + 2 * WATCH_EVERY_MS });
      expect(await s.step(hash, T0 + 40 * 60_000)).toMatchObject({
        runAt: T0 + 40 * 60_000 + WATCH_LATER_MS,
      });
      expect(await s.links()).toEqual([]);

      // Finished at Plaid; the person closed the app. The watch keeps the link and asks for its first fetch.
      p.sessions = FINISHED;
      const at = T0 + 55 * 60_000;
      const done = await s.step(hash, at);
      const [link] = await s.links();
      expect(link).toMatchObject({ provider_item_id: 'item-new-7', fetch_requested: 1 });
      expect(link!.mac).toBeTruthy();
      expect(done).toMatchObject({ state: { connectionId: link!.connection_id }, runAt: at + KEEP_DONE_MS });
      expect(s.fetches()).toBe(1);
      expect(s.routes).toEqual(['item-new-7']);
      expect(s.dropped).toEqual([linkRouteKey(hash)]);

      // The app comes back later and asks: the same link, with no second exchange.
      expect(await finishNewLink(s.env, BUDGET, TOKEN, at + 60_000)).toEqual({
        status: 'linked',
        connectionId: link!.connection_id,
      });
      expect(p.exchanged).toBe(1);
      // An hour later the watch goes.
      expect(await s.step(hash, at + KEEP_DONE_MS)).toEqual({ done: true });
      expect(await s.job(hash)).toBe(null);
    });
  });

  it('the app and the watch together exchange once', async () => {
    await world(async (x) => {
      const s = setup(x);
      const hash = await watchLink(s.env, s.enqueue, TOKEN, T0);
      p.sessions = FINISHED;
      const [a, b] = await Promise.all([
        finishNewLink(s.env, BUDGET, TOKEN, T0 + 1000),
        finishNewLink(s.env, BUDGET, TOKEN, T0 + 1000),
      ]);
      expect(a).toEqual(b);
      expect(a).toMatchObject({ status: 'linked' });
      expect(p.exchanged).toBe(1);
      // The watch's next step finds the link kept by the app: nothing more is asked of Plaid.
      const r = await s.step(hash, T0 + WATCH_EVERY_MS);
      expect('done' in r).toBe(true);
      expect(p.exchanged).toBe(1);
      expect(await s.links()).toHaveLength(1);
    });
  });

  it('a person who leaves Plaid without a bank, or a token past its 4 hours, ends the watch', async () => {
    await world(async (x) => {
      const s = setup(x);
      const left = await watchLink(s.env, s.enqueue, TOKEN, T0);
      p.sessions = [{ started_at: '2026-11-14T19:00:00Z', finished_at: '2026-11-14T19:01:00Z', exit: {} }];
      expect(await s.step(left, T0 + WATCH_EVERY_MS)).toEqual({ done: true });
      expect(s.dropped).toEqual([linkRouteKey(left)]);

      const old = await watchLink(s.env, s.enqueue, 'link-new-8', T0);
      p.sessions = [];
      expect(await s.step(old, T0 + WATCH_FOR_MS + 1)).toEqual({ done: true });
      expect(s.dropped).toEqual([linkRouteKey(left), linkRouteKey(old)]);
      expect(await s.links()).toEqual([]);
      expect(p.exchanged).toBe(0);
    });
  });
});
