// The twin check (docs/privacy.md 5.3): one edit, run on a phone's copy and on the server with the same edit id and
// time, must leave the same rows on both sides. A second phone, which never runs the edit, syncs the server's rows;
// the two copies are then compared table by table.
import { SELF } from 'cloudflare:test';
import { expect } from 'vitest';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import { SYNC_TABLES } from '../src/sync-tables.js';
import { syncPhone } from './phone.js';
import { storeDb } from './store-db.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
let copies = 0;

/** A new, empty copy of the signed-in user's budget. */
export async function newPhone(): Promise<LocalEngine> {
  const r = await SELF.fetch(`${ORIGIN}/api/session`);
  const s = (await r.json()) as { budget: { id: string }; user: { email: string } };
  const db = storeDb(`twin-copy-${++copies}`);
  await migrateLocal(db, Date.now());
  return new LocalEngine(db, { budgetId: s.budget.id, userId: 'phone', email: s.user.email });
}

/** Worked out on each phone, never stored by the server (D-45, D-46): not part of what an edit writes. */
const DERIVED: Record<string, readonly string[]> = {
  budget: ['rta', 'summary_version', 'summary_month', 'summary_dirty_from', 'updated_at'],
};

/**
 * What the two sides may still differ in: the times an edit writes. The phone writes when the person made the edit,
 * the server writes when the edit arrived (docs/build-plan.md, "edit time"). Until they are equal, a time column
 * (`at`, or a name that ends in `_at`) is compared only as set or not set. This goes in the pull request that makes
 * the times equal.
 */
const isTime = (column: string) => column === 'at' || column.endsWith('_at');
const setOrNot = (v: unknown) => (v === null ? null : 'set');

export type Rows = Record<string, Record<string, unknown>[]>;

/** `field_edits` is a JSON object of field to time: until the times are equal, only its fields are compared. */
function fieldsOnly(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return Object.keys(JSON.parse(v) as Record<string, unknown>).sort();
  } catch {
    return v;
  }
}

/** Every row the phone keeps, in key order. */
export async function rowsOf(e: LocalEngine): Promise<Rows> {
  const out: Rows = {};
  for (const t of SYNC_TABLES) {
    const skip = new Set([...(t.omit ?? []), ...(DERIVED[t.name] ?? [])]);
    const r = await e.db.prepare(`SELECT * FROM ${t.name} ORDER BY ${t.pk.join(', ')}`).all();
    out[t.name] = r.results.map((row) =>
      Object.fromEntries(
        Object.entries(row)
          .filter(([k]) => !skip.has(k))
          .map(([k, v]) => [k, k === 'field_edits' ? fieldsOnly(v) : isTime(k) ? setOrNot(v) : v]),
      ),
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
      if (!o) out.push(`${t.name} ${k}: only on the phone`);
      else
        for (const c of Object.keys(r))
          if (JSON.stringify(r[c]) !== JSON.stringify(o[c]))
            out.push(`${t.name} ${k}.${c}: phone ${JSON.stringify(r[c])}, server ${JSON.stringify(o[c])}`);
    }
    for (const k of b.keys()) if (!a.has(k)) out.push(`${t.name} ${k}: only on the server`);
  }
  return out;
}

export interface Twin {
  phone: Response;
  server: Response;
  differences: string[];
}

/**
 * Runs one edit on both sides. `a` is the phone that makes the edit; `b` only syncs. Both must be synced before.
 */
export async function twin(
  a: LocalEngine,
  b: LocalEngine,
  method: string,
  path: string,
  body: unknown,
): Promise<Twin> {
  const edit = { id: crypto.randomUUID().replace(/-/g, ''), at: Date.now() };
  const phone = await a.request(method, path, body, edit);
  const server = await SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { ...H, 'x-edit-id': edit.id, 'x-edit-at': String(edit.at) },
    body: JSON.stringify(body),
  });
  expect(server.status, `${method} ${path}: the server's answer`).toBe(phone.status);
  await syncPhone(b);
  return { phone, server, differences: differences(await rowsOf(a), await rowsOf(b)) };
}
