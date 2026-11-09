// Categories pinned to the top of Budget (D-74): one setting holding their ids, oldest pin first. Changes no money.

export const PINNED_KEY = 'pinnedCategories';

export function readPinned(value: string | null | undefined): string[] {
  try {
    const v: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
