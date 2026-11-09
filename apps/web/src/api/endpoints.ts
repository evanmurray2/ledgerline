// One function per endpoint in docs/api.md. Types come from @ledgerline/contracts.
import {
  AuthStatus,
  DeviceLink,
  SecurityView,
  AccountsView,
  ActivityView,
  AssignView,
  BudgetView,
  CategoriesView,
  CategorySheet,
  ConnectionsView,
  MatchView,
  MutationResult,
  OwedView,
  PayeesView,
  MergeResult,
  RegisterView,
  ReportsView,
  Session,
  TxnSheet,
} from '@ledgerline/contracts';
import type {
  AssignRequest,
  CategorizeRequest,
  CategoryUpsert,
  GroupUpsert,
  LinkTokenRequest,
  MatchRequest,
  MoveRequest,
  NewTxnRequest,
  NoteRequest,
  OwedAction,
  PendingCheckAction,
  SamePurchaseAnswer,
  SetAssignedRequest,
  SettingsPatch,
  StartingBalances,
  TargetRequest,
  TransferPick,
  TxnPatch,
  MergePayees,
  RenameAccount,
  RenamePayee,
  SetupStart,
} from '@ledgerline/contracts';
import { z } from 'zod';
import { del, get, patch, post, put, qs } from './client';

type In<T extends z.ZodType> = z.input<T>;

const Ok = z.object({ ok: z.literal(true) });
/** A new account or a recovery also returns the recovery code, shown once (D-75). */
const UsersView = z.object({
  users: z.number().int(),
  maxUsers: z.number().int(),
  signupsToday: z.number().int(),
  signupsPerDay: z.number().int(),
  signupsOpen: z.boolean(),
  list: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      admin: z.boolean(),
      status: z.string(),
      joinedAt: z.string(),
      lastSeenAt: z.string().nullable(),
      stuck: z.boolean(),
    }),
  ),
  next: z.string().nullable(),
});
export type UsersView = z.infer<typeof UsersView>;
const RegisterResult = z.object({ ok: z.literal(true), recoveryCode: z.string().optional() });
const OkId = z.object({ ok: z.literal(true), id: z.string() });
const LinkToken = z.object({ linkToken: z.string() });
const Exchange = z.object({ ok: z.literal(true), connectionId: z.string(), accounts: z.unknown() });

export type ActivityFilter = 'all' | 'attention' | 'pending';
export type RegisterShow = 'all' | 'pending' | 'needs' | 'transfers';

const enc = encodeURIComponent;

