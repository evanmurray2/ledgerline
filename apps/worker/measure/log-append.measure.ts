// One append to a sealed budget's log on the server (src/seal/log-store.ts logAppend), whole: reading the log's
// state, the rules of the log and the server's, and storing the entries, on node:sqlite as a Durable Object pays
// it. Two cases: the largest write (16 entries of 64 KB, about 1 MB), and one small entry on a log whose state
// names many devices and many public entries (that state was one JSON value, parsed and written on every
// append, until Nov 13, 2026). Then the largest write through the route itself (src/seal/log-routes.ts POST
// /log/append): reading the body, JSON, the schema's checks, base64 and the append. Writes .measure/log-append.json
// for docs/measurements.md.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CSRF_HEADER } from '@ledgerline/contracts';
import { fromBase64, toBase64 } from '@ledgerline/platform';
import { Hono } from 'hono';
import { test } from 'vitest';
import { encodeEntry, randomBytes, readEntry, type Entry } from '@ledgerline/seal';
import { NodeDb, applyMigrations } from '../../../packages/db/src/node-db.js';
import type { AppEnv } from '../src/http/context.js';
import { logApi } from '../src/seal/log-routes.js';
import { logAppend, logGenesis, type LogDeps } from '../src/seal/log-store.js';
import { BUDGET, Writer } from '../test/log-writer.js';
import { stats } from './harness.js';

const RUNS = 30;

function storeDb(): NodeDb {
  const d = new NodeDb();
  const read = (dir: string, prefix = '') =>
    readdirSync(new URL(dir, import.meta.url))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((name) => ({
        name: prefix + name,
        sql: readFileSync(new URL(dir + name, import.meta.url), 'utf8'),
      }));
  // The budget's migrations, then the store's own, as a BudgetStore runs them.
  for (const m of [
    ...read('../../../packages/db/budget-migrations/'),
    ...read('../../../packages/db/store-migrations/'),
  ])
    applyMigrations(d, [m]);
  return d;
}

const deps = (db: NodeDb, now: number): LogDeps => ({
  db,
  budgetId: BUDGET,
  now,
  resting: false,
  freshWay: false,
  lastCompleteRun: 0,
  receiptHashes: async () => null,
});

/** Makes the stored state as large as a long-lived budget's: `devices` device counters, `publics` public entries. */
function grow(db: NodeDb, devices: number, publics: number): void {
  const row = db.db.prepare(`SELECT state FROM log_state WHERE id = 1`).get() as { state: string };
  const s = JSON.parse(row.state) as {
    counters: { $map: [string, number][] };
    public: { publics: unknown[] };
  };
  for (let i = 0; i < devices; i++) s.counters.$map.push([`01DEV${String(i).padStart(21, '0')}`, 1]);
  const hash = { $bytes: toBase64(randomBytes(32)) };
  for (let i = 0; i < publics; i++) s.public.publics.push({ number: 1, hash, keyVersion: 1 });
  db.db.prepare(`UPDATE log_state SET state = ?1 WHERE id = 1`).run(JSON.stringify(s));
}

async function timeAppends(
  w: Writer,
  db: NodeDb,
  write: () => Promise<Entry[]>,
): Promise<{ first: number; median: number; p90: number; max: number }> {
  const xs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const entries = await write();
    const base = entries[0]!.header.number - 1;
    const bytes = entries.map(encodeEntry);
    const t0 = performance.now();
    const r = await logAppend(deps(db, w.time), base, bytes);
    xs.push(performance.now() - t0);
    if (!r.ok) throw new Error(`refused: ${JSON.stringify(r)}`);
  }
  return stats(xs);
}

test('one append to the sealed log, whole', async () => {
  const out: Record<string, unknown> = { runs: RUNS };

  // The largest write: 16 entries of 64 KB.
  {
    const db = storeDb();
    const w = new Writer();
    await logGenesis(deps(db, w.time), encodeEntry(await w.genesis()));
    const write = async () => {
      const xs: Entry[] = [];
      for (let i = 0; i < 16; i++) xs.push(await w.entry(1, 'x'.repeat(65_000)));
      return xs;
    };
    out.write16Entries64Kb = await timeAppends(w, db, write);
    // Of that, reading the 16 entries from their bytes (hashes worked out again).
    const bytes = (await write()).map(encodeEntry);
    const xs: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      for (const b of bytes) await readEntry(b);
      xs.push(performance.now() - t0);
    }
    out.read16Entries64Kb = stats(xs);
  }

  // One small entry, on a state of 4,000 devices and 2,000 public entries.
  {
    const db = storeDb();
    const w = new Writer();
    await logGenesis(deps(db, w.time), encodeEntry(await w.genesis()));
    grow(db, 4000, 2000);
    out.write1EntryLargeState = await timeAppends(w, db, async () => [await w.edit('one small edit')]);
  }

  // The largest write through the route: the request as a device sends it.
  {
    const db = storeDb();
    const w = new Writer();
    await logGenesis(deps(db, w.time), encodeEntry(await w.genesis()));
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('budgetId', BUDGET);
      await next();
    });
    app.route('/', logApi);
    const usage = { written: 0, read: 0, do: { requests: 0, gbs: 0 }, workers: 0, refreshedAt: null };
    const route: number[] = [];
    const parse: number[] = [];
    const decode: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const entries: Entry[] = [];
      for (let j = 0; j < 16; j++) entries.push(await w.entry(1, 'x'.repeat(65_000)));
      const texts = entries.map((e) => toBase64(encodeEntry(e)));
      const body = JSON.stringify({ base: entries[0]!.header.number - 1, entries: texts });
      const env = {
        DB: db,
        NOW: w.time,
        TOKEN_KEYS: '1:a passphrase of at least thirty-two characters!',
        TOKEN_KEY_CURRENT: '1',
        USAGE: async () => usage,
      };
      const req = new Request('https://app.test/log/append', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
        body,
      });
      const t0 = performance.now();
      const res = await app.fetch(req, env as never);
      route.push(performance.now() - t0);
      if (res.status !== 200) throw new Error(`refused: ${res.status} ${await res.text()}`);
      // Of that: JSON, and base64 back to bytes.
      const t1 = performance.now();
      JSON.parse(body);
      parse.push(performance.now() - t1);
      const t2 = performance.now();
      for (const t of texts) fromBase64(t);
      decode.push(performance.now() - t2);
    }
    out.route16Entries64Kb = stats(route);
    out.routeJson = stats(parse);
    out.routeBase64 = stats(decode);
  }

  mkdirSync('.measure', { recursive: true });
  writeFileSync('.measure/log-append.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
});
