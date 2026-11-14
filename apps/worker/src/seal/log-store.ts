// The server's store of a budget's sealed, signed log (docs/privacy.md 5.3; docs/privacy-keys.md 7; store
// migration 0005). It keeps each entry as its device signed it and where the chain stands, and takes a write only
// when the log's own rules (packages/seal, the same code every device runs) and the server's rules for a write
// (server-append.ts) both pass: all entries of a write, or none. It reads an entry's clear header and never its
// sealed body.
//
// One lock: a write is checked against the state it read, then stored in one transaction that first checks the log
// still ends where that state does (the fence in `store`). Two writes checked against the same state can't both be
// stored: the second finds the log moved on and is told "behind". Everything the check read that a write changes
// (the chain state, the device counters, the day's count of never-held entries) is written in that transaction.
import type { Db, Stmt } from '@ledgerline/db/sql';
import { fromBase64, toBase64 } from '@ledgerline/platform';
import {
  AppendRefused,
  checkGenesisWrite,
  FormatError,
  checkWrite,
  fromHex,
  fromStored,
  KIND,
  MAX_DEVICES,
  readEntry,
  toHex,
  toStored,
  type AppendContext,
  type ChainState,
  type Entry,
  type RefusedWhy,
  type StoredChain,
} from '@ledgerline/seal';
import { conditionFence, isFenceAbort } from '../sync/lease.js';
import { LOG_PROCESSING_VERSION, LOG_SCHEMA_VERSION } from './log-versions.js';

export { LOG_PROCESSING_VERSION, LOG_SCHEMA_VERSION };

/** Entries of the kinds the breaker never holds back that one budget may store in a day (5.3 check 7). */
export const KEY_ENTRIES_A_DAY = 32;
const NEVER_HELD: readonly number[] = [
  KIND.slotChange,
  KIND.keyChange,
  KIND.signOut,
  KIND.intent,
  KIND.cancel,
];
const DAY_MS = 86_400_000;

export interface LogDeps {
  db: Db;
  budgetId: string;
  now: number;
  /** The breaker rests writes (90% of a daily limit). */
  resting: boolean;
  /** This session came in by the recovery key, or by a passkey added less than 7 days ago (D-89). */
  freshWay: boolean;
  /** The highest bank run that is complete (signed), filed or not: `run_state.run` as this request read it. */
  lastCompleteRun: number;
  /** The receipt hashes the Worker stored for runs `from` to `to`; null when one is missing. */
  receiptHashes: (from: number, to: number) => Promise<Uint8Array[] | null>;
  /**
   * The Worker's stamps on the keys a write brings (seal/runs.ts keyStampStmts), stored in the same step as the
   * write. `before` is null for the first entry.
   */
  stamps?: (before: ChainState | null, after: ChainState) => Promise<Stmt[]>;
  /**
   * Whether this request is signed with the budget's key as `store-sign-key` (docs/privacy-keys.md 11): a write
   * with a key change stores a new signing key and new inbox keys, so it needs one. Asked only for such a write.
   * Left out: no request signature is asked (tests of the log's own rules).
   */
  keysSigned?: () => Promise<boolean>;
}

export type AppendResult =
  | { ok: true; number: number; stored: 'now' | 'already' }
  /** The log has moved on: the device reads the entries after `number` and makes its write again. */
  | { ok: false; why: 'behind'; number: number; retry: true }
  | { ok: false; why: RefusedWhy; detail: string; retry: boolean }
  /** A key change sent without a good request signature (`keysSigned`). */
  | { ok: false; why: 'unsigned'; detail: string; retry: false };

// ---- bytes as text: the chain state's JSON, the log's answers, and entries an earlier release stored

/** Base64 of `b` (packages/platform: in one pass, at any size). */
export const b64 = toBase64;

/**
 * An entry's stored bytes. An entry is stored as a BLOB; the releases up to Nov 13, 2026 stored base64 text, in
 * the same column, and those rows stay as they are (read as they are, never rewritten).
 */
