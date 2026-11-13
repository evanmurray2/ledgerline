// The last public entry of the budget's log this device saw (split from copy/copy.ts): kept in the copy and, as a
// second mark, outside it, so a copy that is made again (or lives in memory only) still refuses a log that does not
// pass through it.
import type { EngineHost } from './host';

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
