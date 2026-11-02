// Budget months are 'YYYY-MM' in the budget's time zone (America/Los_Angeles). No date library: Intl gives the
// local calendar date, and month arithmetic is integer arithmetic.

export type Month = string & { readonly __month: true };
export type IsoDate = string;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function month(s: string): Month {
  if (!MONTH_RE.test(s)) throw new RangeError(`not a month: ${s}`);
  return s as Month;
}

export function isMonth(s: unknown): s is Month {
  return typeof s === 'string' && MONTH_RE.test(s);
}

export function isIsoDate(s: unknown): s is IsoDate {
  return typeof s === 'string' && DATE_RE.test(s);
}

/**
 * A date from a file someone imports: "2026-11-02" or US "11/2/2026". Returns the ISO date, or null when it isn't
 * a real calendar date (month 13, February 30, or day-first "25/12/2025").
 */
export function parseImportDate(input: string): IsoDate | null {
  const t = input.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  const iso = us ? `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}` : t;
  if (!isIsoDate(iso)) return null;
  return dayOfMonth(iso) <= daysInMonth(monthOfDate(iso)) ? iso : null;
}

function toIndex(m: Month): number {
  return Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
}

function fromIndex(i: number): Month {
  const y = Math.floor(i / 12);
  const mo = (i % 12) + 1;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}` as Month;
}

export function addMonths(m: Month, n: number): Month {
  return fromIndex(toIndex(m) + n);
}

/** b − a in months. */
export function monthsBetween(a: Month, b: Month): number {
  return toIndex(b) - toIndex(a);
}

export function monthOfDate(d: IsoDate): Month {
  return d.slice(0, 7) as Month;
}

export function compareMonth(a: Month, b: Month): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function monthRange(from: Month, through: Month): Month[] {
  const out: Month[] = [];
  for (let m = from; m <= through; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function daysInMonth(m: Month): number {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  if (mo === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(mo) ? 30 : 31;
}

export function dayOfMonth(d: IsoDate): number {
  return Number(d.slice(8, 10));
}

// Building an Intl.DateTimeFormat costs far more than using one, and localDate runs for every row on some screens,
// so one formatter per time zone is kept (docs/measurements.md, phase 0).
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar date in a time zone. */
export function localDate(epochMs: number, timeZone: string): IsoDate {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function currentMonth(epochMs: number, timeZone: string): Month {
  return monthOfDate(localDate(epochMs, timeZone));
}

export function addDays(d: IsoDate, n: number): IsoDate {
  const t =
    Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  const ta = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
  const tb = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)));
  return Math.round((tb - ta) / 86_400_000);
}
