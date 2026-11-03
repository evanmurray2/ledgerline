export interface Env {
  /**
   * The SQLite database of the Durable Object running this code, behind a D1-shaped adapter (store/adapter.ts): a
   * budget's own data inside a BudgetStore, users and sessions inside the Directory. Production has no D1.
   */
  DB: D1Database;
  /** Sign-in attempts per IP (docs/multi-user.md 7.2). */
  AUTH_LIMITER?: RateLimit;
  /** docs/multi-user.md: the Directory (one object) and one BudgetStore per budget. */
  DIRECTORY: DurableObjectNamespace<import('./store/directory.js').Directory>;
  BUDGET: DurableObjectNamespace<import('./store/budget-store.js').BudgetStore>;
  /** Inside a budget's Durable Object: queue background work as alarm-driven jobs (docs/multi-user.md 6.1). */
  JOBS?: Jobs;
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
  APP_VERSION?: string;
  /** Inside a budget's Durable Object: today's account usage, from the Directory (docs/multi-user.md 9.2). */
  USAGE?: () => Promise<{
    written: number;
    read: number;
    do?: { requests: number; gbs: number };
    workers?: number;
  }>;
  /** Inside a budget's Durable Object: add this app's own row counts to the Directory's usage_day. */
  NOTE_USAGE?: (written: number, read: number) => Promise<void>;
  /** Inside a budget's Durable Object: queue registering a new Plaid Item's route in the Directory. */
  ROUTE_LINK?: (providerItemId: string, connectionId: string) => Promise<void>;
  /** Inside a budget's Durable Object: point-in-time recovery of its database (runbooks/restore.md). */
  RESTORE_TO?: (at: number) => Promise<{ undo: string }>;
}

export interface Jobs {
  /** Runs a sync for a connection whose lease `runId` already holds (routes/settings.ts startSync). */
  sync(runId: string, connectionId: string, trigger: string): Promise<void>;
}