export const api = {
  session: () => get('/api/session', Session),
  /** Tab badge counts, cheaply: shown on every screen. */
  badges: () =>
    get(
      '/api/badges',
      z.object({
        activity: z.number().int(),
        accounts: z.number().int(),
        rta: z.number().int(),
        rtaUpdating: z.boolean(),
      }),
    ),

  // Sign-in (decisions.md D-27). Ceremony options and responses are WebAuthn JSON, passed through as-is.
  authStatus: () => get('/api/auth/status', AuthStatus),
  registerOptions: (body: { setupCode?: string; deviceToken?: string }) =>
    post('/api/auth/register/options', z.unknown(), body),
  registerVerify: (body: { response: unknown; name: string }) =>
    post('/api/auth/register/verify', RegisterResult, body),
  // Open sign-up and recovery codes (D-75): only while the switch is on.
  signupOptions: (body: { name: string; turnstileToken: string }) =>
    post('/api/auth/signup/options', z.unknown(), body),
  recoverOptions: (body: { code: string; turnstileToken: string }) =>
    post('/api/auth/recover/options', z.unknown(), body),
  newRecoveryCode: () => post('/api/settings/security/recovery-code', z.object({ code: z.string() })),
  dismissRecoveryNotice: () => post('/api/settings/security/recovery-notice/dismiss', Ok),
  // Deleting your own account, and Settings → Users for admins (D-75).
  deleteAccount: (budgetName: string) => post('/api/settings/security/delete-account', Ok, { budgetName }),
  users: (q: { before?: string; status?: string } = {}) =>
    get(
      `/api/settings/security/users?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][])}`,
      UsersView,
    ),
  userAction: (id: string, action: 'turn-off' | 'turn-on' | 'retry-delete') =>
    post(`/api/settings/security/users/${enc(id)}/${action}`, Ok),
  loginOptions: () => post('/api/auth/login/options', z.unknown()),
  loginVerify: (body: { response: unknown }) => post('/api/auth/login/verify', Ok, body),
  security: () => get('/api/settings/security', SecurityView),
  deviceLink: () => post('/api/settings/security/device-link', DeviceLink),
  removePasskey: (id: string) => post(`/api/settings/security/passkeys/${enc(id)}/remove`, Ok),
  signOutOthers: () => post('/api/settings/security/sign-out-others', Ok),
  signOutSession: (id: string) => post('/api/settings/security/sign-out-session', Ok, { id }),
  signOut: () => post('/api/settings/security/sign-out', Ok),

  budget: (month: string) => get(`/api/budget/${enc(month)}`, BudgetView),
  assign: (body: In<typeof AssignRequest>) => post('/api/budget/assign', MutationResult, body),
  setAssigned: (body: In<typeof SetAssignedRequest>) => post('/api/budget/set', MutationResult, body),
  move: (body: In<typeof MoveRequest>) => post('/api/budget/move', MutationResult, body),
  assignView: (month: string) => get(`/api/budget/${enc(month)}/assign`, AssignView),
  categorySheet: (id: string, month: string) =>
    get(`/api/categories/${enc(id)}/sheet${qs({ month })}`, CategorySheet),
  setTarget: (id: string, body: In<typeof TargetRequest>) =>
    put(`/api/categories/${enc(id)}/target`, MutationResult, body),

  activity: (filter: ActivityFilter, q?: string, cursor?: string, month?: string) =>
    get(`/api/activity${qs({ filter, q, cursor, month })}`, ActivityView),
  txn: (key: string) => get(`/api/transactions/${enc(key)}`, TxnSheet),
  patchTxn: (key: string, body: In<typeof TxnPatch>) =>
    patch(`/api/transactions/${enc(key)}`, MutationResult, body),
  categorize: (body: In<typeof CategorizeRequest>) =>
    post('/api/transactions/categorize', MutationResult, body),
  newTxn: (body: In<typeof NewTxnRequest>) => post('/api/transactions', MutationResult, body),
  pendingCheck: (key: string, body: In<typeof PendingCheckAction>) =>
    post(`/api/transactions/${enc(key)}/pending`, MutationResult, body),
  /** Clears a bank transaction's alert (e.g. it cleared at a different amount): the OK on Check these. */
  reviewTxn: (key: string) => post(`/api/transactions/${enc(key)}/review`, MutationResult),
  deleteTxn: (key: string) => del(`/api/transactions/${enc(key)}`, MutationResult),
  /** "Same purchase?" (docs/payee-names.md 9.1): Yes or No for one candidate of a card. */
  samePurchase: (v: { id: string } & In<typeof SamePurchaseAnswer>) =>
    post(`/api/same-purchase/${enc(v.id)}`, MutationResult, { answer: v.answer, key: v.key }),
  /** Not the same: undoes a pair (your entry and a bank row, or two bank rows), and remembers No. */
  notSame: (key: string) => post(`/api/transactions/${enc(key)}/not-same`, MutationResult),

  match: (inflowKey: string) => get(`/api/match/${enc(inflowKey)}`, MatchView),
  doMatch: (body: In<typeof MatchRequest>) => post('/api/match', MutationResult, body),
  unlink: (inflowKey: string) => post(`/api/match/${enc(inflowKey)}/unlink`, MutationResult),
  pickTransfer: (key: string, body: In<typeof TransferPick>) =>
    post(`/api/transfers/${enc(key)}/pick`, MutationResult, body),
  unpairTransfer: (key: string) => post(`/api/transfers/${enc(key)}/unpair`, MutationResult),

  owed: () => get('/api/owed', OwedView),
  owedAction: (id: string, body: In<typeof OwedAction>) => post(`/api/owed/${enc(id)}`, MutationResult, body),

  accounts: () => get('/api/accounts', AccountsView),
  register: (id: string, show: RegisterShow) =>
    get(`/api/accounts/${enc(id)}/register${qs({ show })}`, RegisterView),
  reports: (month: string) => get(`/api/reports${qs({ month })}`, ReportsView),

  categories: () => get('/api/settings/categories', CategoriesView),
  upsertCategory: (body: In<typeof CategoryUpsert>) => post('/api/settings/categories', OkId, body),
  upsertGroup: (body: In<typeof GroupUpsert>) => post('/api/settings/groups', OkId, body),
  pinCategory: ({ id, pinned }: { id: string; pinned: boolean }) =>
    post(`/api/settings/categories/${enc(id)}/pin`, MutationResult, { pinned }),
  archiveCategory: (id: string, archived: boolean) =>
    post(`/api/settings/categories/${enc(id)}/archive`, MutationResult, { archived }),
  reorderCategories: (ids: string[]) => post('/api/settings/categories/reorder', Ok, { ids }),
  reorderGroups: (ids: string[]) => post('/api/settings/groups/reorder', Ok, { ids }),
  /** Deleted when never used; otherwise archived, keeping its history. */
  removeCategory: (id: string) =>
    post(
      `/api/settings/categories/${enc(id)}/remove`,
      z.object({ ok: z.literal(true), outcome: z.enum(['deleted', 'archived']) }),
    ),
  removeGroup: (id: string) => post(`/api/settings/groups/${enc(id)}/remove`, Ok),

  payees: () => get('/api/settings/payees', PayeesView),
  mergePayees: (body: In<typeof MergePayees>) => post('/api/settings/payees/merge', MergeResult, body),
  undoMergePayees: (undoId: string) => post(`/api/settings/payees/merge/${enc(undoId)}/undo`, Ok, {}),
  dismissAlert: (id: string) => post(`/api/alerts/${enc(id)}/dismiss`, Ok, {}),
  renameAccount: (id: string, body: In<typeof RenameAccount>) =>
    post(`/api/accounts/${enc(id)}/name`, Ok, body),
  /** The app adds the balance and change number this phone shows (client.ts). */
  closeAccount: (id: string) => post(`/api/accounts/${enc(id)}/close`, Ok, {}),
  reopenAccount: (id: string) => post(`/api/accounts/${enc(id)}/reopen`, Ok, {}),
  renamePayee: (id: string, body: In<typeof RenamePayee>) =>
    post(`/api/settings/payees/${enc(id)}`, Ok, body),

  connections: () => get('/api/settings/connections', ConnectionsView),
  linkToken: (body: In<typeof LinkTokenRequest>) =>
    post('/api/settings/connections/link-token', LinkToken, body),
  exchange: (publicToken: string) => post('/api/settings/connections/exchange', Exchange, { publicToken }),
  refreshConnection: (id: string) => post(`/api/settings/connections/${enc(id)}/refresh`, Ok),
  refreshAll: () =>
    post('/api/settings/connections/refresh', z.object({ ok: z.literal(true), started: z.number().int() })),

  setupStart: (body: In<typeof SetupStart>) => post('/api/setup/start', Ok, body),
  startingBalances: (body: In<typeof StartingBalances>) =>
    post('/api/setup/starting-balances', MutationResult, body),
  patchSettings: (body: In<typeof SettingsPatch>) => patch('/api/settings', Ok, body),
  note: (body: In<typeof NoteRequest>) => post('/api/notes', Ok, body),
};

/** File downloads go straight to the Worker (same origin, Access cookie). */
export const exportUrls = {
  usage: '/api/export/usage',
} as const;
