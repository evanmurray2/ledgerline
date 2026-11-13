// The twin check (docs/privacy.md 5.3): one edit, run on two devices' copies with the same edit id and time, must
// leave the same rows on both: ids and time are inputs. The rows the first device recorded for the edit, written to
// a third copy as a log entry is (LocalEngine.applyRows), must give the same again. The copies are compared table
// by table.
import { expect } from 'vitest';
import type { LocalEngine } from '../src/local/engine.js';
import { SYNC_TABLES } from '../src/sync-tables.js';
import { deviceNow, newCopy } from './phone.js';

/** A new, empty copy of the signed-in user's budget. */
export const newPhone = (): Promise<LocalEngine> => newCopy();

/** Worked out on each phone, never stored by the server (D-45, D-46): not part of what an edit writes. */
const DERIVED: Record<string, readonly string[]> = {
  budget: ['rta', 'summary_version', 'summary_month', 'summary_dirty_from', 'updated_at'],
};

export type Rows = Record<string, Record<string, unknown>[]>;

/** Every row the phone keeps, in key order. */
export async function rowsOf(e: LocalEngine): Promise<Rows> {
  const out: Rows = {};
  for (const t of SYNC_TABLES) {
    const skip = new Set([...(t.omit ?? []), ...(DERIVED[t.name] ?? [])]);
    const r = await e.db.prepare(`SELECT * FROM ${t.name} ORDER BY ${t.pk.join(', ')}`).all();
    out[t.name] = r.results.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([k]) => !skip.has(k))),
    );
  }
  return out;
}

/** What differs between two copies: one line per row, for a readable failure. */
export function differences(phone: Rows, server: Rows): string[] {
  const out: string[] = [];
  for (const t of SYNC_TABLES) {
    const key = (r: Record<string, unknown>) => JSON.stringify(t.pk.map((k) => r[k]));
    const a = new Map(phone[t.name]!.map((r) => [key(r), r]));
    const b = new Map(server[t.name]!.map((r) => [key(r), r]));
    for (const [k, r] of a) {
      const o = b.get(k);
      if (!o) out.push(`${t.name} ${k}: only on the first`);
      else
        for (const c of Object.keys(r))
          if (JSON.stringify(r[c]) !== JSON.stringify(o[c]))
            out.push(`${t.name} ${k}.${c}: first ${JSON.stringify(r[c])}, second ${JSON.stringify(o[c])}`);
    }
    for (const k of b.keys()) if (!a.has(k)) out.push(`${t.name} ${k}: only on the second`);
  }
  return out;
}

/** All an edit can write in a copy: the synced tables, and the two that only a recording carries. */
async function everything(e: LocalEngine): Promise<{ rows: Rows; other: string }> {
  const other: unknown[] = [];
  for (const t of ['audit_log', 'txn_key_move'])
    other.push((await e.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()).results);
  return { rows: await rowsOf(e), other: JSON.stringify(other) };
}

const auditLine = (r: Record<string, unknown>) => [
  r.action,
  r.entity,
  r.entity_id,
  r.before,
  r.after,
  r.created_at,
];

export interface Twin {
  /** The first device's answer. */
  phone: Response;
  /** The second device's answer to the same edit. */
  server: Response;
  differences: string[];
  /** How many rows the first device recorded for the edit. */
  recorded: number;
}

/** Runs one edit on two devices, `a` and `b`, with the same id and time. Both must hold the same budget before. */
export async function twin(
  a: LocalEngine,
  b: LocalEngine,
  method: string,
  path: string,
  body: unknown,
  /**
   * A third device, which doesn't run the edit: it writes only the rows the first device recorded for the edit
   * (LocalEngine.record), as a device applies a log entry. It must end with the same rows too.
   */
  c?: LocalEngine,
): Promise<Twin> {
  // As the app makes them (apps/web/src/copy/copy.ts editOnDevice): the time is this device's corrected clock.
  const edit = { id: crypto.randomUUID().replace(/-/g, ''), at: deviceNow() - 60_000 };
  const ran = await a.record(method, path, body, edit);
  const phone = ran.response;
  const undone: string[] = [];
  if (c) {
    // Taking an edit back out (the redo of a refused write): the third device runs the edit itself, writes the
    // rows as they were before it, and must be exactly as it was. Then it takes the first device's rows.
    const was = await everything(c);
    const own = await c.record(method, path, body, edit);
    await c.applyRows(own.undo);
    const is = await everything(c);
    for (const d of differences(is.rows, was.rows)) undone.push(`after undo: ${d}`);
    if (is.other !== was.other) undone.push('after undo: audit_log or txn_key_move differs');
    await c.applyRows(ran.rows);
    if (await c.needsDerive()) await c.derive();
  }
  const second = await b.record(method, path, body, edit);
  expect(second.response.status, `${method} ${path}: the second device's answer`).toBe(phone.status);
  const diff = [...undone, ...differences(await rowsOf(a), await rowsOf(b))];
  if (c) {
    for (const d of differences(await rowsOf(c), await rowsOf(a))) diff.push(`recorded rows: ${d}`);
    // The two tables an edit writes that only a recording carries: the copy that took the recorded rows holds
    // what the device that ran the edit holds, ids included.
    for (const t of ['audit_log', 'txn_key_move']) {
      const all = async (e: LocalEngine) =>
        JSON.stringify((await e.db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()).results);
      if ((await all(a)) !== (await all(c))) diff.push(`recorded rows: ${t} differs`);
    }
  }
  // What the edit wrote to the record of changes is the same on both devices (each its own user).
  const lines = (r: typeof ran) =>
    JSON.stringify(r.rows.filter((x) => x.t === 'audit_log' && x.d).map((x) => auditLine(x.d!)));
  if (lines(ran) !== lines(second)) diff.push(`audit_log: first ${lines(ran)}, second ${lines(second)}`);
  // And where a transaction's key went.
  const moves = (r: typeof ran) => JSON.stringify(r.rows.filter((x) => x.t === 'txn_key_move'));
  if (moves(ran) !== moves(second)) diff.push(`txn_key_move: first ${moves(ran)}, second ${moves(second)}`);
  return { phone, server: second.response, differences: diff, recorded: ran.rows.length };
}
