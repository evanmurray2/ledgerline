// Every screen the app reads, with the schema its answer must match. The Worker and the web app's mock server are
// both checked against this list (apps/worker/test/screens.test.ts, apps/web/test/mock-contract.test.ts), so the
// mock can't drift from the real API without a test failing. `{month}`, `{category}`, `{txn}` and `{account}` are
// filled from the data each side holds (`fillScreen`).
import type { z } from 'zod';
import {
  AccountsView,
  ActivityView,
  AssignView,
  BudgetView,
  CategoriesView,
  CategorySheet,
  ConnectionsView,
  OwedView,
  PayeesView,
  RegisterView,
  ReportsView,
  Session,
  TxnSheet,
} from './index.js';

export interface Screen {
  path: string;
  schema: z.ZodType;
}

export const SCREENS: Screen[] = [
  { path: '/api/session', schema: Session },
  { path: '/api/budget/{month}', schema: BudgetView },
  { path: '/api/budget/{month}/assign', schema: AssignView },
  { path: '/api/categories/{category}/sheet?month={month}', schema: CategorySheet },
  { path: '/api/activity', schema: ActivityView },
  { path: '/api/activity?filter=attention', schema: ActivityView },
  { path: '/api/transactions/{txn}', schema: TxnSheet },
  { path: '/api/owed', schema: OwedView },
  { path: '/api/accounts', schema: AccountsView },
  { path: '/api/accounts/{account}/register', schema: RegisterView },
  { path: '/api/reports?month={month}', schema: ReportsView },
  { path: '/api/settings/categories', schema: CategoriesView },
  { path: '/api/settings/payees', schema: PayeesView },
  { path: '/api/settings/connections', schema: ConnectionsView },
];

export interface ScreenIds {
  month: string;
  category?: string;
  txn?: string;
  account?: string;
}

/** The path with its placeholders filled, or null when the data has nothing to fill one with (an empty budget). */
export function fillScreen(path: string, ids: ScreenIds): string | null {
  let missing = false;
  const out = path.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = ids[k as keyof ScreenIds];
    if (!v) missing = true;
    return encodeURIComponent(v ?? '');
  });
  return missing ? null : out;
}

/** Ids to fill the paths with, read from the budget, activity and accounts answers. */
export function screenIds(
  month: string,
  budget: z.infer<typeof BudgetView>,
  activity: z.infer<typeof ActivityView>,
  accounts: z.infer<typeof AccountsView>,
): ScreenIds {
  return {
    month,
    category: budget.groups.flatMap((g) => g.categories)[0]?.id,
    txn: (activity.posted[0] ?? activity.pending[0])?.key,
    account: accounts.groups.flatMap((g) => g.accounts)[0]?.id,
  };
}
