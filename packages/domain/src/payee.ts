// Payees from Plaid's own values (docs/payee-names.md 4, 5): a bank row's keys and a new payee's name, compared only
// for equality by payeeNameKey. cleanDescription and the trigram helpers below serve only the pending matcher
// (matcher.ts) and the old `d:` alias lookup until PR 4 of docs/payee-names.md section 11 removes them.

const PREFIXES = [
  /^SQ \*/,
  /^SQ\*/,
  /^TST\* ?/,
  /^PAYPAL \*/,
  /^POS DEBIT /,
  /^POS /,
  /^ACH (DEBIT |CREDIT )?/,
  /^DEBIT CARD PURCHASE /,
  /^CHECKCARD /,
  /^PURCHASE /,
];
const STATES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';

/**
 * Clean: uppercase, strip processor prefixes, store and reference numbers, dates, card last-4 and trailing
 * city/state. `SQ *BLUE BOTTLE 0123 OAKLAND CA` → `BLUE BOTTLE`.
 */
export function cleanDescription(raw: string): string {
  let s = raw.toUpperCase().replace(/\s+/g, ' ').trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const p of PREFIXES) {
      if (p.test(s)) {
        s = s.replace(p, '').trim();
        changed = true;
      }
    }
  }
  s = s
    .replace(new RegExp(`\\s+[A-Z][A-Z .'-]*\\s(${STATES})$`), '') // trailing "CITY ST"
    .replace(new RegExp(`\\s+(${STATES})$`), '')
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ') // dates
    .replace(/\b(X+|\*+)\d{4}\b/g, ' ') // card last-4
    .replace(/#\s*\d+/g, ' ') // store numbers
    .replace(/\b\d{3,}\b/g, ' ') // reference numbers
    .replace(/\b[A-Z0-9]*\d[A-Z0-9]*\*?[A-Z0-9]*\b/g, (w) => (/\d{2,}/.test(w) ? ' ' : w))
    .replace(/[*#]+/g, ' ')
    .replace(/\.(COM|NET)\b.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

/** Key: the cleaned string, or the provider's merchant entity id when present (strongest signal). */
export function payeeKey(raw: string, merchantEntityId: string | null): string {
  return merchantEntityId ? `m:${merchantEntityId}` : `d:${cleanDescription(raw).replace(/\s/g, '')}`;
}

export function trigrams(s: string): Set<string> {
  const t = `  ${s.toLowerCase().replace(/[^a-z0-9 ]/g, '')} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Trigram similarity (Jaccard) in [0, 1]. */
export function similarity(a: string, b: string): number {
  return jaccard(trigrams(a), trigrams(b));
}

/** Jaccard index of two trigram sets (see trigrams), for callers comparing one string with many. */
export function jaccard(x: ReadonlySet<string>, y: ReadonlySet<string>): number {
  if (x.size === 0 && y.size === 0) return 1;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}

export interface PayeeRaw {
  raw: string;
  merchantEntityId: string | null;
  merchantName: string | null;
  count: number;
}

export interface PayeeCluster {
  name: string;
  members: PayeeRaw[];
  transactions: number;
}

/** Cluster raw names: exact merchant id first, then trigram similarity above a threshold. */
export function clusterPayees(rows: readonly PayeeRaw[], threshold = 0.5): PayeeCluster[] {
  const clusters: { key: string; name: string; members: PayeeRaw[] }[] = [];
  const byMerchant = new Map<string, number>();
  for (const r of rows) {
    if (r.merchantEntityId && byMerchant.has(r.merchantEntityId)) {
      clusters[byMerchant.get(r.merchantEntityId)!]!.members.push(r);
      continue;
    }
    const cleaned = cleanDescription(r.raw);
    let idx = clusters.findIndex((c) => similarity(c.key, cleaned) >= threshold);
    if (idx < 0) {
      idx = clusters.push({ key: cleaned, name: r.merchantName ?? titleCase(cleaned), members: [] }) - 1;
    }
    clusters[idx]!.members.push(r);
    if (r.merchantEntityId) byMerchant.set(r.merchantEntityId, idx);
  }
  return clusters
    .filter((c) => c.members.length > 1)
    .map((c) => ({
      name: c.name,
      members: c.members,
      transactions: c.members.reduce((a, m) => a + m.count, 0),
    }));
}

/** Payee names compare without case, outer spaces or the curly/straight apostrophe difference. */
export function samePayeeName(a: string, b: string): boolean {
  return payeeNameKey(a) === payeeNameKey(b);
}
export function payeeNameKey(s: string): string {
  return s.trim().replace(/[’‘]/g, "'").toLowerCase();
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase());
}

/** What a bank row says about who was paid, as Plaid sent it. */
export interface PayeeSource {
  merchantEntityId: string | null;
  merchantName: string | null;
  plaidName: string | null;
  rawName: string;
}

/** The `n:` key of a name: one space for merchant names, Plaid names and names you chose. */
export function nameKey(name: string): string {
  return `n:${payeeNameKey(name)}`;
}

const present = (s: string | null): s is string => s !== null && s.trim() !== '';

/**
 * A row's payee keys, in the order they decide (docs/payee-names.md 4): Plaid's merchant id, then `merchant_name`,
 * then Plaid's `name`. A row with neither name has one key, its bank text. No repeats.
 */
export function payeeKeys(r: PayeeSource): string[] {
  const keys: string[] = [];
  if (present(r.merchantEntityId)) keys.push(`m:${r.merchantEntityId}`);
  if (present(r.merchantName)) keys.push(nameKey(r.merchantName));
  if (present(r.plaidName)) keys.push(nameKey(r.plaidName));
  if (!present(r.merchantName) && !present(r.plaidName)) keys.push(nameKey(r.rawName));
  return [...new Set(keys)];
}

/** A new payee's name (docs/payee-names.md 5): `merchant_name`, else Plaid's `name`, else the bank text, as sent. */
export function newPayeeName(r: PayeeSource): string {
  if (present(r.merchantName)) return r.merchantName;
  if (present(r.plaidName)) return r.plaidName;
  return r.rawName;
}
