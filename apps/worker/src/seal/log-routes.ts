// The routes of a budget's sealed log (docs/privacy.md 5.3; seal/log-store.ts). The store mounts them only for a
// budget marked sealed (store/marks.ts): before the cutover no budget is, and they answer nothing. A sealed
// budget has no other routes: its old tables are not read or written any more.
//
// The first entry of a log is not written here: the cutover stores it with the budget's first snapshot, in one
// step (section 8, step 6).
import { CSRF_HEADER } from '@ledgerline/contracts';
import { parseKeyring } from '@ledgerline/platform';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requestNow } from '../http/clock.js';
import type { AppEnv } from '../http/context.js';
import { csrf } from '../http/security.js';
import { classifyUsage, dailyLimits, usageToday } from '../sync/breaker.js';
import { logAfter, logAppend, logHead, type LogDeps } from './log-store.js';
import {
  logFloor,
  snapshotBegin,
  snapshotCheck,
  snapshotChunk,
  snapshotChunkOf,
  snapshotList,
  snapshotManifest,
  snapshotPrune,
  type SnapshotDeps,
} from './snapshot-store.js';
import {
  keyStampStmts,
  lastCompleteRun,
  receiptHashes,
  runsAfter,
  runDeps,
  sealedPageOf,
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
/**
 * The same guard as every other route (http/security.ts), with one more body type: a snapshot's chunk is sealed
 * bytes, sent as `application/octet-stream`. Like JSON, that type can't be sent across sites without a
 * preflight, and the app's own header and the origin are checked as for any write.
 */
logApi.use('*', async (c, next) => {
  const chunk =
    c.req.method === 'PUT' &&
    /\/log\/snapshots\/[^/]+\/chunks\/\d+$/.test(new URL(c.req.url).pathname) &&
    (c.req.header('content-type') ?? '').toLowerCase().startsWith('application/octet-stream');
  if (!chunk) return csrf(c, next);
  const origin = c.req.header('origin');
  if (c.req.header(CSRF_HEADER) !== '1' || (origin && origin !== new URL(c.req.url).origin))
    return c.json({ error: 'csrf', message: TRY_AGAIN }, 403);
  return next();
});

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
  // `floor`: sealed entries below it may be gone; a device whose place is lower opens a snapshot (below).
  return c.json({ entries, number, more: after + entries.length < number, floor: await logFloor(db) });
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
  const runs: RunDeps = runDeps(
    c.env.DB,
    c.get('budgetId'),
    parseKeyring(c.env.TOKEN_KEYS, c.env.TOKEN_KEY_CURRENT),
  );
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

/** The most runs one answer names, and the most text: a manifest grows with its pages. A run's pages are read one by one. */
const PAGE_RUNS = 64;
const RUNS_CHARS = 400_000;

/**
 * The complete bank runs after run `after`, in order: each manifest as the Worker signed it, its signature, and
 * how many sealed pages it has. `last` is the newest complete run; `more` says to ask again after the last one
 * given.
 */
logApi.get('/log/runs', async (c) => {
  const after = Number(c.req.query('after') ?? '0');
  if (!Number.isSafeInteger(after) || after < 0) return c.json({ error: 'invalid', message: TRY_AGAIN }, 400);
  const runs: { run: number; manifest: string; signature: string; pages: number }[] = [];
  let chars = 0;
  for (const r of await runsAfter(c.env.DB, after, PAGE_RUNS)) {
    const manifest = b64(r.manifest);
    // Always at least one run, then as many as fit one answer.
    if (runs.length && chars + manifest.length > RUNS_CHARS) break;
    runs.push({ run: r.run, manifest, signature: b64(r.signature), pages: r.pages });
    chars += manifest.length;
  }
  const last = await lastCompleteRun(c.env.DB);
  return c.json({ runs, last, more: (runs.at(-1)?.run ?? after) < last });
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

// ---- snapshots (seal/snapshot-store.ts)

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const Begin = z.object({
  header: z.string().regex(B64).max(2_000),
  signature: z.string().regex(B64).max(200),
  manifest: z.string().regex(B64).max(600_000),
  chunks: z.number().int().min(1).max(4096),
});
const Check = z.object({
  deviceId: z.string().length(26),
  signature: z.string().regex(B64).max(200),
});
const bytes = (b: Uint8Array) =>
  new Response(b as Uint8Array<ArrayBuffer>, {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
  });

async function snapshotDeps(c: Context<AppEnv>): Promise<SnapshotDeps> {
  const ask = c.env.USAGE_FOR_WRITE ?? c.env.USAGE;
  const u = ask ? await ask() : await usageToday(c.env);
  const state = classifyUsage(u.written, u.read, u.do, u.workers, dailyLimits(c.env));
  return {
    db: c.env.DB,
    budgetId: c.get('budgetId'),
    now: requestNow(c),
    resting: state === 'readonly' || state === 'rest',
  };
}

/** The whole snapshots the server keeps, newest first: each clear header with its signature and check record. */
logApi.get('/log/snapshots', async (c) => {
  const list = await snapshotList(c.env.DB);
  return c.json({
    snapshots: list.map((s) => ({
      id: s.id,
      number: s.number,
      header: b64(s.header),
      signature: b64(s.signature),
      chunks: s.chunks,
      checked: s.checked,
      check: s.check ? { deviceId: s.check.deviceId, signature: b64(s.check.signature) } : null,
    })),
  });
});

/** Begins a snapshot: its signed header, its sealed manifest, and how many chunks follow. */
logApi.post('/log/snapshots', async (c) => {
  const parsed = Begin.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid', message: TRY_AGAIN }, 400);
  const r = await snapshotBegin(await snapshotDeps(c), {
    header: unb64(parsed.data.header),
    signature: unb64(parsed.data.signature),
    manifest: unb64(parsed.data.manifest),
    chunks: parsed.data.chunks,
  });
  return c.json(r, r.ok ? 200 : 409);
});

/** One sealed chunk of a snapshot that was begun, as bytes. */
logApi.put('/log/snapshots/:id/chunks/:k', async (c) => {
  const k = Number(c.req.param('k'));
  const length = Number(c.req.header('content-length') ?? '0');
  // Refused by its stated size before the body is read.
  if (!(length > 0) || length > 1_100_000) return c.json({ ok: false, why: 'too large' }, 409);
  const body = new Uint8Array(await c.req.arrayBuffer());
  const r = await snapshotChunk(await snapshotDeps(c), c.req.param('id'), k, body);
  return c.json(r, r.ok ? 200 : 409);
});

logApi.get('/log/snapshots/:id/manifest', async (c) => {
  const m = await snapshotManifest(c.env.DB, c.req.param('id'));
  return m ? bytes(m) : c.json({ error: 'not_found', message: TRY_AGAIN }, 404);
});

logApi.get('/log/snapshots/:id/chunks/:k', async (c) => {
  const k = Number(c.req.param('k'));
  const b = Number.isSafeInteger(k) ? await snapshotChunkOf(c.env.DB, c.req.param('id'), k) : null;
  return b ? bytes(b) : c.json({ error: 'not_found', message: TRY_AGAIN }, 404);
});

/**
 * A device's check record for a snapshot: it rebuilt the budget and got the same. The delete rule then runs
 * once (a few hundred rows); the fetch backstop finishes it.
 */
logApi.post('/log/snapshots/:id/check', async (c) => {
  const parsed = Check.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid', message: TRY_AGAIN }, 400);
  const d = await snapshotDeps(c);
  const r = await snapshotCheck(d, c.req.param('id'), parsed.data.deviceId, unb64(parsed.data.signature));
  if (r.ok && !d.resting) await snapshotPrune(c.env.DB);
  return c.json(r, r.ok ? 200 : 409);
});
