// Dates arrive as 'YYYY-MM-DD' and months as 'YYYY-MM'. They're formatted by hand so a browser in another
// time zone never shifts a day.

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function parts(ymd: string): [number, number, number] {
  const [y, m, d] = ymd.split('-').map((x) => Number.parseInt(x, 10));
  return [y ?? 1970, m ?? 1, d ?? 1];
}

/** '2026-11' → 'November 2026' */
export function monthLabel(month: string): string {
  const [y, m] = parts(month);
  return `${MONTHS[m - 1]} ${y}`;
}

/** '2026-11' → 'November' */
export function monthName(month: string): string {
  return MONTHS[parts(month)[1] - 1] ?? '';
}

/** '2026-11' → 'Nov' */
export function monthShort(month: string): string {
  return monthName(month).slice(0, 3);
}

/** '2026-11-14' → 'Nov 14' */
export function dayLabel(date: string): string {
  const [, m, d] = parts(date);
  return `${(MONTHS[m - 1] ?? '').slice(0, 3)} ${d}`;
}

export function addMonths(month: string, n: number): string {
  const [y, m] = parts(month);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

export function compareMonths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const PACIFIC = 'America/Los_Angeles';

/** An instant (ISO string or epoch ms) as a Pacific clock time, e.g. "4:00 PM". */
export function pacificTime(at: string | number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, hour: 'numeric', minute: '2-digit' }).format(
    d,
  );
}

/** Epoch ms as "Nov 12" or "9:42 AM" when it's today in Pacific time. */
export function syncedLabel(at: number | null, today: string): string {
  if (at === null) return 'never';
  const d = new Date(at);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: PACIFIC }).format(d);
  if (ymd === today) return pacificTime(at);
  return dayLabel(ymd);
}

/** Epoch ms as "Nov 12, 6:10 AM" in Pacific time. */
export function pacificDateTime(at: number): string {
  const d = new Date(at);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: PACIFIC }).format(d);
  return `${dayLabel(ymd)}, ${pacificTime(at)}`;
}