export function entryBytes(v: unknown): Uint8Array<ArrayBuffer> {
  if (typeof v === 'string') return fromBase64(v);
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new TypeError('not stored entry bytes');
}

/** An entry's stored bytes as base64, for an answer: a row stored as text already is that. */
export function entryText(v: unknown): string {
  return typeof v === 'string' ? v : b64(entryBytes(v));
}

export function stateToJson(s: StoredChain): string {
  return JSON.stringify(s, (_k, v: unknown) => {
    if (v instanceof Uint8Array) return { $bytes: b64(v) };
    if (v instanceof Map) return { $map: [...v.entries()] };
    return v;
  });
}

export function stateFromJson(text: string): StoredChain {
  return JSON.parse(text, (_k, v: unknown) => {
    if (v && typeof v === 'object') {
      const o = v as { $bytes?: unknown; $map?: unknown };
      if (typeof o.$bytes === 'string') return fromBase64(o.$bytes);
      if (Array.isArray(o.$map)) return new Map(o.$map as [unknown, unknown][]);
    }
    return v;
  }) as StoredChain;
}

/** The parts of the stored state's public half that the Worker reads outside the log's own rules. */
export interface LogPublic {
  keyVersion?: number;
  signPub?: Uint8Array<ArrayBuffer>;
  signPubs?: Map<number, Uint8Array<ArrayBuffer>>;
  inboxVersion?: number;
  retiredAt?: Map<number, number>;
}

const isVersion = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
function mapOf<V>(v: unknown, isValue: (x: unknown) => x is V): Map<number, V> | undefined {
  if (!(v instanceof Map)) return undefined;
  for (const [k, x] of v as Map<unknown, unknown>) if (typeof k !== 'number' || !isValue(x)) return undefined;
  return v as Map<number, V>;
}
const isBytes = (x: unknown): x is Uint8Array<ArrayBuffer> => x instanceof Uint8Array;
const isNumber = (x: unknown): x is number => typeof x === 'number';

/**
 * The public half of the state in `log_state` (`stateJson`), checked field by field: a field is there only when it
 * has its type (a version is a whole number from 1). Null when the state has no public half. JSON that doesn't
 * parse throws, as `stateFromJson` does.
 */
export function publicOf(stateJson: string): LogPublic | null {
  const p: unknown = (stateFromJson(stateJson) as { public?: unknown }).public;
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const out: LogPublic = {};
  if (isVersion(o.keyVersion)) out.keyVersion = o.keyVersion;
  if (isBytes(o.signPub)) out.signPub = o.signPub;
  const signPubs = mapOf(o.signPubs, isBytes);
  if (signPubs) out.signPubs = signPubs;
  if (isVersion(o.inboxVersion)) out.inboxVersion = o.inboxVersion;
  const retiredAt = mapOf(o.retiredAt, isNumber);
  if (retiredAt) out.retiredAt = retiredAt;
  return out;
}

// ---- where the chain stands

/**
 * The server keeps the chain state (packages/seal chain.ts) as one JSON value in `log_state`, without the two
 * parts that grow with the budget's life (docs/privacy-keys.md 7.2): each device's last counter is a row of its own
 * in `store_note` (`device:<id>`), and the list of public entries is not kept, since the server never reads it
 * (the public entries are rows of `log_entry`, which are never deleted). So an append reads and writes the
 * counters of its own devices only, and a JSON value that the log's own limits keep small (slots, open intents,
 * inbox keys, key versions).
 *
 * A state stored by an earlier release holds every counter in the JSON value: those count as rows until the next
 * write moves them out (a few rows, one per device, in that write's transaction). The value written keeps
 * `counters` and `publics`, empty.
 */
const DEVICE_NOTE = 'device:';
/** Every key of `store_note` from `device:` up to `device;`: the device counters, read by the primary key. */
const DEVICE_RANGE = `key >= 'device:' AND key < 'device;'`;

