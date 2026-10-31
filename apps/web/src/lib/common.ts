// Small hooks and formatters shared by several screens.
import { useEffect } from 'react';
import type { TxnListRow } from '@ledgerline/contracts';
import { usage } from '../usage/tracker';
import { useCategoriesSettings } from '../api/hooks';
import { dayLabel } from './dates';

/** Records a screen view under a fixed id, e.g. "budget.attention". */
export function useScreen(id: string) {
  useEffect(() => {
    usage.view(id);
  }, [id]);
}

/** Categories you can pick (no card payment categories, nothing archived), grouped. */
export function useCategoryOptions() {
  const q = useCategoriesSettings();
  const groups = (q.data?.groups ?? [])
    .filter((g) => !g.system)
    .map((g) => ({ id: g.id, name: g.name, categories: g.categories.map((c) => ({ id: c.id, name: c.name, available: c.available })) }));
  const byId = new Map(groups.flatMap((g) => g.categories.map((c) => [c.id, c.name] as const)));
  return { groups, byId, loading: q.isLoading };
}

/** The second line of a transaction row: account, date and category in the prototype's order. */
export function rowMeta(r: TxnListRow, style: 'list' | 'posted' | 'needs' | 'register' = 'list'): string {
  const date = dayLabel(r.date);
  const parts =
    style === 'posted'
      ? [date, r.accountName, r.categoryLabel]
      : style === 'needs'
        ? [r.accountName, date]
        : style === 'register'
          ? [r.status === 'pending' ? 'Pending' : null, r.categoryLabel ?? (r.badge === 'Needs category' ? null : null), r.sub]
          : r.status === 'upcoming'
            ? [date, r.categoryLabel]
            : [r.accountName, date, r.categoryLabel];
  return parts.filter((p): p is string => !!p).join(' · ');
}

export function useDebounced<T>(value: T, ms: number, set: (v: T) => void) {
  useEffect(() => {
    const id = setTimeout(() => set(value), ms);
    return () => clearTimeout(id);
  }, [value, ms, set]);
}
