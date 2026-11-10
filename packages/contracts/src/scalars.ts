// The scalar schemas every contract file shares: money in integer cents, months 'YYYY-MM', dates 'YYYY-MM-DD', ids.
// Not part of the package's exports (index.ts doesn't re-export them).
import { z } from 'zod';

export const cents = z.number().int();
export const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const id = z.string().min(1).max(80);

/**
 * A date someone sends: 'YYYY-MM-DD' that is a real calendar date (no month 13, no February 30), so a row can't land
 * in a month that doesn't exist and drop out of every month's count. Answers keep the looser `date`.
 */
export const calendarDate = date.refine((s) => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = m === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
  return m >= 1 && m <= 12 && d >= 1 && d <= days;
});
