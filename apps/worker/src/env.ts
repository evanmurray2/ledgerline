export interface Env {
  DB: D1Database;
  /** docs/multi-user.md: the Directory (one object) and one BudgetStore per budget. Unused until routing ships. */
  DIRECTORY: DurableObjectNamespace<import('./store/directory.js').Directory>;
  BUDGET: DurableObjectNamespace<import('./store/budget-store.js').BudgetStore>;
  SYNC: Workflow<SyncParams>;
  MAINTENANCE: Workflow<MaintenanceParams>;
  RECOMPUTE: Workflow<RecomputeParams>;
  ASSETS?: Fetcher;
  /** 'sandbox' | 'production'. Production keys exist only in the production Worker. */
  PLAID_ENV: string;
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  /** Local Plaid-shaped mock (development and tests only). */
  PLAID_BASE_URL?: string;
  PLAID_WEBHOOK_URL?: string;
  PLAID_REDIRECT_URI?: string;
  /** "1:base64key,2:base64key" and the current version. */
  TOKEN_KEYS?: string;
  TOKEN_KEY_CURRENT?: string;
  /**
   * One-time code (32+ characters) that allows adding the first passkey while none exists (decisions.md D-27).
   * After that it does nothing; remove it if you like.
   */
  SETUP_CODE?: string;
  /** Bearer token (32+ characters) for the GitHub monitor and deploy smoke test (GET /api/health only). */
  OPS_TOKEN?: string;
  /** WebAuthn relying party id; defaults to the request's host name. */
  RP_ID?: string;
  /** Local development only: sign in as this email without a passkey. Refused when PLAID_ENV is production. */
  DEV_AUTH_EMAIL?: string;
  /** Optional: the owner's identity in the membership tables (defaults to "owner"). */
  OWNER_EMAIL?: string;
  /** Local development and tests only: a fixed "now" (ISO time). Ignored in production. */
  FAKE_NOW?: string;
  /** Enables /__dev routes (seed data) in local development. Ignored in production. */
  DEV_ROUTES?: string;
  /** Account-wide D1 usage via GraphQL Analytics (read-only token). */
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  /** Plaid page size: 500 by default, 250 if Phase 1 shows the apply step over budget. */
  SYNC_PAGE_SIZE?: string;
  /** Enables /__measure routes (local go/no-go harness only). */
  MEASURE?: string;
  APP_VERSION?: string;
  /** Inside a budget's Durable Object: today's account usage, from the Directory (docs/multi-user.md 9.2). */
  USAGE?: () => Promise<{ written: number; read: number }>;
}

export interface SyncParams {
  connectionId: string;
  budgetId: string;
  /** Lease holder id; also the Workflow instance id. */
  runId: string;
  handoffFrom?: string;
  handoffDepth?: number;
  trigger: 'webhook' | 'cron' | 'refresh' | 'link' | 'handoff' | 'measure';
}

export interface MaintenanceParams {
  day: string;
  budgetId: string;
}

export interface RecomputeParams {
  budgetId: string;
}
