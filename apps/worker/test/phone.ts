// The app as a device runs it (D-102): every budget is locked, so every screen and every change is answered by the
// engine over the device's own copy (src/local/engine.ts, with the routes of src/routes); only sign-in and the
// account's own calls go to the Worker. Tests read numbers through this, so they check the code production runs.
//
// A test's budget is the November fixture (src/dev-seed.ts), loaded into the copy by `POST /__dev/seed-november`
// as the old dev route did on the server. `phoneDb()` reads and writes the copy's own tables; what a test writes
// there directly is worked out again before the next screen, as a log entry's rows would be.
import { SELF, env } from 'cloudflare:test';
import { toValue, type Db, type Result, type SqlValue, type Stmt } from '@ledgerline/db/sql';
import { expect } from 'vitest';
import { seedNovember } from '../src/dev-seed.js';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import { SYNC_FORMAT } from '../src/sync-tables.js';
import { storeDb } from './store-db.js';

const ORIGIN = 'https://ledgerline.test';
/** The test server's clock (FAKE_NOW), moving on from when the file started, as a device's corrected clock does. */
const FAKE = Date.parse((env as unknown as { FAKE_NOW: string }).FAKE_NOW);
const started = Date.now();
export const deviceNow = (): number => FAKE + (Date.now() - started);

let copies = 0;
let current: Promise<LocalEngine> | null = null;
/** Copies a test wrote to directly: worked out again (all of it) before the next screen. */
const touched = new WeakSet<LocalEngine>();

/** The signed-in dev user's budget, as the Worker's session says it. */
export async function budgetOf(): Promise<{ budgetId: string; email: string }> {
  const r = await SELF.fetch(`${ORIGIN}/api/session`, { headers: { 'x-ledgerline-sealed': '1' } });
  expect(r.status, '/api/session').toBe(200);
  const s = (await r.json()) as { budgetId: string; user: { email: string } };
  return { budgetId: s.budgetId, email: s.user.email };
}

/** A new, empty copy of the signed-in user's budget. */
export async function newCopy(name = `phone-copy-${++copies}`): Promise<LocalEngine> {
  const { budgetId, email } = await budgetOf();
  const db = storeDb(name);
  await migrateLocal(db, deviceNow());
  return new LocalEngine(db, { budgetId, userId: 'phone', email }, deviceNow);
}

/** The device's copy for this test file (one per file). */
export function phone(): Promise<LocalEngine> {
  current ??= newCopy();
  return current;
}

/** Loads the November fixture into a copy, in place of what it held, and works it all out. */
export async function seed(e?: LocalEngine): Promise<LocalEngine> {
  const engine = e ?? (await phone());
  const { budgetId } = await budgetOf();
  // The copy stands at the log's first entry, as a device's copy of a locked budget does.
  if ((await engine.state()).epoch === null)
    await engine.apply({
      format: SYNC_FORMAT,
      epoch: 'log',
      serverTime: deviceNow(),
      through: 1,
      more: false,
      cursor: null,
      rows: [],
    });
  await engine.db
    .prepare(
      `INSERT OR IGNORE INTO budget (id, name, created_at, updated_at) VALUES (?1, 'My budget', ?2, ?2)`,
    )
    .bind(budgetId, FAKE)
    .run();
  await seedNovember(engine.db, budgetId, 'phone', FAKE);
  await everythingAgain(engine);
  return engine;
}

/** Marks a copy for a full derive and runs it: after a test wrote to its tables directly. */
export async function everythingAgain(e: LocalEngine): Promise<void> {
  await e.db
    .prepare(
      `INSERT INTO local_state (key, value) VALUES ('derive', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(JSON.stringify({ full: true, keys: [], fromMonth: null }))
    .run();
  await e.derive();
  touched.delete(e);
}

/**
 * Brings a copy up to date before a screen: seeds an empty one with November (as the old download did), and works
 * out again what a test wrote to it directly.
 */
export async function syncPhone(engine?: LocalEngine): Promise<LocalEngine> {
  const e = engine ?? (await phone());
  const held = await e.db.prepare(`SELECT count(*) AS n FROM budget`).first<{ n: number }>();
  if (!held?.n) return seed(e);
  if (touched.has(e)) await everythingAgain(e);
  else if (await e.needsDerive()) await e.derive();
  return e;
}

/** What only the Worker answers: sign-in, the account, and the banks' server side. */
const SERVER = [
  /^\/api\/auth\//,
  /^\/api\/settings\/security(\/|$)/,
  /^\/api\/settings\/connections\/(link-token|link-finish|refresh)$/,
  /^\/api\/settings\/connections\/[^/]+\/(refresh|remove)$/,
  /^\/api\/(usage|notes|identity-alert|health|log|start|cutover)(\/|$)/,
];

/** A fetch the way the app makes it: a screen or a change from the device's copy, anything else from the Worker. */
export async function app(path: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const pathname = path.split('?')[0]!;
  if (method === 'POST' && pathname === '/__dev/seed-november') {
    const e = await seed();
    return Response.json({ ok: true, budgetId: (await budgetOf()).budgetId, copy: !!e });
  }
  if (SERVER.some((r) => r.test(pathname))) return SELF.fetch(`${ORIGIN}${path}`, init);
  const e = await syncPhone();
  const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
  return e.request(method, path, method === 'GET' || method === 'HEAD' ? undefined : (body ?? {}));
}

class CopyStatement implements Stmt {
  constructor(
    private readonly db: CopyDb,
    readonly sql: string,
    readonly params: readonly SqlValue[] = [],
  ) {}
  bind(...values: unknown[]): Stmt {
    return new CopyStatement(this.db, this.sql, values.map(toValue));
  }
  async real(): Promise<Stmt> {
    const s = (await this.db.engine()).db.prepare(this.sql);
    return this.params.length ? s.bind(...this.params) : s;
  }
  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    return (await this.real()).first<T>(col);
  }
  async all<T = Record<string, unknown>>(): Promise<Result<T>> {
    return (await this.real()).all<T>();
  }
  async run<T = Record<string, unknown>>(): Promise<Result<T>> {
    if (!/^\s*select\b/i.test(this.sql)) touched.add(await this.db.engine());
    return (await this.real()).run<T>();
  }
}

class CopyDb implements Db {
  constructor(readonly engine: () => Promise<LocalEngine>) {}
  prepare(sql: string): Stmt {
    return new CopyStatement(this, sql);
  }
  async batch<T = unknown>(stmts: Stmt[]): Promise<Result<T>[]> {
    const e = await this.engine();
    if (stmts.some((s) => !/^\s*select\b/i.test(s.sql))) touched.add(e);
    return e.db.batch<T>(await Promise.all(stmts.map((s) => (s as CopyStatement).real())));
  }
}

/** The device's copy for this test file, as a database: the budget's own tables. */
export const phoneDb = (): Db => new CopyDb(phone);
