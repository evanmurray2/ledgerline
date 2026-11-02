// Money is integer cents. No floating point anywhere in this package: amounts are parsed from strings and
// formatted with integer arithmetic only.

declare const CentsBrand: unique symbol;
export type Cents = number & { readonly [CentsBrand]: true };

export function cents(n: number): Cents {
  if (!Number.isSafeInteger(n)) throw new RangeError(`not integer cents: ${n}`);
  return (n === 0 ? 0 : n) as Cents;
}

export const ZERO = 0 as Cents;

export function add(a: Cents, b: Cents): Cents {
  return cents(a + b);
}

export function sub(a: Cents, b: Cents): Cents {
  return cents(a - b);
}

export function neg(a: Cents): Cents {
  return cents(-a);
}

export function sum(xs: readonly Cents[]): Cents {
  let s = 0;
  for (const x of xs) s += x;
  return cents(s);
}

export function min(a: Cents, b: Cents): Cents {
  return (a < b ? a : b) as Cents;
}

export function max(a: Cents, b: Cents): Cents {
  return (a > b ? a : b) as Cents;
}

export function clamp(v: Cents, lo: Cents, hi: Cents): Cents {
  return max(lo, min(v, hi));
}

/**
 * Parses "1,234.5", "-12", "$3.07", "−$18.25", "$-4" and accounting-style "(12.00)" into cents. Commas are only
 * thousands separators ("12,50" is refused, never read as 1,250). Rejects more than two decimals.
 */
export function parseCents(input: string): Cents {
  let s = input.trim().replace(/[−‒–]/g, '-').replace(/\s/g, '');
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) s = paren[1]!;
  // One dollar sign, before or after the sign.
  s = s.replace(/^([+-]?)\$/, '$1').replace(/^\$([+-])/, '$1');
  const m = /^([+-])?(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[2] === undefined && !m[3]) || (paren && m[1])) throw new RangeError(`not an amount: ${input}`);
  const whole = m[2] ? Number(m[2].replace(/,/g, '')) : 0;
  const frac = Number(((m[3] ?? '') + '00').slice(0, 2));
  const v = whole * 100 + frac;
  if (!Number.isSafeInteger(v)) throw new RangeError(`not an amount: ${input}`);
  return cents(m[1] === '-' || paren ? -v : v);
}

/** "$1,234.56" / "−$18.25" (true minus sign, as the UI shows). */
export function formatCents(c: Cents | number, opts: { sign?: 'auto' | 'always' } = {}): string {
  const n = Math.abs(c);
  const whole = Math.floor(n / 100);
  const frac = String(n % 100).padStart(2, '0');
  const w = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const prefix = c < 0 ? '−$' : opts.sign === 'always' && c > 0 ? '+$' : '$';
  return `${prefix}${w}.${frac}`;
}

/** ceil(a / b) for integers, b > 0, without floating point division on money. */
export function ceilDiv(a: number, b: number): number {
  if (b <= 0 || !Number.isSafeInteger(a) || !Number.isSafeInteger(b)) throw new RangeError('ceilDiv');
  const q = Math.trunc(a / b);
  return q * b < a ? q + 1 : q;
}

/** Splits an amount into n integer parts; the remainder goes to the last part (Targets: remainder to the last month). */
export function splitEvenly(total: Cents, n: number): Cents[] {
  if (n <= 0) throw new RangeError('splitEvenly');
  const base = Math.trunc(total / n);
  const parts = Array.from({ length: n }, () => cents(base));
  parts[n - 1] = cents(total - base * (n - 1));
  return parts;
}

/** Fraction of an amount, rounded half away from zero, never more than the amount. */
export function fractionOf(amount: Cents, num: number, den: number): Cents {
  if (den <= 0 || num < 0 || num > den) throw new RangeError('fractionOf');
  const a = Math.abs(amount);
  const v = Math.floor((a * num * 2 + den) / (2 * den));
  return cents(Math.sign(amount) * Math.min(v, a));
}
