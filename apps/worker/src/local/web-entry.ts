// The phone's engine in a Web Worker (docs/phone-budget.md, D-45). The web app (apps/web/src/copy/host.ts) starts it
// with `new Worker(new URL(...))`; Vite bundles it with sql.js. It holds the decrypted copy in memory only: the app
// decrypts the saved copy before `open` and encrypts what `export` returns. Messages are { id, op, ...args } and
// every answer is { id, ok, value } or { id, ok: false, error }.
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import {
  LocalEngine,
  migrateLocal,
  pendingMigrations,
  type EngineIdentity,
  type QueuedEdit,
} from './engine.js';
import { SqlJsDb } from './sqljs-db.js';
import {
  ACTION,
  type Action,
  encodeEntry,
  fromHex,
  KIND,
  readEntry,
  signRequest,
  toHex,
  type BudgetKeys,
} from '@ledgerline/seal';
import { SIGNED_CHALLENGE_HEADER, SIGNED_SIGNATURE_HEADER } from '@ledgerline/contracts';
import { DeviceLog } from './device-log.js';
import { deviceCheck, type DevicesDiffer } from './device-check.js';
import { checkSnapshot, openSnapshot, wipe, writeSnapshot } from './device-snapshot.js';
import { httpTransport, startTransport, type Fetch } from './http-transport.js';
import { startOnDevice } from './start-device.js';
import { LogSession } from './log-session.js';
import { afterRebuild, needsRebuild, readStale, rebuildFrom, unlessGone } from './rebuild.js';
import { pageReader } from './file-run.js';

interface Ctx {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: unknown, transfer?: ArrayBuffer[]): void;
}
const ctx = self as unknown as Ctx;

