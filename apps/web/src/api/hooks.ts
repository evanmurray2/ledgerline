// TanStack Query hooks over the API. Reads are cached so the last loaded data stays visible offline; every
// mutation writes the returned Ready to Assign into the cached budget and invalidates what it may change.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { BudgetView, MutationResult } from '@ledgerline/contracts';
import { api, type ActivityFilter, type RegisterShow } from './endpoints';
import { usage } from '../usage/tracker';
import { ApiError } from './client';
import { connectivity, useConnectivity } from '../state/connectivity';
import { useEffect } from 'react';
import { setBudgetTimeZone, setBudgetYear } from '../lib/dates';

export const qk = {
  session: ['session'] as const,
  /** What the sign-in screen shows (first-time setup or sign in); it belongs to the signed-out state. */
  authStatus: ['auth-status'] as const,
  /** The last confirmed session, saved on the device for an offline start only (router.tsx). */
  savedSession: ['saved-session'] as const,
  budget: (month: string) => ['budget', month] as const,
  assign: (month: string) => ['budget', month, 'assign'] as const,
  category: (id: string, month: string) => ['category', id, month] as const,
  activity: (filter: ActivityFilter, q: string, month?: string, category?: string) =>
    ['activity', filter, q, month ?? '', category ?? ''] as const,
  txn: (key: string) => ['txn', key] as const,
  match: (key: string) => ['match', key] as const,
  owed: ['owed'] as const,
  accounts: ['accounts'] as const,
  register: (id: string, show: RegisterShow) => ['register', id, show] as const,
  reports: (month: string) => ['reports', month] as const,
  categories: ['settings', 'categories'] as const,
  payees: ['settings', 'payees'] as const,
  connections: ['settings', 'connections'] as const,
};

/**
 * The signed-in session. Saved screens are shown only after the server confirms you're signed in, except when the
 * check can't reach the server at all (offline start): then the last confirmed session, saved on this device and
 * cleared on sign-out or by any "signed out" answer, stands in, view-only. A 401 always means sign-in.
 */
export function useSession() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: qk.session,
    queryFn: api.session,
    staleTime: () => connectivity.staleMs(60_000),
  });
  const net = useConnectivity();
  // Watched, not just read: unlocking the copy with no signal puts its saved session here (copy.ts), and the app
  // has to show it at once.
  const savedQ = useQuery({
    queryKey: qk.savedSession,
    queryFn: () => qc.getQueryData<NonNullable<typeof q.data>>(qk.savedSession) ?? null,
    enabled: false,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (q.data) qc.setQueryData(qk.savedSession, q.data);
  }, [q.data, qc]);
  // Set during render, before any screen formats a clock time with it.
  const zone = (q.data ?? savedQ.data)?.budget.timeZone;
  if (zone) setBudgetTimeZone(zone);
  const today = (q.data ?? savedQ.data)?.budget.today;
  if (today) setBudgetYear(today);
  if (q.data) return q;
  const unreachable =
    (q.error instanceof ApiError && q.error.network) ||
    (!q.error && (q.fetchStatus === 'paused' || !net.online || net.networkFailed));
  const saved = unreachable ? (savedQ.data ?? undefined) : undefined;
  return saved ? ({ ...q, data: saved } as unknown as typeof q) : q;
}
export function useBudget(month: string | undefined) {
  return useQuery({ queryKey: qk.budget(month ?? ''), queryFn: () => api.budget(month!), enabled: !!month });
}
export function useAssignView(month: string | undefined) {
  return useQuery({
    queryKey: qk.assign(month ?? ''),
    queryFn: () => api.assignView(month!),
    enabled: !!month,
  });
}
export function useCategorySheet(id: string, month: string | undefined) {
  return useQuery({
    queryKey: qk.category(id, month ?? ''),
    queryFn: () => api.categorySheet(id, month!),
    enabled: !!month,
  });
}
export function useActivity(filter: ActivityFilter, q: string, month?: string, category?: string) {
  return useQuery({
    queryKey: qk.activity(filter, q, month, category),
    queryFn: () => api.activity(filter, q || undefined, undefined, month, category),
    // Keep the last list while a search or filter loads, but never one month's rows under another month's name.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[3] === (month ?? '') ? prev : undefined),
  });
}
export function useTxn(key: string) {
  return useQuery({ queryKey: qk.txn(key), queryFn: () => api.txn(key) });
}
export function useMatchView(key: string) {
  return useQuery({ queryKey: qk.match(key), queryFn: () => api.match(key) });
}
export function useOwed() {
  return useQuery({ queryKey: qk.owed, queryFn: api.owed });
}
/**
 * Change the Needs attention counts shown on screen (Activity's chip and the tab badge) by `delta`, without a
 * refetch: used when categorizing, which the screen already shows.
 */
