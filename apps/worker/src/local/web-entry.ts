// The phone's engine in a Web Worker (docs/phone-budget.md, D-45). The web app (apps/web/src/copy/host.ts) starts it
// with `new Worker(new URL(...))`; Vite bundles it with sql.js. It holds the decrypted copy in memory only: the app
// decrypts the saved copy before `open` and encrypts what `export` returns. Messages are { id, op, ...args } and
// every answer is { id, ok, value } or { id, ok: false, error }.
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { LocalEngine, migrateLocal, type EngineIdentity, type QueuedEdit } from './engine.js';
import { SqlJsDb } from './sqljs-db.js';
import { encodeEntry, readEntry, type BudgetKeys } from '@ledgerline/seal';
import type { RestBatch, SyncPage } from '../routes/sync.js';
import { cutoverOnDevice } from './cutover-device.js';
import { DeviceLog } from './device-log.js';
import { checkSnapshot, emptyOldCopy, openSnapshot, writeSnapshot } from './device-snapshot.js';
import { cutoverTransport, httpTransport, type Fetch } from './http-transport.js';
import { LogSession } from './log-session.js';
import { reader, type ShadowEvent } from './shadow.js';

interface Ctx {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: unknown, transfer?: ArrayBuffer[]): void;
}
const ctx = self as unknown as Ctx;

type Msg =
  | { id: number; op: 'open'; who: EngineIdentity; bytes: ArrayBuffer | null }
  | { id: number; op: 'apply'; page: SyncPage; receivedAt: number }
  | { id: number; op: 'next' }
  | { id: number; op: 'derive' }
  | {
      id: number;
      op: 'request';
      method: string;
      path: string;
      body?: unknown;
      edit?: { id: string; at: number };
    }
  | { id: number; op: 'enqueue'; edit: QueuedEdit }
  | { id: number; op: 'queue' }
  | { id: number; op: 'queueSending'; editId: string }
  | { id: number; op: 'queueDone'; editId: string }
  | { id: number; op: 'queueRefused'; editId: string }
  | { id: number; op: 'shadowFork' }
  | { id: number; op: 'shadowBegin'; token: number; runs: ShadowEvent[] }
  | { id: number; op: 'shadowStep'; token: number }
  | { id: number; op: 'shadowEnd'; token: number }
  | { id: number; op: 'export' }
  | { id: number; op: 'state' }
  | { id: number; op: 'rta' }
  | { id: number; op: 'clear' }
  | { id: number; op: 'get'; key: string }
  | { id: number; op: 'put'; key: string; value: string | null }
  | { id: number; op: 'close' }
  // ---- a sealed budget (docs/privacy.md 5.3): the copy lives on the log
  | { id: number; op: 'sealedOpen'; keys: BudgetKeys[]; deviceId: string; workerKeys: [number, Uint8Array][] }
  | { id: number; op: 'sealedJoin' }
  | { id: number; op: 'sealedSync' }
  | { id: number; op: 'sealedSnapshot'; snapshotId: string }
  | { id: number; op: 'sealedCheck' }
  | { id: number; op: 'sealedUpkeep'; snapshotId: string }
  | { id: number; op: 'sealedPlace' }
  | { id: number; op: 'sealedAppend'; entries: Uint8Array[]; keys?: BudgetKeys[] }
  | {
      id: number;
      op: 'cutover';
      keys: BudgetKeys;
      genesis: Uint8Array;
      deviceId: string;
      snapshotId: string;
    };

let sqlite: Awaited<ReturnType<typeof initSqlJs>> | null = null;
let db: SqlJsDb | null = null;
let who: EngineIdentity | null = null;
let engine: LocalEngine | null = null;

/** A sealed budget's keys and place in the log, once `sealedOpen` gave them. Held in memory only. */
let sealed: {
  keys: BudgetKeys[];
  deviceId: string;
  workerKeys: Map<number, Uint8Array>;
  log: DeviceLog | null;
} | null = null;

