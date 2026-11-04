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

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

/** Clock time in a time zone, e.g. "4:05 PM". */
export function localTime(epochMs: number, timeZone: string): string {
  let fmt = timeFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
    timeFormatters.set(timeZone, fmt);
  }
  return fmt.format(new Date(epochMs));
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** How far a time zone's clock is ahead of UTC at an instant, in ms (negative west of UTC). */
function zoneOffset(epochMs: number, timeZone: string): number {
  let fmt = clockFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    clockFormatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return wall - Math.floor(epochMs / 60_000) * 60_000;
}

/**
 * The next instant strictly after now when the clock in a time zone reads hour:minute, so a daily job keeps its
 * local time through daylight saving changes. A time the clock skips (2:30 AM on the spring change) comes an hour
 * later that day.
 */
export function nextLocalTime(now: number, timeZone: string, hour: number, minute: number): number {
  const today = localDate(now, timeZone);
  for (let i = 0; ; i++) {
    const d = addDays(today, i);
    const wall = Date.UTC(
      Number(d.slice(0, 4)),
      Number(d.slice(5, 7)) - 1,
      Number(d.slice(8, 10)),
      hour,
      minute,
    );
    // Guess with the offset at the wall time read as UTC, then correct once with the offset at the guess.
    const t = wall - zoneOffset(wall - zoneOffset(wall, timeZone), timeZone);
    if (t > now) return t;
  }
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
