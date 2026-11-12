// The routes of a budget's sealed log (docs/privacy.md 5.3; seal/log-store.ts). The store mounts them only for a
// budget marked sealed (store/marks.ts): before the cutover no budget is, and they answer nothing. A sealed
// budget has no other routes: its old tables are not read or written any more.
//
// The first entry of a log is not written here: the cutover stores it with the budget's first snapshot, in one
// step (section 8, step 6).
import { parseKeyring } from '@ledgerline/platform';
import { Hono } from 'hono';
import { z } from 'zod';
import { requestNow } from '../http/clock.js';
import type { AppEnv } from '../http/context.js';
import { csrf } from '../http/security.js';
import { classifyUsage, dailyLimits, usageToday } from '../sync/breaker.js';
import { logAfter, logAppend, logHead, type LogDeps } from './log-store.js';
import {
  keyStampStmts,
  lastCompleteRun,
  receiptHashes,
  runsAfter,
  sealedPageOf,
  workerKeys,
  type RunDeps,
} from './runs.js';

/** The most entries one answer carries, and the most text: an entry is up to 64 KB sealed. */
const PAGE_ENTRIES = 32;
const PAGE_CHARS = 700_000;
const TRY_AGAIN = 'Something went wrong. Try again.';

const b64 = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const Append = z.object({
  base: z.number().int().min(1),
  // 16 entries of up to 64 KB sealed each, as base64.
  entries: z
    .array(
      z
        .string()
        .regex(/^[A-Za-z0-9+/]+={0,2}$/)
        .max(120_000),
    )
    .min(1)
    .max(16),
});

export const logApi = new Hono<AppEnv>();
logApi.use('*', csrf);

/** The entries after `after`, in order, as their devices signed them; `number` is where the log stands. */
logApi.get('/log', async (c) => {
  const after = Number(c.req.query('after') ?? '0');
  if (!Number.isSafeInteger(after) || after < 0) return c.json({ error: 'invalid', message: TRY_AGAIN }, 400);
  const db = c.env.DB;
  const entries: string[] = [];
  let chars = 0;
  for (const e of await logAfter(db, after, PAGE_ENTRIES)) {
    const text = b64(e.bytes);
    // Always at least one entry, then as many as fit one answer.
    if (entries.length && chars + text.length > PAGE_CHARS) break;
    entries.push(text);
    chars += text.length;
  }
  const number = await logHead(db);
  return c.json({ entries, number, more: after + entries.length < number });
});

/**
 * One write on top of entry `base`: stored whole, or not at all (5.3). The answer is the store's own: `ok`, or
 * why not and whether the device may try again after it has read the log.
 */
logApi.post('/log/append', async (c) => {
  const parsed = Append.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid', message: TRY_AGAIN }, 400);
  const now = requestNow(c);
  const ask = c.env.USAGE_FOR_WRITE ?? c.env.USAGE;
  const u = ask ? await ask() : await usageToday(c.env);
  const state = classifyUsage(u.written, u.read, u.do, u.workers, dailyLimits(c.env));
  const runs: RunDeps = {
    db: c.env.DB,
    budgetId: c.get('budgetId'),
    keys: workerKeys(parseKeyring(c.env.TOKEN_KEYS, c.env.TOKEN_KEY_CURRENT)),
  };
  const deps: LogDeps = {
    db: c.env.DB,
    budgetId: c.get('budgetId'),
    now,
    // The log's own rule decides what rests: a sign-out or a key change is never held back (5.3 check 7).
    resting: state === 'readonly' || state === 'rest',
    // Until the Directory tells the store how this session came in (a recovery key, or a passkey added in the
    // last 7 days), every session counts as a fresh way in: a key change needs an intent that has waited (D-89).
    freshWay: true,
    lastCompleteRun: await lastCompleteRun(c.env.DB),
    receiptHashes: (from, to) => receiptHashes(c.env.DB, from, to),
    // A key change brings new keys: each gets the Worker's stamp in the step that stores the write.
    stamps: (before, after) => keyStampStmts(runs, before, after, now),
  };
  const r = await logAppend(
    deps,
    parsed.data.base,
    parsed.data.entries.map((e) => unb64(e)),
  );
  return c.json(r, r.ok ? 200 : 409);
});

/** The most runs one answer names. A run's pages are read one by one. */
const PAGE_RUNS = 64;

/**
 * The complete bank runs after run `after`, in order: each manifest as the Worker signed it, its signature, and
 * how many sealed pages it has. `last` is the newest complete run.
 */
logApi.get('/log/runs', async (c) => {
  const after = Number(c.req.query('after') ?? '0');
  if (!Number.isSafeInteger(after) || after < 0) return c.json({ error: 'invalid', message: TRY_AGAIN }, 400);
  const runs = await runsAfter(c.env.DB, after, PAGE_RUNS);
  return c.json({
    runs: runs.map((r) => ({
      run: r.run,
      manifest: b64(r.manifest),
      signature: b64(r.signature),
      pages: r.pages,
    })),
    last: await lastCompleteRun(c.env.DB),
  });
});

/** One sealed page of a complete run, as bytes. */
logApi.get('/log/runs/:run/:page', async (c) => {
  const run = Number(c.req.param('run'));
  const page = Number(c.req.param('page'));
  if (!Number.isSafeInteger(run) || run < 1 || !Number.isSafeInteger(page) || page < 0)
    return c.json({ error: 'invalid', message: TRY_AGAIN }, 400);
  const bytes = await sealedPageOf(c.env.DB, run, page);
  if (!bytes) return c.json({ error: 'not_found', message: TRY_AGAIN }, 404);
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
  });
});
