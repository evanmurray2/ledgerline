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
    .map((g) => ({
      id: g.id,
      name: g.name,
      categories: g.categories.map((c) => ({ id: c.id, name: c.name, available: c.available })),
    }));
  const byId = new Map(groups.flatMap((g) => g.categories.map((c) => [c.id, c.name] as const)));
  return { groups, byId, loading: q.isLoading };
}

/** The second line of a transaction row: account, date and category in the prototype's order. */
/**
 * A row's grey line: where and when, two facts at most. The category and any status show as tags under it
 * (TxnRow), and a register's rows already sit under their account and date, so theirs is empty.
 */
export function rowMeta(r: TxnListRow, style: 'list' | 'posted' | 'needs' | 'register' = 'list'): string {
  const date = dayLabel(r.date);
  const parts =
    style === 'register'
      ? []
      : style === 'posted'
        ? [date, r.accountName]
        : r.status === 'upcoming' && style === 'list'
          ? [date]
          : [r.accountName, date];
  return parts.filter((p): p is string => !!p).join(' · ');
}

export function useDebounced<T>(value: T, ms: number, set: (v: T) => void) {
  useEffect(() => {
    const id = setTimeout(() => set(value), ms);
    return () => clearTimeout(id);
  }, [value, ms, set]);
}
