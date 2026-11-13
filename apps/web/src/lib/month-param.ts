// `?month=` in a link (router.tsx). A month the app can't show is dropped from the address, so the screen shows this
// month with its month bar, instead of an error with no way on, or a month in the address that isn't the one shown.

/** The server's reach: a budget month at most this many months from this one (routes/api.ts MONTHS_IN_REACH). */
const MONTHS_IN_REACH = 120;

const index = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;

/** This month on the device's clock, 'YYYY-MM'. */
function deviceMonth(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * A `?month=` as 'YYYY-MM', or undefined when malformed or out of reach (about ten years from now). `notAfterNow`:
 * a screen that never shows a month after this one (Activity); a month after next is dropped too (one month of
 * slack, as the device's clock and the budget's time zone can differ at a month's turn).
 */
export function monthParam(
  v: unknown,
  opts: { notAfterNow?: boolean } = {},
  now = new Date(),
): string | undefined {
  if (typeof v !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) return undefined;
  const d = index(v) - index(deviceMonth(now));
  if (Math.abs(d) > MONTHS_IN_REACH - 1) return undefined;
  if (opts.notAfterNow && d > 1) return undefined;
  return v;
}
