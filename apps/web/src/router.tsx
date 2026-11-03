// Code-based route tree. Sheets are child routes: on a phone they slide up over their parent screen, on
// desktop they open in the side panel next to it.
import { useEffect } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
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
import { needsReload, reloadForVersion } from './state/version';
import { connectivity } from './state/connectivity';
import { usage } from './usage/tracker';
import { BudgetScreen } from './screens/Budget';
import { AssignSheetScreen, CategorySheetScreen, TargetScreen, TargetsScreen } from './screens/BudgetSheets';
import { CloseSheet, OwedScreen } from './screens/Owed';
import { ActivityScreen } from './screens/Activity';
import { RenamePayeeFromTxn, SplitScreen, TxnSheetScreen } from './screens/TxnSheets';
import { AddTxnScreen, CheckPendingScreen, MatchScreen, TransferScreen } from './screens/ActivitySheets';
import { AccountsScreen, RegisterScreen, RepairScreen } from './screens/Accounts';
import { AddDeviceScreen, ReauthDialog, SignInScreen } from './screens/Auth';
import { ApiError, errorMessage } from './api/client';
import { checkSaved, getCopy, onCopyChanged, start as startCopy, syncNow, flush, useCopy } from './copy/copy';
import { CopyScreen } from './screens/Lock';
import { toast } from './components/Toast';

