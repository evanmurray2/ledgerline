// A sealed budget's store for the tests of its bank runs (src/seal/runs.ts) and of the job that fetches them
// (src/seal/fetch-job.ts): the first log entry stored with the Worker's stamps, two stamped bank links, a bank that
// answers by cursor, and what a device knows about the runs it has filed.
import { MUTATION_DURING_PAGINATION, ProviderError, type BankDataProvider } from '@ledgerline/bank-provider';
import type { Db } from '@ledgerline/db/sql';
import { encryptToken, parseKeyring, tokenKeyBytes } from '@ledgerline/platform';
import { afterRun, encodeEntry, linkMac, openRun, serverKeys, type FilingState } from '@ledgerline/seal';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import { logGenesis } from '../src/seal/log-store.js';
import {
  beginSealedRun,
  completeSealedRun,
  fetchSealedPage,
  keyStampStmts,
  runDeps,
  runsAfter,
  sealBankAnswer,
  sealedPageOf,
  sealLinkDescription,
  type RunDeps,
} from '../src/seal/runs.js';
import { DurableDb } from '../src/store/adapter.js';
import type { BudgetStore } from '../src/store/budget-store.js';
import { BUDGET, T0, Writer } from './log-writer.js';

const e = env as unknown as { BUDGET: DurableObjectNamespace<BudgetStore> };
export const ring = parseKeyring('1:a passphrase of at least thirty-two characters!', '1');
export const LINK_A = '01HAAAAAAAAAAAAAAAAAAAAAAA';
export const LINK_B = '01HBBBBBBBBBBBBBBBBBBBBBBB';
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** A bank whose pages are named by cursor. A page is `{ added, modified, removed, next, more }`. */
export interface Page {
  added: number;
  modified?: number;
  removed?: number;
  next: string;
  more: boolean;
}
export function bank(
  pages: Record<string, Page>,
  o: { mutateOnce?: string; mutateAlways?: boolean; before?: () => Promise<void> } = {},
) {
  let mutate = o.mutateOnce;
  const calls: (string | null)[] = [];
  const provider = {
    fetchSyncPage: async (c: { id: string; accessToken: string }, cursor: string | null) => {
      calls.push(cursor);
      // The token is the link's own, opened by the step.
      expect(c.accessToken).toBe(`token-${c.id.slice(4)}`);
      await o.before?.();
      if (o.mutateAlways) throw new ProviderError(MUTATION_DURING_PAGINATION, 'changed', true);
      if (mutate !== undefined && (cursor ?? '') === mutate) {
        mutate = undefined;
        throw new ProviderError(MUTATION_DURING_PAGINATION, 'changed', true);
      }
      const p = pages[cursor ?? ''];
      if (!p) throw new Error(`no page at ${cursor}`);
      return {
        body: new TextEncoder().encode(JSON.stringify({ at: cursor ?? '', ...p })),
        nextCursor: p.next,
        hasMore: p.more,
      };
    },
    parsePage: (body: string) => {
      const p = JSON.parse(body) as Page;
      const events = [
        ...Array.from({ length: p.added }, () => ({ kind: 'added' })),
        ...Array.from({ length: p.modified ?? 0 }, () => ({ kind: 'modified' })),
        ...Array.from({ length: p.removed ?? 0 }, () => ({ kind: 'removed' })),
      ];
      return { events, nextCursor: p.next, hasMore: p.more };
    },
  } as unknown as BankDataProvider;
  return { provider, calls };
}

export interface World {
  db: Db;
  d: RunDeps;
  w: Writer;
  /** What a device knows about the runs it has filed. */
  filing: FilingState;
  sql: (q: string, ...p: unknown[]) => void;
}

