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
  ImportResult,
  MatchView,
  MutationResult,
  OwedView,
  PayeesView,
  RegisterView,
  ReportsView,
  RulePreview,
  RulesView,
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
  RuleBody,
  SetAssignedRequest,
  SettingsPatch,
  StartingBalances,
  TargetRequest,
  TransferPick,
  TxnPatch,
  ImportCsvRequest,
  MergePayees,
  RenameAccount,
  RenamePayee,
  SetupStart,
} from '@ledgerline/contracts';
import { z } from 'zod';
import { del, get, patch, post, put, qs } from './client';

type In<T extends z.ZodType> = z.input<T>;

const Ok = z.object({ ok: z.literal(true) });
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
  registerVerify: (body: { response: unknown; name: string }) => post('/api/auth/register/verify', Ok, body),
  loginOptions: () => post('/api/auth/login/options', z.unknown()),
  loginVerify: (body: { response: unknown }) => post('/api/auth/login/verify', Ok, body),
  security: () => get('/api/settings/security', SecurityView),
  deviceLink: () => post('/api/settings/security/device-link', DeviceLink),
  removePasskey: (id: string) => post(`/api/settings/security/passkeys/${enc(id)}/remove`, Ok),
  signOutOthers: () => post('/api/settings/security/sign-out-others', Ok),
  signOutSession: (id: string) => post('/api/settings/security/sign-out-session', Ok, { id }),
  revokeDevice: (id: string) => post(`/api/settings/security/devices/${enc(id)}/revoke`, Ok),
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

  activity: (filter: ActivityFilter, q?: string, cursor?: string) =>
    get(`/api/activity${qs({ filter, q, cursor })}`, ActivityView),
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

  rules: () => get('/api/settings/rules', RulesView),
  saveRule: (body: In<typeof RuleBody>) => post('/api/settings/rules', OkId, body),
  previewRule: (body: In<typeof RuleBody>) => post('/api/settings/rules/preview', RulePreview, body),
  applyRule: (id: string) => post(`/api/settings/rules/${enc(id)}/apply`, MutationResult),
  deleteRule: (id: string) => del(`/api/settings/rules/${enc(id)}`, Ok),

  payees: () => get('/api/settings/payees', PayeesView),
  mergePayees: (body: In<typeof MergePayees>) => post('/api/settings/payees/merge', Ok, body),
  renameAccount: (id: string, body: In<typeof RenameAccount>) =>
    post(`/api/accounts/${enc(id)}/name`, Ok, body),
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
  importCsv: (body: In<typeof ImportCsvRequest>) => post('/api/import/csv', ImportResult, body),
  note: (body: In<typeof NoteRequest>) => post('/api/notes', Ok, body),
};

/** File downloads go straight to the Worker (same origin, Access cookie). */
export const exportUrls = {
  json: '/api/export/json',
  csv: '/api/export/csv',
  usage: '/api/export/usage',
  rules: '/api/settings/rules/export',
} as const;