interface Loaded {
  state: ChainState;
  /** Counters still in the JSON value (a state an earlier release stored); each becomes a row at the next write. */
  inJson: Map<string, number>;
}

async function loadState(db: Db, devices: readonly string[]): Promise<Loaded | null> {
  const r = await db.prepare(`SELECT state FROM log_state WHERE id = 1`).first<{ state: string }>();
  if (!r) return null;
  const stored = stateFromJson(r.state) as StoredChain & { counters?: unknown };
  const inJson = stored.counters instanceof Map ? (stored.counters as Map<string, number>) : new Map();
  const counters = new Map<string, number>();
  if (devices.length) {
    const rows = await db
      .prepare(
        `SELECT key, value FROM store_note WHERE key IN (${devices.map((_, i) => `?${i + 1}`).join(', ')})`,
      )
      .bind(...devices.map((x) => DEVICE_NOTE + x))
      .all<{ key: string; value: number }>();
    for (const x of rows.results) counters.set(x.key.slice(DEVICE_NOTE.length), x.value);
  }
  // A counter in the JSON value is the newer one: an earlier release (after a rollback) may have written it since.
  for (const x of devices) {
    const v = inJson.get(x);
    if (v !== undefined) counters.set(x, v);
  }
  const state = await fromStored({ ...stored, counters, public: { ...stored.public, publics: [] } });
  return { state, inJson };
}

/** How many devices have written to the log, rows and JSON value together. */
async function deviceCount(db: Db, inJson: Map<string, number>): Promise<number> {
  const rows = await db.prepare(`SELECT key FROM store_note WHERE ${DEVICE_RANGE}`).all<{ key: string }>();
  const ids = new Set(rows.results.map((x) => x.key));
  let n = ids.size;
  for (const x of inJson.keys()) if (!ids.has(DEVICE_NOTE + x)) n++;
  return n;
}

// ---- reading

/** Where the log stands: the number of its last entry (0: no log yet). */
export async function logHead(db: Db): Promise<number> {
  return (
    (await db.prepare(`SELECT number FROM log_state WHERE id = 1`).first<{ number: number }>())?.number ?? 0
  );
}

/** The entries after `after`, in order, as stored: a BLOB, or base64 text for one an earlier release stored. */
export async function logRowsAfter(
  db: Db,
  after: number,
  limit: number,
): Promise<{ number: number; bytes: unknown }[]> {
  const rows = await db
    .prepare(`SELECT number, bytes FROM log_entry WHERE number > ?1 ORDER BY number LIMIT ?2`)
    .bind(after, limit)
    .all<{ number: number; bytes: unknown }>();
  return rows.results;
}

/** The entries after `after`, in order, as their devices encoded them. */
export async function logAfter(
  db: Db,
  after: number,
  limit: number,
): Promise<{ number: number; bytes: Uint8Array }[]> {
  return (await logRowsAfter(db, after, limit)).map((r) => ({
    number: r.number,
    bytes: entryBytes(r.bytes),
  }));
}

// ---- writing

/** The never-held entries this budget stored today (5.3 check 7). */
interface KeyCount {
  day: number;
  used: number;
}

/**
 * The day's count of never-held entries: noted in `store_note` (`key_day`, `key_entries`), because the delete
 * rule may remove a sign-out stored today, and counted from today's rows of `log_entry` too, so that a count from
 * before the note existed still holds. The higher of the two.
 */
async function keyCount(db: Db, now: number): Promise<KeyCount> {
  const day = Math.floor(now / DAY_MS);
  const r = await db
    .prepare(
      `SELECT (SELECT count(*) FROM log_entry WHERE created_at >= ?1 AND kind IN (${NEVER_HELD.join(', ')})) AS counted,
              (SELECT value FROM store_note WHERE key = 'key_day') AS noted_day,
              (SELECT value FROM store_note WHERE key = 'key_entries') AS noted`,
    )
    .bind(day * DAY_MS)
    .first<{ counted: number; noted_day: number | null; noted: number | null }>();
  const noted = r?.noted_day === day ? (r.noted ?? 0) : 0;
  return { day, used: Math.max(noted, r?.counted ?? 0) };
}