export function adjustAttention(qc: QueryClient, delta: number) {
  qc.setQueriesData<{ attentionCount?: number; activity?: number }>({ queryKey: ['activity'] }, (old) => {
    if (!old || typeof old !== 'object') return old;
    if (typeof old.attentionCount === 'number')
      return { ...old, attentionCount: Math.max(0, old.attentionCount + delta) };
    if (typeof old.activity === 'number') return { ...old, activity: Math.max(0, old.activity + delta) };
    return old;
  });
  // Writing the cache marks it fresh again, which undid the mutation's "out of date" mark: coming back to Activity
  // within staleTime showed the old list, with a row you had just categorized under Needs category. Mark it again.
  void qc.invalidateQueries({ queryKey: ['activity'], refetchType: 'none' });
}

/** Tab badges. Keyed under 'activity' so every money change refreshes them too. */
export function useBadgeCounts() {
  return useQuery({ queryKey: ['activity', 'badges'], queryFn: api.badges, staleTime: 60_000 });
}
export function useAccounts() {
  return useQuery({ queryKey: qk.accounts, queryFn: api.accounts });
}
export function useRegister(id: string, show: RegisterShow) {
  return useQuery({
    queryKey: qk.register(id, show),
    queryFn: () => api.register(id, show),
    placeholderData: (prev) => prev,
  });
}
export function useReports(month: string | undefined) {
  return useQuery({
    queryKey: qk.reports(month ?? ''),
    queryFn: () => api.reports(month!),
    enabled: !!month,
    placeholderData: (prev) => prev,
  });
}
export function useCategoriesSettings() {
  return useQuery({ queryKey: qk.categories, queryFn: api.categories });
}
export function usePayees() {
  return useQuery({ queryKey: qk.payees, queryFn: api.payees });
}
export function useConnections() {
  return useQuery({ queryKey: qk.connections, queryFn: api.connections });
}

/** Everything a money change can touch. */
/**
 * After a money change. Keys whose first part is in `quiet` are only marked out of date, not refetched now: the
 * screen already shows the change (they refetch on the next visit). Each refetch reads from the database.
 */
export function invalidateMoney(qc: QueryClient, quiet: readonly string[] = []) {
  for (const key of [
    ['budget'],
    ['category'],
    ['activity'],
    ['txn'],
    ['match'],
    ['owed'],
    ['accounts'],
    ['register'],
    ['reports'],
  ])
    void qc.invalidateQueries({ queryKey: key, refetchType: quiet.includes(key[0]!) ? 'none' : 'active' });
}

function isMutationResult(x: unknown): x is MutationResult {
  return typeof x === 'object' && x !== null && 'rta' in x && 'ok' in x;
}

/** Put the returned Ready to Assign into every cached budget month right away. */
export function applyRta(qc: QueryClient, result: unknown) {
  if (!isMutationResult(result)) return;
  qc.setQueriesData<BudgetView>({ queryKey: ['budget'] }, (old) =>
    old && 'groups' in old && old.month === old.currentMonth
      ? { ...old, rta: result.rta, rtaUpdating: result.rtaUpdating }
      : old,
  );
}

/**
 * A mutation that updates the cache the same way everywhere. `invalidate` adds query keys beyond the money
 * set (for settings screens). Errors are recorded by code only.
 */
export function useMoneyMutation<TVars, TResult>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: { invalidate?: readonly (readonly unknown[])[]; money?: boolean; quiet?: readonly string[] } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      applyRta(qc, result);
      if (opts.money !== false) invalidateMoney(qc, opts.quiet);
      for (const key of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => {
      usage.error(err instanceof ApiError ? err.code : 'unknown');
      // Refused because the money changed since the screen was drawn: show it as it is now.
      if (err instanceof ApiError && err.code === 'changed') invalidateMoney(qc);
    },
  });
}

/**
 * Forgets what a signed-in session loaded, once the app learns the session ended. The sign-in screen's own check
 * (is setup open?) always stays: the event comes after the copy is dropped, so that check may already be in flight
 * or answered, and removing it cancelled it silently and left the screen on "Sign in" with setup open (the passkey
 * e2e failed that way on Nov 3).
 */
export function forgetSignedOut(qc: QueryClient): void {
  const signInCheck = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] === qk.authStatus[0];
  // Only when the app was showing data; on the sign-in screen the session query already failed.
  // Drop everything in memory too, so nothing from the ended session is saved again.
  if (qc.getQueryData(qk.session)) {
    qc.getMutationCache().clear();
    qc.removeQueries({ predicate: (q) => !signInCheck(q) });
  }
  // Opened signed out with saved data on the device: drop it, but keep the session check that said so.
  else qc.removeQueries({ predicate: (q) => q.queryKey[0] !== qk.session[0] && !signInCheck(q) });
}
