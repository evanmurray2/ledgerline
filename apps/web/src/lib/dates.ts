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

// Clock times show in the budget's time zone (Settings → Time zone), not the phone's. The session sets it
// (api/hooks.ts useSession); US Pacific until the session has loaded.
let budgetZone = 'America/Los_Angeles';

export function setBudgetTimeZone(timeZone: string): void {
  budgetZone = timeZone;
}

function zoneDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: budgetZone }).format(d);
}

/** An instant (ISO string or epoch ms) as a clock time in the budget's time zone, e.g. "4:00 PM". */
export function budgetTime(at: string | number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: budgetZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

/** Epoch ms as "Nov 12", or "9:42 AM" when it's today in the budget's time zone. */
export function syncedLabel(at: number | null, today: string): string {
  if (at === null) return 'never';
  const ymd = zoneDate(new Date(at));
  if (ymd === today) return budgetTime(at);
  return dayLabel(ymd);
}

/** Epoch ms as "Nov 12, 6:10 AM" in the budget's time zone. */
export function budgetDateTime(at: number): string {
  return `${dayLabel(zoneDate(new Date(at)))}, ${budgetTime(at)}`;
}
