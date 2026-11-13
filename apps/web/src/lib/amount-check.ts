// What the server would refuse in an amount or a date box, said before Save: the button's `why` line shows it, so
// the person never taps a button that does nothing or gets a vague message back.
import { addMonths } from './dates';
import { parseCents } from './money';

/** The largest amount the server stores (routes/api.ts MAX_AMOUNT). */
export const MAX_AMOUNT = 9_999_999_999;
/** How far from this month a date or month may be (routes/api.ts MONTHS_IN_REACH). */
const MONTHS_IN_REACH = 120;

/**
 * Why the typed amount can't be saved, or '' when it can. Amounts are typed without a sign (the direction gives
 * it). `zero`: $0.00 is a valid answer.
 */
export function amountWhy(input: string, opts: { zero?: boolean } = {}): string {
  const t = input.trim();
  if (t === '') return 'Enter an amount';
  const c = parseCents(t);
  if (c === null) return /\.\d{3,}$/.test(t) ? 'Enter at most 2 digits for cents' : 'Enter an amount';
  if (c < 0) return 'Enter an amount without a minus sign';
  if (c === 0 && !opts.zero) return 'Enter an amount above $0.00';
  if (c > MAX_AMOUNT) return 'Enter an amount up to $99,999,999.99';
  return '';
}

/** Why a date (YYYY-MM-DD) can't be saved: more than 10 years from today. '' when it can. */
export function dateWhy(date: string, today: string): string {
  if (!date || !today) return '';
  const m = date.slice(0, 7);
  const cur = today.slice(0, 7);
  return m > addMonths(cur, MONTHS_IN_REACH) || m < addMonths(cur, -MONTHS_IN_REACH)
    ? 'Pick a date within 10 years of today'
    : '';
}