function context(d: LogDeps, keys: KeyCount): AppendContext {
  return {
    now: d.now,
    freshWay: d.freshWay,
    schemaVersion: LOG_SCHEMA_VERSION,
    processingVersion: LOG_PROCESSING_VERSION,
    stored: async (entryId) => {
      const rows = await d.db
        .prepare(`SELECT hash FROM log_entry WHERE entry_id = ?1 ORDER BY part`)
        .bind(toHex(entryId))
        .all<{ hash: string }>();
      return rows.results.length ? rows.results.map((r) => fromHex(r.hash)) : null;
    },
    lastCompleteRun: d.lastCompleteRun,
    receiptHashes: d.receiptHashes,
    resting: d.resting,
    keyEntriesLeft: Math.max(0, KEY_ENTRIES_A_DAY - keys.used),
  };
}

function storeStmts(
  db: Db,
  entries: { e: Entry; bytes: Uint8Array }[],
  state: ChainState,
  inJson: Map<string, number>,
  keys: KeyCount,
  now: number,
): Stmt[] {
  // The counters this write moved, and any still in the JSON value (moved out once, at this write), as rows.
  const counters = new Map(inJson);
  for (const { e } of entries) counters.set(e.header.deviceId, state.counters.get(e.header.deviceId)!);
  const stored = toStored(state);
  // The counters are rows only, and entries are BLOBs (D-104). The release before this one wrote both forms and
  // reads both, so a rollback to it (deploy.yml rolls back a failed smoke test) still finds every counter and
  // entry. The value keeps `counters` and `publics`, empty, so that it has the shape every release has read.
  const json = stateToJson({ ...stored, counters: new Map(), public: { ...stored.public, publics: [] } });
  const keyEntries = entries.filter(({ e }) => NEVER_HELD.includes(e.header.kind)).length;
  return [
    ...entries.map(({ e, bytes }) =>
      db
        .prepare(
          `INSERT INTO log_entry (number, entry_id, part, kind, hash, bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(
          e.header.number,
          toHex(e.header.entryId),
          e.header.part,
          e.header.kind,
          toHex(e.hash),
          bytes,
          now,
        ),
    ),
    ...[...counters].map(([device, n]) =>
      db
        .prepare(
          `INSERT INTO store_note (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .bind(DEVICE_NOTE + device, n),
    ),
    ...(keyEntries
      ? [
          db
            .prepare(
              `INSERT INTO store_note (key, value) VALUES ('key_day', ?1), ('key_entries', ?2)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
            )
            .bind(keys.day, keys.used + keyEntries),
        ]
      : []),
    db
      .prepare(
        `INSERT INTO log_state (id, number, state, updated_at) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT (id) DO UPDATE SET number = excluded.number, state = excluded.state, updated_at = excluded.updated_at`,
      )
      .bind(state.number, json, now),
  ];
}

/**
 * What a refused write answers. Only a refusal is an answer: bytes that are no entry, or a rule of the log or of
 * the server. Any other fault (the database, a helper that threw) is thrown on, so the device tries again and
 * a good write is never told it was refused for good.
 */
const refusal = (x: unknown): AppendResult => {
  if (x instanceof AppendRefused) return { ok: false, why: x.why, detail: x.detail, retry: x.retry };
  if (x instanceof FormatError) return { ok: false, why: 'rules', detail: 'not an entry', retry: false };
  throw x;
};

/** The first write of a budget: its genesis entry. Only when the budget has no log. */
export async function logGenesis(d: LogDeps, bytes: Uint8Array): Promise<AppendResult> {
  const head = await logHead(d.db);
  let e: Entry;
  let state: ChainState;
  let keys: KeyCount;
  try {
    e = await readEntry(bytes);
    if (head !== 0) {
      // Sent again after a lost answer: the same entry is stored already.
      const first = (await logAfter(d.db, 0, 1))[0];
      if (first && toHex((await readEntry(first.bytes)).hash) === toHex(e.hash))
        return { ok: true, number: head, stored: 'already' };
      // A budget starts once: another first entry can never be stored, so the device must not try again.
      return { ok: false, why: 'rules', detail: 'a log exists', retry: false };
    }
    keys = await keyCount(d.db, d.now);
    state = await checkGenesisWrite(e, d.budgetId, context(d, keys));
  } catch (x) {
    return refusal(x);
  }
  return store(d, 0, [{ e, bytes }], state, null, new Map(), keys);
}

/**
 * One write on top of entry `base` (compare-and-swap, 5.3 check 2): every entry is stored, or none. A write the
 * log already holds whole answers "already" and stores nothing (check 3).
 */
export async function logAppend(d: LogDeps, base: number, encoded: Uint8Array[]): Promise<AppendResult> {
  const entries: { e: Entry; bytes: Uint8Array }[] = [];
  try {
    for (const bytes of encoded) entries.push({ e: await readEntry(bytes), bytes });
  } catch (x) {
    return refusal(x);
  }
  const devices = [...new Set(entries.map((x) => x.e.header.deviceId))];
  const loaded = await loadState(d.db, devices);
  if (!loaded) return { ok: false, why: 'rules', detail: 'no log', retry: false };
  const { state, inJson } = loaded;
  let next: ChainState | 'already stored';
  let keys: KeyCount;
  try {
    keys = await keyCount(d.db, d.now);
    next = await checkWrite(
      state,
      entries.map((x) => x.e),
      context(d, keys),
    );
    // The chain's limit on devices (MAX_DEVICES), which it can't see in the counters of this write's devices.
    if (next !== 'already stored') {
      const fresh = devices.filter((x) => !state.counters.has(x)).length;
      if (fresh && (await deviceCount(d.db, inJson)) + fresh > MAX_DEVICES)
        throw new AppendRefused('rules', 'too many devices');
    }
  } catch (x) {
    // A write made on an older log is refused by the chain's rules; say "behind", so the device reads and redoes.
    if (base !== state.number && x instanceof AppendRefused && x.why === 'rules')
      return { ok: false, why: 'behind', number: state.number, retry: true };
    return refusal(x);
  }
  if (next === 'already stored') return { ok: true, number: state.number, stored: 'already' };
  if (base !== state.number) return { ok: false, why: 'behind', number: state.number, retry: true };
  // New keys come only with a request signed by the key in force (a stolen session can't send one).
  if (d.keysSigned && entries.some(({ e }) => e.header.kind === KIND.keyChange) && !(await d.keysSigned()))
    return { ok: false, why: 'unsigned', detail: 'a key change needs a signed request', retry: false };
  return store(d, base, entries, next, state, inJson, keys);
}

/** All of the write and the new state in one step, only if the log still ends at `base`. */
async function store(
  d: LogDeps,
  base: number,
  entries: { e: Entry; bytes: Uint8Array }[],
  state: ChainState,
  before: ChainState | null,
  inJson: Map<string, number>,
  keys: KeyCount,
): Promise<AppendResult> {
  const stamps = d.stamps ? await d.stamps(before, state) : [];
  try {
    await d.db.batch([
      // The log still ends at `base`, and no bank run was completed since this write was checked against the
      // last complete run (a key change names that run; a bank entry's receipts are checked against it).
      conditionFence(
        d.db,
        `SELECT coalesce((SELECT number FROM log_state WHERE id = 1), 0) = ?1
           AND coalesce((SELECT run FROM run_state WHERE id = 1), 0) = ?2`,
        base,
        d.lastCompleteRun,
      ),
      ...storeStmts(d.db, entries, state, inJson, keys, d.now),
      ...stamps,
    ]);
  } catch (x) {
    if (!isFenceAbort(x)) throw x;
    return { ok: false, why: 'behind', number: await logHead(d.db), retry: true };
  }
  return { ok: true, number: state.number, stored: 'now' };
}
