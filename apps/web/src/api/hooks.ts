// TanStack Query hooks over the API. Reads are cached so the last loaded data stays visible offline; every
// mutation writes the returned Ready to Assign into the cached budget and invalidates what it may change.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { BudgetView, MutationResult } from '@ledgerline/contracts';
import { api, type ActivityFilter, type RegisterShow } from './endpoints';
import { usage } from '../usage/tracker';
import { ApiError } from './client';

export const qk = {
  session: ['session'] as const,
  budget: (month: string) => ['budget', month] as const,
  assign: (month: string) => ['budget', month, 'assign'] as const,
  category: (id: string, month: string) => ['category', id, month] as const,
  activity: (filter: ActivityFilter, q: string) => ['activity', filter, q] as const,
  txn: (key: string) => ['txn', key] as const,
  match: (key: string) => ['match', key] as const,
  owed: ['owed'] as const,
  accounts: ['accounts'] as const,
  register: (id: string, show: RegisterShow) => ['register', id, show] as const,
  reports: (month: string) => ['reports', month] as const,
  categories: ['settings', 'categories'] as const,
  rules: ['settings', 'rules'] as const,
  payees: ['settings', 'payees'] as const,
  connections: ['settings', 'connections'] as const,
};

export function useSession() {
  return useQuery({ queryKey: qk.session, queryFn: api.session, staleTime: 60_000 });
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
export function useActivity(filter: ActivityFilter, q: string) {
  return useQuery({
    queryKey: qk.activity(filter, q),
    queryFn: () => api.activity(filter, q || undefined),
    placeholderData: (prev) => prev,
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
export function useRules() {
  return useQuery({ queryKey: qk.rules, queryFn: api.rules });
}
export function usePayees() {
  return useQuery({ queryKey: qk.payees, queryFn: api.payees });
}
export function useConnections() {
  return useQuery({ queryKey: qk.connections, queryFn: api.connections });
}

/** Everything a money change can touch. */
export function invalidateMoney(qc: QueryClient) {
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
    void qc.invalidateQueries({ queryKey: key });
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
  opts: { invalidate?: readonly (readonly unknown[])[]; money?: boolean } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      applyRta(qc, result);
      if (opts.money !== false) invalidateMoney(qc);
      for (const key of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => {
      usage.error(err instanceof ApiError ? err.code : 'unknown');
    },
  });
}
