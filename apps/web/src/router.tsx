// Code-based route tree. Sheets are child routes: on a phone they slide up over their parent screen, on
// desktop they open in the side panel next to it.
import { useEffect } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  redirect,
  useRouterState,
  type RouterHistory,
} from '@tanstack/react-router';
import { AppShell } from './components/AppShell';
import { ErrorNote, Loading } from './components/ui';
import { useQueryClient } from '@tanstack/react-query';
import { qk, useSession } from './api/hooks';
import { connectivity } from './state/connectivity';
import { usage } from './usage/tracker';
import { BudgetScreen } from './screens/Budget';
import { AssignSheetScreen, CategorySheetScreen, TargetScreen } from './screens/BudgetSheets';
import { CloseSheet, OwedScreen } from './screens/Owed';
import { ActivityScreen } from './screens/Activity';
import { RenamePayeeFromTxn, SplitScreen, TxnSheetScreen } from './screens/TxnSheets';
import { AddTxnScreen, CheckPendingScreen, MatchScreen, TransferScreen } from './screens/ActivitySheets';
import { AccountsScreen, RegisterScreen, RepairScreen } from './screens/Accounts';
import { ReportsScreen } from './screens/Reports';
import {
  AppearanceSection,
  CategoriesScreen,
  CategoryEditSheet,
  ConnectionsScreen,
  DataScreen,
  PayeesScreen,
  RenamePayeeSheet,
  RuleEditScreen,
  RulesScreen,
  SettingsLayout,
} from './screens/Settings';
import { FirstSortScreen, LinkBanksScreen, StartMonthScreen, WelcomeScreen } from './screens/Setup';
import { AddDeviceScreen, ReauthDialog, SignInScreen } from './screens/Auth';
import { ApiError } from './api/client';

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function Root() {
  const session = useSession();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const s = session.data;
  const qc = useQueryClient();

  useEffect(() => {
    // The Worker refused a write because the daily limit was reached: refresh writeState and readOnlyUntil.
    const onReadOnly = () => void qc.invalidateQueries({ queryKey: qk.session });
    window.addEventListener('ledgerline:readonly', onReadOnly);
    // The session ended (24 hours, or signed out elsewhere): show sign-in.
    const onSignedOut = () => {
      // Only when the app was showing data; on the sign-in screen the session query already failed.
      // Drop everything in memory too, so nothing from the ended session is saved again.
      if (qc.getQueryData(qk.session)) qc.clear();
    };
    window.addEventListener('ledgerline:signedout', onSignedOut);
    return () => {
      window.removeEventListener('ledgerline:readonly', onReadOnly);
      window.removeEventListener('ledgerline:signedout', onSignedOut);
    };
  }, [qc]);

  useEffect(() => {
    if (!s) return;
    usage.appVersion = s.appVersion;
    usage.setEnabled(s.settings.tracking);
    connectivity.setReadOnly(s.writeState === 'readonly', s.readOnlyUntil);
  }, [s]);

  const setupPath = path.startsWith('/setup') || path.startsWith('/welcome');
  if (path === '/add-device') return <AddDeviceScreen />;
  if (!s) {
    if (session.error instanceof ApiError && session.error.status === 401) return <SignInScreen />;
    if (session.error)
      return (
        <div className="p-4">
          <ErrorNote error={session.error} />
        </div>
      );
    return <Loading />;
  }
  if (s.budget.setupStep !== 'done' && !setupPath) {
    const to =
      s.budget.setupStep === 'start'
        ? '/welcome'
        : s.budget.setupStep === 'link'
          ? '/setup/link'
          : '/setup/categories';
    return <Navigate to={to} replace />;
  }
  if (setupPath)
    return (
      <>
        <Outlet />
        <ReauthDialog />
      </>
    );
  return (
    <AppShell>
      <Outlet />
      <ReauthDialog />
    </AppShell>
  );
}

const rootRoute = createRootRoute({ component: Root });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/budget' });
  },
});

// ------------------------------------------------------------------ sign-in
// Root renders the add-device screen itself, before any session check; this route only makes the path known.
const addDeviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/add-device',
  component: () => null,
});

// ------------------------------------------------------------------ first run
const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/welcome',
  component: WelcomeScreen,
});
const setupStartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup/start',
  component: StartMonthScreen,
});
const setupLinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup/link',
  component: LinkBanksScreen,
});
const setupCatsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup/categories',
  component: FirstSortScreen,
});

// ------------------------------------------------------------------ budget
const budgetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/budget',
  validateSearch: (s: Record<string, unknown>) => ({
    month: str(s.month),
    view: s.view === 'attention' ? ('attention' as const) : undefined,
  }),
  component: BudgetScreen,
});
const categoryRoute = createRoute({
  getParentRoute: () => budgetRoute,
  path: 'category/$categoryId',
  component: CategorySheetScreen,
});
const targetRoute = createRoute({
  getParentRoute: () => budgetRoute,
  path: 'category/$categoryId/target',
  component: TargetScreen,
});
const assignRoute = createRoute({
  getParentRoute: () => budgetRoute,
  path: 'assign',
  component: AssignSheetScreen,
});

