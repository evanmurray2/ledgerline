// Money is integer cents everywhere. Formatting and parsing use integer and string arithmetic only: no floats,
// no division on amounts, no parseFloat.

export const MINUS = '−'; // true minus sign, as the prototype uses: −$18.25

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface FormatOptions {
  /** Prefix positive amounts with "+" (inflows in lists). */
  plus?: boolean;
  /** Drop ".00" for whole dollars ("$1,000"). */
  whole?: boolean;
}

/** 1825 → "$18.25", -1825 → "−$18.25", 101800 → "$1,018.00". */
export function formatCents(cents: number, opts: FormatOptions = {}): string {
  if (!Number.isInteger(cents)) throw new TypeError(`money must be integer cents, got ${cents}`);
  const negative = cents < 0;
  const abs = negative ? -cents : cents;
  const s = String(abs).padStart(3, '0');
  const dollars = groupThousands(s.slice(0, -2));
  const frac = s.slice(-2);
  const body = opts.whole && frac === '00' ? `$${dollars}` : `$${dollars}.${frac}`;
  if (negative) return MINUS + body;
  if (opts.plus && abs > 0) return '+' + body;
  return body;
}

/** Plain number for an input box: 21240 → "212.40", -500 → "−5.00". */
export function centsToInput(cents: number): string {
  const f = formatCents(cents);
  return f.replace(/[$,]/g, '');
}

const MONEY_RE = /^([−-])?\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{0,2}))?$/;

/**
 * Parses what a person types into a money box: "18.25", "$1,018", "-5", "−5.5", ".75".
 * Returns integer cents, or null when it isn't a valid amount (more than two decimals, letters, empty).
 */
export function parseCents(input: string): number | null {
  const t = input.trim();
  if (t === '') return null;
  const m = MONEY_RE.exec(t);
  if (!m) return null;
  const [, sign, dollarsRaw, fracRaw] = m;
  if (dollarsRaw === undefined && (fracRaw === undefined || fracRaw === '')) return null;
  const dollars = dollarsRaw ? Number.parseInt(dollarsRaw.replace(/,/g, ''), 10) : 0;
  const frac = fracRaw ? Number.parseInt(fracRaw.padEnd(2, '0'), 10) : 0;
  if (!Number.isSafeInteger(dollars * 100 + frac)) return null;
  const cents = dollars * 100 + frac;
  return sign ? -cents : cents;
}

/** Percentage of a whole, rounded, for bars only (never for money). */
export function percentOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part * 100) / whole)));
}
