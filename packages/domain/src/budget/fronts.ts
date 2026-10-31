// Rule 13: for each scheduled transaction with an owed rule (e.g. rent), if current RTA is less than the owed
// amount, Needs attention shows the projected shortfall before the date.
import { type Cents, cents } from '../money.js';
import type { IsoDate } from '../month.js';

export interface ScheduledFront {
  key: string;
  date: IsoDate;
  /** The owed part the scheduled outflow will take out of RTA. */
  owed: Cents;
}

export interface ProjectedShortfall extends ScheduledFront {
  shortfall: Cents;
}

export function projectedFronts(
  rta: Cents,
  scheduled: readonly ScheduledFront[],
  today: IsoDate,
): ProjectedShortfall[] {
  return scheduled
    .filter((s) => s.date >= today && rta < s.owed)
    .map((s) => ({ ...s, shortfall: cents(s.owed - rta) }));
}
