// The server's store of a budget's sealed, signed log (docs/privacy.md 5.3; docs/privacy-keys.md 7; store
// migration 0005). It keeps each entry as its device signed it and where the chain stands, and takes a write only
// when the log's own rules (packages/seal, the same code every device runs) and the server's rules for a write
// (server-append.ts) both pass: all entries of a write, or none. It reads an entry's clear header and never its
// sealed body. Nothing calls this before the cutover.
import type { Db, Stmt } from '@ledgerline/db/sql';
import {
  AppendRefused,
  checkGenesisWrite,
  checkWrite,
  fromHex,
  fromStored,
  KIND,
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
const NEVER_HELD = [KIND.slotChange, KIND.keyChange, KIND.signOut, KIND.intent, KIND.cancel];

export interface LogDeps {
  db: Db;
  budgetId: string;
  now: number;
  /** The breaker rests writes (90% of a daily limit). */
  resting: boolean;
  /** This session came in by the recovery key, or by a passkey added less than 7 days ago (D-89). */
  freshWay: boolean;
  /** The highest bank run that is complete (signed), filed or not. */
  lastCompleteRun: number;
  /** The receipt hashes the Worker stored for runs `from` to `to`; null when one is missing. */
  receiptHashes: (from: number, to: number) => Promise<Uint8Array[] | null>;
}

export type AppendResult =
  | { ok: true; number: number; stored: 'now' | 'already' }
  /** The log has moved on: the device reads the entries after `number` and makes its write again. */
  | { ok: false; why: 'behind'; number: number; retry: true }
  | { ok: false; why: RefusedWhy; detail: string; retry: boolean };

// ---- the chain state as JSON: bytes and maps keep their kind

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
      if (typeof o.$bytes === 'string') return unb64(o.$bytes);
      if (Array.isArray(o.$map)) return new Map(o.$map as [unknown, unknown][]);
    }
    return v;
  }) as StoredChain;
}

// ---- reading

/** Where the log stands: the number of its last entry (0: no log yet). */
export async function logHead(db: Db): Promise<number> {
  return (
    (await db.prepare(`SELECT number FROM log_state WHERE id = 1`).first<{ number: number }>())?.number ?? 0
  );
}

async function loadState(db: Db): Promise<ChainState | null> {
  const r = await db.prepare(`SELECT state FROM log_state WHERE id = 1`).first<{ state: string }>();
  return r ? fromStored(stateFromJson(r.state)) : null;
}

/** The entries after `after`, in order, as their devices encoded them. */
export async function logAfter(
  db: Db,
  after: number,
  limit: number,
): Promise<{ number: number; bytes: Uint8Array }[]> {
  const rows = await db
    .prepare(`SELECT number, bytes FROM log_entry WHERE number > ?1 ORDER BY number LIMIT ?2`)
    .bind(after, limit)
    .all<{ number: number; bytes: string }>();
  return rows.results.map((r) => ({ number: r.number, bytes: unb64(r.bytes) }));
}

// ---- writing

async function context(d: LogDeps): Promise<AppendContext> {
  const day = d.now - (d.now % 86_400_000);
  const used = await d.db
    .prepare(
      `SELECT count(*) AS n FROM log_entry WHERE created_at >= ?1 AND kind IN (${NEVER_HELD.join(', ')})`,
    )
    .bind(day)
    .first<{ n: number }>();
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
    keyEntriesLeft: Math.max(0, KEY_ENTRIES_A_DAY - (used?.n ?? 0)),
  };
}

function storeStmts(
  db: Db,
  entries: { e: Entry; bytes: Uint8Array }[],
  state: ChainState,
  now: number,
): Stmt[] {
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
          b64(bytes),
          now,
        ),
    ),
    db
      .prepare(
        `INSERT INTO log_state (id, number, state, updated_at) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT (id) DO UPDATE SET number = excluded.number, state = excluded.state, updated_at = excluded.updated_at`,
      )
      .bind(state.number, stateToJson(toStored(state)), now),
  ];
}

const refusal = (x: unknown): AppendResult => {
  if (x instanceof AppendRefused) return { ok: false, why: x.why, detail: x.detail, retry: x.retry };
  // Bytes that are not an entry at all.
  return { ok: false, why: 'rules', detail: 'not an entry', retry: false };
};

/** The first write of a budget: its genesis entry. Only when the budget has no log. */
export async function logGenesis(d: LogDeps, bytes: Uint8Array): Promise<AppendResult> {
  const head = await logHead(d.db);
  let e: Entry;
  let state: ChainState;
  try {
    e = await readEntry(bytes);
    if (head !== 0) {
      // Sent again after a lost answer: the same entry is stored already.
      const first = (await logAfter(d.db, 0, 1))[0];
      if (first && toHex((await readEntry(first.bytes)).hash) === toHex(e.hash))
        return { ok: true, number: head, stored: 'already' };
      return { ok: false, why: 'behind', number: head, retry: true };
    }
    state = await checkGenesisWrite(e, d.budgetId, await context(d));
  } catch (x) {
    return refusal(x);
  }
  return store(d, 0, [{ e, bytes }], state);
}

/**
 * One write on top of entry `base` (compare-and-swap, 5.3 check 2): every entry is stored, or none. A write the
 * log already holds whole answers "already" and stores nothing (check 3).
 */
export async function logAppend(d: LogDeps, base: number, encoded: Uint8Array[]): Promise<AppendResult> {
  const state = await loadState(d.db);
  if (!state) return { ok: false, why: 'rules', detail: 'no log', retry: false };
  let entries: { e: Entry; bytes: Uint8Array }[];
  let next: ChainState | 'already stored';
  try {
    entries = [];
    for (const bytes of encoded) entries.push({ e: await readEntry(bytes), bytes });
    next = await checkWrite(
      state,
      entries.map((x) => x.e),
      await context(d),
    );
  } catch (x) {
    // A write made on an older log is refused by the chain's rules; say "behind", so the device reads and redoes.
    if (base !== state.number && x instanceof AppendRefused && x.why === 'rules')
      return { ok: false, why: 'behind', number: state.number, retry: true };
    return refusal(x);
  }
  if (next === 'already stored') return { ok: true, number: state.number, stored: 'already' };
  if (base !== state.number) return { ok: false, why: 'behind', number: state.number, retry: true };
  return store(d, base, entries, next);
}

/** All of the write and the new state in one step, only if the log still ends at `base`. */
async function store(
  d: LogDeps,
  base: number,
  entries: { e: Entry; bytes: Uint8Array }[],
  state: ChainState,
): Promise<AppendResult> {
  try {
    await d.db.batch([
      conditionFence(d.db, `SELECT coalesce((SELECT number FROM log_state WHERE id = 1), 0) = ?1`, base),
      ...storeStmts(d.db, entries, state, d.now),
    ]);
  } catch (x) {
    if (!isFenceAbort(x)) throw x;
    return { ok: false, why: 'behind', number: await logHead(d.db), retry: true };
  }
  return { ok: true, number: state.number, stored: 'now' };
}