/** The app's own origin, with the session's cookie. */
// (A request to the app's own origin carries the cookie by default.)
/**
 * The server's clock less this device's, as last seen: from the old sync when the copy opens, then from each
 * answer of the log's routes. The log refuses an entry dated more than 5 minutes off the server's clock, so the
 * device's own clock never dates one.
 */
let skew = 0;
const clock = (): number => Date.now() + skew;
/** Entries since the newest snapshot that make the next one worth writing (a day or two of use and bank updates). */
const SNAPSHOT_EVERY = 60;

const call: Fetch = async (path, init) => {
  const asked = Date.now();
  const r = await fetch(path, init);
  const t = Number(r.headers.get('x-ledgerline-time'));
  // Half the round trip is the best guess of when the server read its clock.
  // A time a day off this device's own clock is no clock: it is not taken (the log would refuse such entries).
  const seen = t - (asked + Date.now()) / 2;
  if (Number.isFinite(t) && t > 0 && Math.abs(seen) < 86_400_000) skew = seen;
  return r;
};
const http = httpTransport(call);

function needSealed(): { engine: LocalEngine; s: NonNullable<typeof sealed>; log: DeviceLog } {
  const { engine: e } = need();
  if (!sealed?.log) throw new Error('Your budget isn’t open on this device yet. Try again.');
  return { engine: e, s: sealed, log: sealed.log };
}

/** An empty copy in a second database, for work that must not touch the real one. */
async function scratch(who: EngineIdentity): Promise<{ engine: LocalEngine; close: () => void }> {
  const copy = new sqlite!.Database();
  const d = new SqlJsDb(copy);
  await migrateLocal(d, Date.now());
  return { engine: new LocalEngine(d, who, () => Date.now()), close: () => copy.close() };
}

/** Brings the copy up to date with a budget that is not sealed yet: the synced tables, then the rest. */
async function oldSync(e: LocalEngine): Promise<void> {
  for (let n = 0; n < 10_000; n++) {
    const { since, cursor } = await e.nextRequest();
    const q = new URLSearchParams({ since: String(since), limit: '200' });
    if (cursor) q.set('cursor', cursor);
    const r = await call(`/api/sync?${q}`);
    if (!r.ok) throw new Error('The server gave no answer. Try again.');
    if ((await e.apply((await r.json()) as SyncPage, Date.now())).caughtUp) break;
  }
  await e.restAgain();
  for (let n = 0; n < 10_000; n++) {
    const ask = await e.restRequest();
    if (!ask) return;
    const q = new URLSearchParams({ table: ask.table });
    if (ask.after !== null) q.set('after', String(ask.after));
    const r = await call(`/api/sync/rest?${q}`);
    if (!r.ok) throw new Error('The server gave no answer. Try again.');
    await e.applyRest((await r.json()) as RestBatch);
  }
}

/**
 * A copy that has a place in a sealed log takes nothing from the old sync and sends no change the old way,
 * whatever the page says the budget is: a server that answers as if the budget were not sealed gets nothing.
 */
async function plainOnly(): Promise<void> {
  if (await need().engine.noted(LogSession.PLACE))
    throw new Error('Your budget is locked on this device. Nothing was sent.');
}

function need(): { db: SqlJsDb; engine: LocalEngine } {
  if (!db || !engine) throw new Error('Your budget isn’t open on this device yet. Try again.');
  return { db, engine };
}