/** A sealed budget's store: its first log entry stored with the Worker's stamps, and two stamped bank links. */
export async function world(fn: (x: World) => Promise<void>, o: { described?: boolean } = {}): Promise<void> {
  await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName(`runs-${Math.random()}`)), async (_o, state) => {
    const db = new DurableDb(state.storage);
    const d: RunDeps = runDeps(db, BUDGET, ring);
    const w = new Writer(BUDGET, T0);
    const r = await logGenesis(
      {
        db,
        budgetId: BUDGET,
        now: T0 + 2000,
        resting: false,
        freshWay: false,
        lastCompleteRun: 0,
        receiptHashes: async () => null,
        stamps: (before, after) => keyStampStmts(d, before, after, T0 + 2000),
      },
      encodeEntry(await w.genesis()),
    );
    expect(r).toMatchObject({ ok: true, number: 1 });
    const k = await serverKeys(await tokenKeyBytes(ring.keys[1]!), 1);
    for (const id of [LINK_A, LINK_B]) {
      const enc = await encryptToken(ring, `token-${id}`, `con_${id}`);
      const mac = await linkMac(k, BUDGET, id, `item-${id}`, unb64(enc.enc));
      await db
        .prepare(
          `INSERT INTO bank_link (id, connection_id, budget_id, provider, provider_item_id, access_token_enc, key_version, linked_at, mac, created_at)
           VALUES (?1, ?2, ?3, 'plaid', ?4, ?5, ?6, 5, ?7, 6)`,
        )
        .bind(id, `con_${id}`, BUDGET, `item-${id}`, enc.enc, enc.keyVersion, b64(mac))
        .run();
    }
    const filing: FilingState = {
      budgetId: BUDGET,
      workerKeys: new Map([[1, (k.runSign as { pub: Uint8Array }).pub]]),
      filedThrough: 0,
      lastManifestHash: new Uint8Array(32),
      lastRunTime: 0,
      lastInboxVersion: 0,
      cursors: new Map(),
      inboxVersion: 1,
      retiredAt: new Map(),
      inbox: async (v) => (v === 1 ? w.inbox : null),
      now: T0 + 60_000,
    };
    const x: World = { db, d, w, filing, sql: (q, ...p) => void state.storage.sql.exec(q, ...p) };
    if (o.described !== false) {
      // Each link's first run describes it (runs 1 and 2); the device has filed both.
      for (const [i, id] of [LINK_A, LINK_B].entries()) {
        expect(await beginSealedRun(d, id, T0 + 2100 + i)).toMatchObject({ describes: true, hasMore: false });
        await sealLinkDescription(d, { bank: `Bank ${id}`, accounts: [] });
        expect(await completeSealedRun(d, T0 + 2100 + i)).toEqual({ run: i + 1 });
        x.filing = afterRun(x.filing, await openRun(x.filing, await handed(db, i + 1)));
      }
    }
    await fn(x);
  });
}

/** A whole run for one link, step by step, as the job will run it. */
export async function run(
  x: World,
  linkId: string,
  provider: BankDataProvider,
  now: number,
  balances?: unknown,
) {
  expect(await beginSealedRun(x.d, linkId, now)).toMatchObject({ linkId });
  for (let i = 0; ; i++) {
    const r = await fetchSealedPage(x.d, provider, 100);
    if (r !== 'restarted' && !r.more) break;
    if (i > 20) throw new Error('never ends');
  }
  if (balances !== undefined) await sealBankAnswer(x.d, 1, balances);
  return completeSealedRun(x.d, now);
}

/** What the server hands a device for run `n`. */
export async function handed(db: Db, n: number) {
  const r = (await runsAfter(db, n - 1, 1))[0]!;
  const pages: Uint8Array[] = [];
  for (let p = 0; p < r.pages; p++) pages.push((await sealedPageOf(db, n, p))!);
  return { manifest: r.manifest, signature: r.signature, pages };
}

export const TWO_PAGES = {
  '': { added: 3, modified: 1, next: 'c1', more: true },
  c1: { added: 2, removed: 4, next: 'c2', more: false },
};
