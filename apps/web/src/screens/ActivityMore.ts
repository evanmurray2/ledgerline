// Activity's "Show more": posted rows after the first page. Split from Activity.tsx.
import { useState } from 'react';
import type { ActivityView, TxnListRow } from '@ledgerline/contracts';
import { api, type ActivityFilter } from '../api/endpoints';
import { ApiError, errorMessage } from '../api/client';
import { toast } from '../components/Toast';

/**
 * Posted rows after the first page of 50 ("Show more"), read with the page's cursor. Starts again whenever the
 * list itself changes (another month, filter or search).
 */
export function useMorePosted(
  v: ActivityView | undefined,
  filter: ActivityFilter,
  q: string,
  month?: string,
  category?: string,
) {
  const [state, setState] = useState<{ key: string; rows: TxnListRow[]; cursor: string | null }>({
    key: '',
    rows: [],
    cursor: null,
  });
  const [loading, setLoading] = useState(false);
  const key = `${filter}|${q}|${month ?? ''}|${category ?? ''}|${v?.nextCursor ?? ''}`;
  const mine = state.key === key;
  const cursor = mine ? state.cursor : (v?.nextCursor ?? null);
  const load = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await api.activity(filter, q || undefined, cursor, month, category);
      setState({ key, rows: [...(mine ? state.rows : []), ...page.posted], cursor: page.nextCursor });
    } catch (e) {
      toast.show({ text: e instanceof ApiError ? errorMessage(e) : 'Couldn’t load more. Try again.' });
    } finally {
      setLoading(false);
    }
  };
  // The server gives a cursor whenever a page holds 50 rows; a shorter page is the last.
  const hasMore = !!cursor && (mine ? true : (v?.posted.length ?? 0) >= 50);
  return { rows: mine ? state.rows : [], cursor: hasMore ? cursor : null, loading, load };
}