type Msg =
  | { id: number; op: 'open'; who: EngineIdentity; bytes: ArrayBuffer | null }
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
  | { id: number; op: 'sealedSync'; own?: string[] }
  | { id: number; op: 'sealedRebuild' }
  | { id: number; op: 'sealedSnapshot'; snapshotId: string }
  | { id: number; op: 'sealedCheck' }
  | { id: number; op: 'sealedUpkeep'; snapshotId: string }
  | { id: number; op: 'sealedPlace' }
  | { id: number; op: 'sealedAppend'; entries: Uint8Array[]; keys?: BudgetKeys[] }
  | { id: number; op: 'sealedSign'; action: Action; challenge: Uint8Array; payload: Uint8Array }
  | {
      id: number;
      op: 'start';
      keys: BudgetKeys;
      genesis: Uint8Array;
      deviceId: string;
      snapshotId: string;
      rewriteId: string;
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
  // Whole milliseconds: an entry's time is a whole number (packages/seal entry.ts).
  if (Number.isFinite(t) && t > 0 && Math.abs(seen) < 86_400_000) skew = Math.round(seen);
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

/** The engine over a copy, with the app's hook: the identity alert. */
function makeEngine(d: SqlJsDb, w: EngineIdentity): LocalEngine {
  return new LocalEngine(
    d,
    w,
    () => Date.now(),
    async (r) => ctx.postMessage({ event: 'identity', ...r }),
  );
}

/** What the engine itself keeps in `local_state`; everything else there is the app's (`put`). */
const ENGINE_KEYS = [
  'sync',
  'outbox',
  'held_queue',
  'filing',
  'rest',
  'derive',
  'derived_today',
  'recording',
  'bank_log',
  'shadow_seq',
  'shadow_scan',
];

/**
 * One round with the log: read it, catch up on bank runs and scans by time, and send what waits. Then the device
 * check (local/device-check.ts, D-116), whose failure never fails the round. `own`: the other ids this device
 * has written the log as.
 */
async function sealedRound(own: readonly string[] = []): Promise<{
  entries: number;
  filed: number;
  waiting: boolean;
  sent: number;
  lost: number;
  differs: DevicesDiffer | null;
}> {
  const { engine: e, s, log } = needSealed();
  const session = new LogSession(e, log, http, encodeEntry);
  await session.shareBankLog(clock());
  const pulled = await session.pull();
  const runs = await session.catchUp(
    http,
    { workerKeys: s.workerKeys, provider: pageReader, now: await e.now() },
    clock(),
  );
  const sent = await session.flush();
  const settled = !runs.waiting && (await e.queue()).length === 0;
  const differs = await deviceCheck({ engine: e, log, transport: http, now: Date.now(), settled, own }).catch(
    () => null,
  );
  return {
    differs,
    entries: pulled.entries,
    filed: runs.filed + runs.scans,
    waiting: runs.waiting,
    sent: sent.sent,
    lost: pulled.lost + runs.lost + sent.lost,
  };
}

/**
 * Makes the copy again from the newest trusted snapshot (local/rebuild.ts). What the new copy needs of the old one
 * is read first; the old database is then kept only as its bytes, compressed, and closed, so the two copies never
 * sit side by side in memory (sql.js never gives memory back, so they would for as long as the app runs). The old
 * copy comes back from its bytes if the new one can't be made. The app's own values in the copy go with it.
 */
async function rebuild(): Promise<{ kept: number; lost: number }> {
  const { db: old, engine: stale, s, log } = { ...need(), ...needSealed() };
  const kept = await readStale(stale);
  const app = (
    await old
      .prepare(
        `SELECT key, value FROM local_state WHERE key NOT LIKE 'note:%' AND key NOT IN (${ENGINE_KEYS.map((k) => `'${k}'`).join(', ')})`,
      )
      .all<{ key: string; value: string }>()
  ).results;
  const before = await shrink(old.db.export());
  old.db.close();
  db = null;
  engine = null;
  const fresh = new SqlJsDb(new sqlite!.Database());
  const e = makeEngine(fresh, who!);
  let r: Awaited<ReturnType<typeof rebuildFrom>>;
  try {
    await migrateLocal(fresh, Date.now());
    r = await rebuildFrom(e, kept, http, log, { clock, encode: encodeEntry });
  } catch (x) {
    fresh.db.close();
    db = new SqlJsDb(new sqlite!.Database(await grow(before)));
    engine = makeEngine(db, who!);
    throw x;
  }
  if (app.length)
    await fresh.batch(
      app.map((x) =>
        fresh
          .prepare(
            `INSERT INTO local_state (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          )
          .bind(x.key, x.value),
      ),
    );
  db = fresh;
  engine = e;
  s.log = r.log;
  return { kept: r.kept, lost: r.lost };
}

/** A copy's bytes, gzipped where the browser can (a copy is mostly text and compresses well). */
async function shrink(bytes: Uint8Array): Promise<{ gz: boolean; bytes: Uint8Array }> {
  if (typeof CompressionStream === 'undefined') return { gz: false, bytes };
  const out = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return { gz: true, bytes: new Uint8Array(await new Response(out).arrayBuffer()) };
}

async function grow(s: { gz: boolean; bytes: Uint8Array }): Promise<Uint8Array> {
  if (!s.gz) return s.bytes;
  const out = new Blob([s.bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** Runs `fn`, and once more on a copy made again if it finds the copy can't go on as it is (local/rebuild.ts). */
const orRebuild = <T>(fn: () => Promise<T>): Promise<T> =>
  afterRebuild(fn, rebuild, (event) => ctx.postMessage({ event }));

/** Checks the newest snapshot in a scratch copy; entries gone below the floor mean nothing to check here. */
const checkOrGone = (scratchEngine: LocalEngine, log: DeviceLog) =>
  unlessGone(() => checkSnapshot(scratchEngine, log, http, clock));

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
      // The migrations this open runs: the app then keeps the saved copy from before them (copy.ts).
      const migrated = await pendingMigrations(db);
      await migrateLocal(db, Date.now());
      who = m.who;
      sealed = null;
      engine = makeEngine(db, m.who);
      return { value: { ...(await engine.state()), migrated } };
    }
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
      // No place in the log (sealedOpen said so): whatever the copy holds stands nowhere in the log (a half-opened
      // copy, or one saved before the budget was locked), so it is emptied, with any change waiting in it, before
      // the snapshot opens into it. An edit is never queued on a copy with no place (api/client.ts refuses it).
      await e.dropQueue();
      await wipe(e);
      sealed.log = await openSnapshot(e, http, {
        keys: sealed.keys,
        budgetId: who!.budgetId,
        deviceId: sealed.deviceId,
        clock,
      });
      await e.note(LogSession.PLACE, sealed.log.save());
      return { value: { number: sealed.log.number } };
    }
    case 'sealedSync': {
      needSealed();
      try {
        return { value: await sealedRound(m.own) };
      } catch (x) {
        // The entries this device needs are gone (a checked snapshot covers them), or the copy can't be used as
        // it is: it is made again from the newest trusted snapshot, then the round runs once more. The app shows
        // "Bringing your budget up to date" meanwhile.
        if (!needsRebuild(x)) throw x;
        ctx.postMessage({ event: 'rebuilding' });
        const made = await rebuild();
        const v = await sealedRound(m.own);
        return { value: { ...v, lost: v.lost + made.lost, rebuilt: made } };
      }
    }
    case 'sealedRebuild': {
      // The person asked for it (Budget → Needs attention, when two devices showed different numbers): the copy
      // is made again from the newest trusted snapshot, as when its entries are gone, and the app is told.
      needSealed();
      // A rebuild that fails leaves the old copy as it was; the app is told it is over either way.
      ctx.postMessage({ event: 'rebuilding' });
      try {
        return { value: await rebuild() };
      } finally {
        ctx.postMessage({ event: 'rebuilt' });
      }
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
          return { value: { did: 'check', ...(await checkOrGone(s.engine, log)) } };
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
      // first, so the entry goes on top of the newest one. A copy below the floor is made again first.
      return {
        value: await orRebuild(async () => {
          const { engine: e, log } = needSealed();
          await new LogSession(e, log, http, encodeEntry).pull();
          return log.writePlace();
        }),
      };
    }
    case 'sealedAppend': {
      // Public entries the app made with the budget key in hand (apps/web/src/copy/sealed-ways.ts), sent as one
      // write on top of this device's place. Taken as any other entry: read back from the log, by its rules.
      // `keys`: the derived keys of the version a key change here brings.
      const { s, log } = needSealed();
      const headers = await Promise.all(m.entries.map(async (b) => (await readEntry(b)).header));
      const first = headers[0]!;
      if (first.number !== log.number + 1 || first.deviceId !== s.deviceId)
        return { value: { ok: false, why: 'behind', number: log.number, retry: true } };
      // A key change stores a new signing key and new inbox keys: the request is signed with the key in force
      // where this device stands, the one that signs the key change too (docs/privacy-keys.md 11).
      const keyChange = headers.some((h) => h.kind === KIND.keyChange);
      const inForce = log.keysHeld().find((k) => k.version === log.publicState.keyVersion);
      const r = await http.append(
        log.number,
        m.entries,
        keyChange && inForce
          ? async (text) => {
              const ch = await http.challenge(ACTION.storeSignKey);
              const sig = await signRequest(
                inForce,
                log.budgetId,
                ACTION.storeSignKey,
                fromHex(ch.challenge),
                new TextEncoder().encode(text),
              );
              return { [SIGNED_CHALLENGE_HEADER]: ch.token, [SIGNED_SIGNATURE_HEADER]: toHex(sig) };
            }
          : undefined,
      );
      if (!r.ok) return { value: r };
      if (m.keys?.length) {
        log.holdKeys(m.keys);
        for (const k of m.keys) if (!s.keys.some((x) => x.version === k.version)) s.keys.push(k);
      }
      // Read back by the log's rules; a copy found below the floor meanwhile is made again (it reads them too).
      const number = await orRebuild(async () => {
        const now = needSealed();
        await new LogSession(now.engine, now.log, http, encodeEntry).pull();
        return now.log.number;
      });
      return { value: { ok: true, number } };
    }
    case 'sealedSign': {
      // A request signed with the budget's key (docs/privacy-keys.md 11): the signing key stays here. It is the
      // key in force where this device stands in the log; after a key change it has not read yet, the server
      // refuses the signature, and the next sync brings the device level.
      const { engine: e, log } = needSealed();
      // The log first, so a key change made on another device is in force here too (the server checks
      // against the key in force in its log). A failed read leaves the signature to the server's answer.
      await new LogSession(e, log, http, encodeEntry).pull().catch(() => undefined);
      const v = log.publicState.keyVersion;
      const keys = log.keysHeld().find((k) => k.version === v);
      if (!keys) throw new Error('Your passkey is needed once more to open your budget. Try again.');
      return { value: await signRequest(keys, log.budgetId, m.action, m.challenge, m.payload) };
    }
    case 'sealedCheck': {
      const { log } = needSealed();
      const s = await scratch(who!);
      try {
        return { value: await checkOrGone(s.engine, log) };
      } finally {
        s.close();
      }
    }
    case 'start': {
      const e = need().engine;
      const r = await startOnDevice(e, {
        keys: m.keys,
        genesis: await readEntry(m.genesis),
        budgetId: who!.budgetId,
        deviceId: m.deviceId,
        clock,
        snapshotId: m.snapshotId,
        rewriteId: m.rewriteId,
        encode: encodeEntry,
        start: startTransport(call),
        snapshots: http,
      });
      if (!r.ok) return { value: r };
      sealed = {
        keys: [m.keys],
        deviceId: m.deviceId,
        workerKeys: sealed?.workerKeys ?? new Map(),
        log: r.log,
      };
      return { value: { ok: true, number: r.log.number, snapshotRead: r.snapshotRead } };
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