const owedRoute = createRoute({ getParentRoute: () => rootRoute, path: '/owed', component: OwedScreen });
const owedCloseRoute = createRoute({
  getParentRoute: () => owedRoute,
  path: 'close/$itemId',
  component: CloseSheet,
});
const owedMatchRoute = createRoute({
  getParentRoute: () => owedRoute,
  path: 'match/$key',
  component: MatchScreen,
});

// ------------------------------------------------------------------ activity
const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activity',
  validateSearch: (s: Record<string, unknown>) => ({
    filter: s.filter === 'attention' || s.filter === 'pending' ? s.filter : undefined,
    q: str(s.q),
  }),
  component: ActivityScreen,
});
const txnRoute = createRoute({
  getParentRoute: () => activityRoute,
  path: 'txn/$key',
  component: TxnSheetScreen,
});
const splitRoute = createRoute({
  getParentRoute: () => activityRoute,
  path: 'txn/$key/split',
  component: SplitScreen,
});
const renameTxnRoute = createRoute({
  getParentRoute: () => activityRoute,
  path: 'txn/$key/rename',
  component: RenamePayeeFromTxn,
});
const matchRoute = createRoute({
  getParentRoute: () => activityRoute,
  path: 'match/$key',
  component: MatchScreen,
});
const transferRoute = createRoute({
  getParentRoute: () => activityRoute,
  path: 'transfer/$key',
  component: TransferScreen,
});
const checkRoute = createRoute({
  getParentRoute: () => activityRoute,
  path: 'check/$key',
  component: CheckPendingScreen,
});
const addRoute = createRoute({ getParentRoute: () => activityRoute, path: 'add', component: AddTxnScreen });

// ------------------------------------------------------------------ accounts
const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts',
  component: AccountsScreen,
});
const repairRoute = createRoute({
  getParentRoute: () => accountsRoute,
  path: 'repair/$connectionId',
  component: RepairScreen,
});
const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts/$accountId',
  validateSearch: (s: Record<string, unknown>) => ({
    show: s.show === 'pending' || s.show === 'needs' || s.show === 'transfers' ? s.show : undefined,
  }),
  component: RegisterScreen,
});
const registerTxnRoute = createRoute({
  getParentRoute: () => registerRoute,
  path: 'txn/$key',
  component: TxnSheetScreen,
});
const registerSplitRoute = createRoute({
  getParentRoute: () => registerRoute,
  path: 'txn/$key/split',
  component: SplitScreen,
});
const registerXferRoute = createRoute({
  getParentRoute: () => registerRoute,
  path: 'transfer/$key',
  component: TransferScreen,
});
const registerMatchRoute = createRoute({
  getParentRoute: () => registerRoute,
  path: 'match/$key',
  component: MatchScreen,
});
const registerCheckRoute = createRoute({
  getParentRoute: () => registerRoute,
  path: 'check/$key',
  component: CheckPendingScreen,
});

// ------------------------------------------------------------------ reports
const reportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reports',
  validateSearch: (s: Record<string, unknown>) => ({ month: str(s.month) }),
  component: ReportsScreen,
});

// ------------------------------------------------------------------ settings
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsLayout,
});
const appearanceRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'appearance',
  component: AppearanceSection,
});
const categoriesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'categories',
  component: CategoriesScreen,
});
const categoryEditRoute = createRoute({
  getParentRoute: () => categoriesRoute,
  path: '$categoryId',
  component: CategoryEditSheet,
});
const rulesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'rules',
  component: RulesScreen,
});
const ruleEditRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'rules/$ruleId',
  component: RuleEditScreen,
});
const payeesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'payees',
  component: PayeesScreen,
});
const payeeRenameRoute = createRoute({
  getParentRoute: () => payeesRoute,
  path: '$payeeId',
  component: RenamePayeeSheet,
});
const connectionsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'connections',
  component: ConnectionsScreen,
});
const dataRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'data', component: DataScreen });

const routeTree = rootRoute.addChildren([
  addDeviceRoute,
  indexRoute,
  welcomeRoute,
  setupStartRoute,
  setupLinkRoute,
  setupCatsRoute,
  budgetRoute.addChildren([categoryRoute, targetRoute, assignRoute]),
  owedRoute.addChildren([owedCloseRoute, owedMatchRoute]),
  activityRoute.addChildren([
    txnRoute,
    splitRoute,
    renameTxnRoute,
    matchRoute,
    transferRoute,
    checkRoute,
    addRoute,
  ]),
  accountsRoute.addChildren([repairRoute]),
  registerRoute.addChildren([
    registerTxnRoute,
    registerSplitRoute,
    registerXferRoute,
    registerMatchRoute,
    registerCheckRoute,
  ]),
  reportsRoute,
  settingsRoute.addChildren([
    appearanceRoute,
    categoriesRoute.addChildren([categoryEditRoute]),
    rulesRoute,
    ruleEditRoute,
    payeesRoute.addChildren([payeeRenameRoute]),
    connectionsRoute,
    dataRoute,
  ]),
]);

export function makeRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    defaultPreload: false,
    defaultNotFoundComponent: () => <Navigate to="/budget" replace />,
  });
}
