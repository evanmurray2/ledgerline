/** A detail that stands on its own line starts with a capital ("Needs $90.00 this month"); after a status word and
 * a dot it stays lower case ("Underfunded · needs $90.00 this month"). */
export function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Keeps "9:00 AM" on one line in text the budget's engine wrote ("Chase · ending 0912 · synced 9:00 AM"). */
export function keepTimes(s: string): string {
  return s.replace(/(\d) (?=[AP]M\b)/g, '$1 ');
}
