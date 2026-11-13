// What a device keeps about the locked budgets it knows, outside its copy too (docs/privacy.md 5.3; split from
// copy.ts): which budgets it knows as sealed, and the last public entry of each log it saw. A wipe of the copy
// leaves both, and only signing out on this device forgets them.
import type { EngineHost } from './host';

const SEALED_FLAG = 'ledgerline.sealed';

/** The budgets this device knows as sealed (their ids, no more), kept outside the copy so a wipe leaves them. */
export const sealedBudgets = (): string[] => {
  try {
    return (localStorage.getItem(SEALED_FLAG) ?? '').split(',').filter(Boolean);
  } catch {
    return [];
  }
};
export function rememberSealed(budgetId: string): void {
  try {
    const all = sealedBudgets();
    if (!all.includes(budgetId)) localStorage.setItem(SEALED_FLAG, [...all, budgetId].join(','));
  } catch {
    // No storage: the device knows it only while the app is open.
  }
}
/** Only the person's own act on this device forgets it: signing out here. */
export function forgetSealed(budgetId: string | null): void {
  try {
    const rest = budgetId ? sealedBudgets().filter((b) => b !== budgetId) : [];
    if (rest.length) localStorage.setItem(SEALED_FLAG, rest.join(','));
    else localStorage.removeItem(SEALED_FLAG);
    if (budgetId) localStorage.removeItem(PUBLIC_MARK + budgetId);
  } catch {
    // Nothing kept, nothing to forget.
  }
}
// The last public entry of the log this device saw, kept in the copy and, as a second mark, outside it: a copy
// that is made again (or lives in memory only) still refuses a log that does not pass through it.
export const PUBLIC_MARK = 'ledgerline.public.';
export type PublicMark = { number: number; hash: string };
export async function lastPublicSeen(h: EngineHost, budgetId: string): Promise<PublicMark | null> {
  const marks: PublicMark[] = [];
  const kept = await h.get('last_public');
  if (kept) marks.push(JSON.parse(kept) as PublicMark);
  try {
    const out = localStorage.getItem(PUBLIC_MARK + budgetId);
    if (out) marks.push(JSON.parse(out) as PublicMark);
  } catch {
    // The copy's own mark is all there is.
  }
  return marks.sort((a, b) => b.number - a.number)[0] ?? null;
}
export async function keepPublicSeen(h: EngineHost, budgetId: string, m: PublicMark): Promise<void> {
  await h.put('last_public', JSON.stringify(m));
  try {
    localStorage.setItem(PUBLIC_MARK + budgetId, JSON.stringify(m));
  } catch {
    // The copy's own mark stays.
  }
}
