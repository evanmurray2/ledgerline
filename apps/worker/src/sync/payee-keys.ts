// Payee keys in the database (docs/payee-names.md 4). `n:` keys live in payee_alias.pattern with their prefix, `m:`
// keys in payee_alias.merchant_entity_id. A key written by this release has the key itself as its alias id, so a key
// belongs to one payee and the phone, running the same routes offline, writes the same row the server writes.
// Aliases written before (`d:` cleaned-text patterns, and `m:` rows with random ids) are read as they are; the `d:`
// ones are a last fallback until PR 4 of docs/payee-names.md 11 removes them.
import type { Stmt } from '@ledgerline/db/sql';
import { cleanDescription, nameKey, payeeKeys, type PayeeSource } from '@ledgerline/domain';
import type { Scoped } from '../db/scoped.js';
import { chunks } from '../ledger/ledger.js';

/** The key the old rules gave a row without a merchant id: its cleaned bank text (read only, never written now). */
export function legacyTextKey(rawName: string): string {
  return cleanDescription(rawName).replace(/\s/g, '');
}

/** A bank row's payee source, from bank_txn columns. */
export function payeeSource(r: {
  merchant_entity_id: string | null;
  merchant_name: string | null;
  plaid_name: string | null;
  raw_name: string;
}): PayeeSource {
  return {
    merchantEntityId: r.merchant_entity_id,
    merchantName: r.merchant_name,
    plaidName: r.plaid_name,
    rawName: r.raw_name,
  };
}

export interface KeyOwners {
  /** `m:` and `n:` keys, by the payee they belong to (a joined payee's keys resolve to the payee it joined). */
  keys: Map<string, string>;
  /** Old `d:` patterns (without the prefix), by payee. */
  legacy: Map<string, string>;
}

/** Who owns the given keys: indexed lookups of these keys only, never the whole alias table. */
export async function loadOwners(
  s: Scoped,
  keys: Iterable<string>,
  legacy: Iterable<string> = [],
): Promise<KeyOwners> {
  const patterns = new Set<string>();
  const merchants = new Set<string>();
  for (const k of keys) {
    if (k.startsWith('m:')) merchants.add(k.slice(2));
    else patterns.add(k);
  }
  for (const d of legacy) if (d) patterns.add(d);
  const sel = `SELECT a.pattern, a.merchant_entity_id, coalesce(p.merged_into, p.id) AS payee_id
    FROM payee_alias a JOIN payee p ON p.id = a.payee_id WHERE a.budget_id = ?1`;
  const qs: Stmt[] = [
    ...chunks([...patterns]).map((k) =>
      s.q(`${sel} AND a.pattern IN (${k.map((_, i) => `?${i + 2}`).join(',')})`, ...k),
    ),
    ...chunks([...merchants]).map((k) =>
      s.q(`${sel} AND a.merchant_entity_id IN (${k.map((_, i) => `?${i + 2}`).join(',')})`, ...k),
    ),
  ];
  const out: KeyOwners = { keys: new Map(), legacy: new Map() };
  if (!qs.length) return out;
  for (const r of await s.batch(qs))
    for (const a of r.results as {
      pattern: string | null;
      merchant_entity_id: string | null;
      payee_id: string;
    }[]) {
      if (
        a.merchant_entity_id &&
        merchants.has(a.merchant_entity_id) &&
        !out.keys.has(`m:${a.merchant_entity_id}`)
      )
        out.keys.set(`m:${a.merchant_entity_id}`, a.payee_id);
      if (a.pattern === null || !patterns.has(a.pattern)) continue;
      if (a.pattern.startsWith('n:')) {
        if (!out.keys.has(a.pattern)) out.keys.set(a.pattern, a.payee_id);
      } else if (!out.legacy.has(a.pattern)) out.legacy.set(a.pattern, a.payee_id);
    }
  return out;
}

/** Gives `payeeId` the key (`m:` or `n:`). The caller has checked that no payee has it. */
export function insertKey(s: Scoped, key: string, payeeId: string, now: number): Stmt {
  const merchant = key.startsWith('m:') ? key.slice(2) : null;
  return s.q(
    `INSERT INTO payee_alias (id, budget_id, pattern, merchant_entity_id, payee_id, created_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6)
     ON CONFLICT (id) DO NOTHING`,
    key,
    merchant ? null : key,
    merchant,
    payeeId,
    now,
  );
}

/**
 * After a rename or a join (docs/payee-names.md 4, "Keys follow the owner"): the payee also gets `n:<its new name>`,
 * unless a payee has that key already.
 */
export function claimName(s: Scoped, payeeId: string, name: string, now: number): Stmt {
  const key = nameKey(name);
  return s.q(
    `INSERT INTO payee_alias (id, budget_id, pattern, merchant_entity_id, payee_id, created_at)
     SELECT ?2, ?1, ?2, NULL, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM payee_alias WHERE budget_id = ?1 AND pattern = ?2)
     ON CONFLICT (id) DO NOTHING`,
    key,
    payeeId,
    now,
  );
}

/** A row's keys, and its old cleaned-text pattern for the fallback. */
export function rowKeys(r: Parameters<typeof payeeSource>[0]): { keys: string[]; legacy: string } {
  return { keys: payeeKeys(payeeSource(r)), legacy: legacyTextKey(r.raw_name) };
}