async function handle(m: Msg): Promise<{ value: unknown; transfer?: ArrayBuffer[] }> {
  switch (m.op) {
    case 'open': {
      sqlite ??= await initSqlJs({ locateFile: () => wasmUrl });
      db?.db.close();
      db = new SqlJsDb(m.bytes ? new sqlite.Database(new Uint8Array(m.bytes)) : new sqlite.Database());
      await migrateLocal(db, Date.now());
      who = m.who;
      sealed = null;
      engine = new LocalEngine(
        db,
        m.who,
        () => Date.now(),
        async (r) => ctx.postMessage({ event: 'identity', ...r }),
        // A scratch copy for the shadow run: the same bytes in a second database, closed when the run ends.
        async () => {
          const copy = new sqlite!.Database(db!.db.export());
          return { db: new SqlJsDb(copy), close: () => copy.close() };
        },
      );
      return { value: await engine.state() };
    }
    case 'apply':
      await plainOnly();
      return { value: await need().engine.apply(m.page, m.receivedAt) };
    case 'next':
      return { value: await need().engine.nextRequest() };
    case 'derive':
      return { value: await need().engine.derive() };
    case 'request': {
      const r = await need().engine.request(m.method, m.path, m.body, m.edit);
      const text = await r.text();
      return { value: { status: r.status, body: text } };
    }
    case 'enqueue': {
      const r = await need().engine.enqueue(m.edit);
      return { value: { status: r.response.status, body: await r.response.text(), queued: r.queued } };
    }
    case 'queue':
      // Only what the app shows and sends: the rows kept for an undo stay in the engine.
      return {
        value: (await need().engine.queue()).map(
          ({ undo: _undo, through: _through, rows: _rows, ...e }) => e,
        ),
      };
    case 'queueSending':
      await plainOnly();
      await need().engine.queueSending(m.editId);
      return { value: null };
    case 'queueDone':
      return { value: await need().engine.queueDone(m.editId) };
    case 'queueRefused':
      return { value: await need().engine.queueRefused(m.editId) };
    case 'shadowFork':
      return { value: await need().engine.shadowFork() };
    case 'shadowBegin':
      return { value: await need().engine.shadowBegin(m.token, m.runs) };
    case 'shadowStep':
      return { value: await need().engine.shadowStep(m.token) };
    case 'shadowEnd':
      return { value: await need().engine.shadowEnd(m.token) };
    case 'export': {
      const bytes = need().db.db.export();
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return { value: buf, transfer: [buf] };
    }
    case 'state':
      return { value: await need().engine.state() };
    case 'rta':
      return { value: await need().engine.rta() };
    case 'clear':
      await need().engine.clear();
      return { value: null };
    case 'get': {
      const r = await need()
        .db.prepare(`SELECT value FROM local_state WHERE key = ?1`)
        .bind(m.key)
        .first<{ value: string }>();
      return { value: r?.value ?? null };
    }
    case 'put': {
      const d = need().db;
      await (m.value === null
        ? d.prepare(`DELETE FROM local_state WHERE key = ?1`).bind(m.key).run()
        : d
            .prepare(
              `INSERT INTO local_state (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
            )
            .bind(m.key, m.value)
            .run());
      return { value: null };
    }
    case 'close':
      db?.db.close();
      db = null;
      engine = null;
      sealed = null;
      return { value: null };
    case 'sealedOpen': {
      const e = need().engine;
      if (!skew) skew = (await e.state()).offset;
      sealed = { keys: m.keys, deviceId: m.deviceId, workerKeys: new Map(m.workerKeys), log: null };
      const place = await e.noted(LogSession.PLACE);
      if (place) sealed.log = await DeviceLog.restore(m.keys, place, m.deviceId, clock);
      // No place kept: a new device, or a copy made again. `sealedJoin` opens a snapshot.
      return { value: { ready: sealed.log !== null, number: sealed.log?.number ?? 0 } };
    }
    case 'sealedJoin': {
      const e = need().engine;
      if (!sealed) throw new Error('Your budget isn’t open on this device yet. Try again.');
      // No place in the log (sealedOpen said so): a copy from before the move is emptied first.
      const dropped = await emptyOldCopy(e);
      sealed.log = await openSnapshot(e, http, {
        keys: sealed.keys,
        budgetId: who!.budgetId,
        deviceId: sealed.deviceId,
        clock,
      });
      await e.note(LogSession.PLACE, sealed.log.save());
      return { value: { number: sealed.log.number, dropped } };
    }
    case 'sealedSync': {
      const { engine: e, s, log } = needSealed();
      const session = new LogSession(e, log, http, encodeEntry);
      const pulled = await session.pull();
      const runs = await session.fileRuns(http, {
        workerKeys: s.workerKeys,
        provider: reader,
        now: await e.now(),
      });
      // The daily scan once the bank runs are in (the device's clock as the server's).
      const scans = runs.waiting ? 0 : await session.scan(clock());
      const sent = await session.flush();
      return {
        value: {
          entries: pulled.entries,
          filed: runs.filed + scans,
          waiting: runs.waiting,
          sent: sent.sent,
          lost: pulled.lost + runs.lost + sent.lost,
        },
      };
    }
    case 'sealedSnapshot': {
      const { engine: e, log } = needSealed();
      return { value: await writeSnapshot(e, log, http, m.snapshotId) };
    }
    case 'sealedUpkeep': {
      // Now and then (the app decides when): check the newest snapshot if it waits for its check, else write a new
      // one once enough entries came since the last. One of the two at most, so a call is never long twice.
      const { engine: e, log } = needSealed();
      const list = await http.list();
      const newest = list[0];
      if (newest && !newest.check && list.length > 1) {
        const s = await scratch(who!);
        try {
          return { value: { did: 'check', ...(await checkSnapshot(s.engine, log, http, clock)) } };
        } finally {
          s.close();
        }
      }
      if (!newest || log.number - newest.number >= SNAPSHOT_EVERY)
        return { value: { did: 'write', ...(await writeSnapshot(e, log, http, m.snapshotId)) } };
      return { value: { did: 'nothing' } };
    }
    case 'sealedPlace': {
      // Where a public entry the app makes goes (a way in added or removed): the log is read up to its end
      // first, so the entry goes on top of the newest one.
      const { engine: e, log } = needSealed();
      await new LogSession(e, log, http, encodeEntry).pull();
      return { value: log.writePlace() };
    }
    case 'sealedAppend': {
      // Public entries the app made with the budget key in hand (apps/web/src/copy/sealed-ways.ts), sent as one
      // write on top of this device's place. Taken as any other entry: read back from the log, by its rules.
      // `keys`: the derived keys of the version a key change here brings.
      const { engine: e, s, log } = needSealed();
      const first = (await readEntry(m.entries[0]!)).header;
      if (first.number !== log.number + 1 || first.deviceId !== s.deviceId)
        return { value: { ok: false, why: 'behind', number: log.number, retry: true } };
      const r = await http.append(log.number, m.entries);
      if (!r.ok) return { value: r };
      if (m.keys?.length) {
        log.holdKeys(m.keys);
        for (const k of m.keys) if (!s.keys.some((x) => x.version === k.version)) s.keys.push(k);
      }
      await new LogSession(e, log, http, encodeEntry).pull();
      return { value: { ok: true, number: log.number } };
    }
    case 'sealedCheck': {
      const { log } = needSealed();
      const s = await scratch(who!);
      try {
        return { value: await checkSnapshot(s.engine, log, http, clock) };
      } finally {
        s.close();
      }
    }
    case 'cutover': {
      const e = need().engine;
      if (!skew) skew = (await e.state()).offset;
      const r = await cutoverOnDevice(e, {
        keys: m.keys,
        genesis: await readEntry(m.genesis),
        budgetId: who!.budgetId,
        deviceId: m.deviceId,
        clock,
        snapshotId: m.snapshotId,
        encode: encodeEntry,
        sync: () => oldSync(e),
        cutover: cutoverTransport(call),
        snapshots: http,
      });
      if (!r.ok) return { value: r };
      sealed = {
        keys: [m.keys],
        deviceId: m.deviceId,
        workerKeys: sealed?.workerKeys ?? new Map(),
        log: r.log,
      };
      return { value: { ok: true, number: r.log.number } };
    }
  }
}

// One message at a time, in order: the engine's SQL never interleaves.
let queue: Promise<void> = Promise.resolve();
ctx.onmessage = (e: MessageEvent) => {
  const m = e.data as Msg;
  queue = queue.then(async () => {
    try {
      const { value, transfer } = await handle(m);
      ctx.postMessage({ id: m.id, ok: true, value }, transfer);
    } catch (err) {
      ctx.postMessage({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
};