// Screens opened now and then (Reports, Settings, Categories, first-run setup) load when first opened, so the app
// starts with less to download and parse. After a new release, a missing piece reloads the app once.
const reports = () => import('./screens/Reports');
const settings = () => import('./screens/Settings');
const setup = () => import('./screens/Setup');
const ReportsScreen = lazyRouteComponent(reports, 'ReportsScreen');
const AppearanceSection = lazyRouteComponent(settings, 'AppearanceSection');
const CategoriesScreen = lazyRouteComponent(settings, 'CategoriesScreen');
const CategoryEditSheet = lazyRouteComponent(settings, 'CategoryEditSheet');
const ConnectionsScreen = lazyRouteComponent(settings, 'ConnectionsScreen');
const DataScreen = lazyRouteComponent(settings, 'DataScreen');
const PayeesScreen = lazyRouteComponent(settings, 'PayeesScreen');
const RenamePayeeSheet = lazyRouteComponent(settings, 'RenamePayeeSheet');
const RuleEditScreen = lazyRouteComponent(settings, 'RuleEditScreen');
const RulesScreen = lazyRouteComponent(settings, 'RulesScreen');
const SettingsLayout = lazyRouteComponent(settings, 'SettingsLayout');
const FirstSortScreen = lazyRouteComponent(setup, 'FirstSortScreen');
const LinkBanksScreen = lazyRouteComponent(setup, 'LinkBanksScreen');
const StartMonthScreen = lazyRouteComponent(setup, 'StartMonthScreen');
const WelcomeScreen = lazyRouteComponent(setup, 'WelcomeScreen');

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function Root() {
  const session = useSession();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const qc = useQueryClient();
  // Offline start: useSession() stands in the session saved in the copy when the server can't be reached.
  const s = session.data;
  const copy = useCopy();
  // A session the server confirmed just now (not the one saved in the copy).
  const confirmed = session.isFetchedAfterMount && !session.error ? s : undefined;

  useEffect(() => void checkSaved(), []);
  // Every screen is worked out from the copy (D-44): open it once the server confirms who's signed in.
  useEffect(() => {
    if (confirmed && ['idle', 'locked'].includes(getCopy().status)) void startCopy(confirmed);
    // Back online after opening with no signal: send what was changed and catch up.
    if (confirmed && getCopy().status === 'ready' && getCopy().offline) void syncNow().then(() => flush());
  }, [confirmed]);
  // The copy changed (a sync brought news, or an offline edit): screens read it again.
  useEffect(
    () => onCopyChanged(() => void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'session' })),
    [qc],
  );
  useEffect(() => {
    const onLocked = () => qc.clear();
    const onRefused = (e: Event) =>
      toast.show({
        text: `${(e as CustomEvent<number>).detail} change(s) made offline couldn’t be saved. Your budget shows what the server has.`,
      });
    window.addEventListener('ledgerline:locked', onLocked);
    window.addEventListener('ledgerline:edits-refused', onRefused);
    return () => {
      window.removeEventListener('ledgerline:locked', onLocked);
      window.removeEventListener('ledgerline:edits-refused', onRefused);
    };
  }, [qc]);

  useEffect(() => {
    // The Worker refused a write because the daily limit was reached: refresh writeState and readOnlyUntil.
    const onReadOnly = () => void qc.invalidateQueries({ queryKey: qk.session });
    window.addEventListener('ledgerline:readonly', onReadOnly);
    // The session ended (24 hours, or signed out elsewhere): show sign-in.
    const onSignedOut = () => {
      // Only when the app was showing data; on the sign-in screen the session query already failed.
      // Drop everything in memory too, so nothing from the ended session is saved again.
      if (qc.getQueryData(qk.session)) qc.clear();
      // Opened signed out with saved data on the device: drop it, but keep the session check that said so.
      else qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
    };
    window.addEventListener('ledgerline:signedout', onSignedOut);
    return () => {
      window.removeEventListener('ledgerline:readonly', onReadOnly);
      window.removeEventListener('ledgerline:signedout', onSignedOut);
    };
  }, [qc]);

  // A new release is live: load its code (src/state/version.ts). Only on an answer fetched now, not a saved one.
  const fetchedVersion = session.isFetchedAfterMount ? s?.appVersion : undefined;
  useEffect(() => {
    if (fetchedVersion && needsReload(fetchedVersion)) return reloadForVersion(fetchedVersion);
  }, [fetchedVersion]);

  useEffect(() => {
    if (!s) return;
    usage.appVersion = s.appVersion;
    usage.setEnabled(s.settings.tracking);
    connectivity.setReadOnly(s.writeState === 'readonly', s.readOnlyUntil);
    // Resting ended (the daily limit reset): load every screen again.
    const wasPaused = connectivity.get().readsPaused;
    connectivity.setReadsPaused(s.readsPaused === true);
    if (wasPaused && !s.readsPaused) void qc.invalidateQueries();
  }, [s, qc]);

  const setupPath = path.startsWith('/setup') || path.startsWith('/welcome');
  if (path === '/add-device') return <AddDeviceScreen />;
  const unreachable = session.error instanceof ApiError && session.error.network;
  if (!s && unreachable && copy.hasSaved && copy.status !== 'ready')
    return (
      <CopyScreen copy={copy} session={null} onOffline={(saved) => qc.setQueryData(qk.savedSession, saved)} />
    );
  if (s && copy.status !== 'ready' && copy.status !== 'off' && copy.status !== 'idle')
    return (
      <CopyScreen
        copy={copy}
        session={confirmed ?? null}
        onOffline={(saved) => qc.setQueryData(qk.savedSession, saved)}
      />
    );
  if (s && copy.status === 'idle' && confirmed) return <Loading />;
  if (!s) {
    if (session.error instanceof ApiError && session.error.status === 401) return <SignInScreen />;
    if (session.error)
      return (
        <div className="p-4">
          {/* Cloudflare's daily limit ran out (decisions.md D-37): the reset time in the reader's own time zone. */}
          <ErrorNote
            error={
              session.error instanceof ApiError &&
              (session.error.code === 'daily_limit' ||
                session.error.code === 'resting' ||
                session.error.network)
                ? new Error(errorMessage(session.error))
                : session.error
            }
          />
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
    view: s.view === 'attention' || s.view === 'low' ? (s.view as 'attention' | 'low') : undefined,
    from: s.from === 'targets' || s.from === 'categories' ? (s.from as 'targets' | 'categories') : undefined,
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
const targetsRoute = createRoute({
  getParentRoute: () => budgetRoute,
  path: 'targets',
  component: TargetsScreen,
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
// Categories belong to the budget: their own page, opened from Budget, with Back returning there.
const categoriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/categories',
  component: CategoriesScreen,
});
const categoryEditRoute = createRoute({
  getParentRoute: () => categoriesRoute,
  path: '$categoryId',
  validateSearch: (s: Record<string, unknown>) => ({ group: str(s.group) }),
  component: CategoryEditSheet,
});
// Old links (bookmarks, history) from when Categories lived in Settings.
const oldCategoriesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'categories',
  beforeLoad: () => {
    throw redirect({ to: '/categories' });
  },
});
const oldCategoryRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'categories/$categoryId',
  beforeLoad: ({ params }) => {
    throw redirect({ to: `/categories/${params.categoryId}` });
  },
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
  budgetRoute.addChildren([categoryRoute, targetRoute, targetsRoute, assignRoute]),
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
  categoriesRoute.addChildren([categoryEditRoute]),
  settingsRoute.addChildren([
    appearanceRoute,
    oldCategoriesRoute,
    oldCategoryRoute,
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
    defaultPendingComponent: Loading,
  });
}
