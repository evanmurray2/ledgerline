import type { Db } from '@ledgerline/db/sql';
export interface Env {
  /**
   * The SQLite database of the Durable Object running this code (store/adapter.ts; the phone's copy in the engine):
   * a budget's own data inside a BudgetStore, users and sessions inside the Directory.
   */
  DB: Db;
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
  /** Set only by the phone's engine, for each request it runs: the time of that request (http/clock.ts). */
  NOW?: number;
  /** Set only by the phone's engine, for each edit it runs: the change number its copy holds (http/through.ts). */
  THROUGH?: number;
  /** Tests only: the longest an edit waits for a bank update, in ms (http/after-update.ts). */
  EDIT_WAIT_MS?: string;
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
  /**
   * The id of the one budget whose cutover is open (seal/cutover-routes.ts); `any` in tests. Unset in production
   * until the owner's budget is to be moved (docs/privacy.md section 8): the routes then answer nothing, but
   * for the way back of a budget that is sealed.
   */
  CUTOVER?: string;
  /** Enables /__dev routes (seed data) in local development. Ignored in production. */
  DEV_ROUTES?: string;
  /** Account-wide usage via GraphQL Analytics (read-only token). */
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  /** Plaid page size: 500 by default, 250 if Phase 1 shows the apply step over budget. */
  SYNC_PAGE_SIZE?: string;
  APP_VERSION?: string;
  /** 'on' lets users who aren't admins link banks: only on a Plaid plan with no lifetime link limit (D-75). */
  OTHER_USERS_BANKS?: string;
  /** Fair use (store/shares.ts): the part of each daily limit other users share, 0–1 (default 0.5), or 'off'. */
  OTHER_USERS_SHARE?: string;
  /** Open sign-up (D-75, docs/open-signup.md 2): 'open' lets anyone make an account; anything else is off. */
  SIGNUPS?: string;
  /** Accounts allowed in all (default 1), and new accounts per UTC day (default 50). */
  MAX_USERS?: string;
  SIGNUPS_PER_DAY?: string;
  /** Cloudflare Turnstile for sign-up and recovery: the public site key and the secret (a Worker secret). */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** Inside the Directory: whether the breaker is at normal (sign-up and recovery need it, D-75). */
  BREAKER_NORMAL?: () => Promise<boolean>;
  /** Inside the Directory: create a new budget's store and run its migrations (sign-up). */
  NEW_STORE?: (budgetId: string) => Promise<void>;
  /** Inside the Directory: a budget's name and its linked banks, from its store (deleting an account). */
  BUDGET_INFO?: (budgetId: string) => Promise<{ name: string; banks: number }>;
  /** Inside the Directory: turn a budget's background work off or on (an account turned off, D-75). */
  SET_DISABLED?: (budgetId: string, disabled: boolean) => Promise<void>;
  /** Inside the Directory: queue deleting an account (routes/people.ts). */
  DELETE_ACCOUNT?: (userId: string, budgetId: string) => Promise<void>;
  /**
   * The account's daily limits for the breaker (docs/open-signup.md 7), as whole numbers. Unset: Cloudflare's Free
   * plan (sync/breaker.ts FREE_LIMITS).
   */
  LIMIT_ROWS_WRITTEN?: string;
  LIMIT_ROWS_READ?: string;
  LIMIT_DO_REQUESTS?: string;
  LIMIT_DO_GBS?: string;
  LIMIT_WORKER_REQUESTS?: string;
  /** Inside a budget's Durable Object: today's account usage, from the Directory (docs/multi-user.md 9.2). */
  USAGE?: () => Promise<{
    written: number;
    read: number;
    do?: { requests: number; gbs: number };
    workers?: number;
    /** This budget's fair-use share (store/shares.ts), when the Directory knows the budget. */
    share?: 'normal' | 'pause' | 'readonly';
  }>;
  /** Inside a budget's Durable Object: USAGE for the check before each write, kept up to 30 seconds. */
  USAGE_FOR_WRITE?: Env['USAGE'];
  /** Inside a budget's Durable Object: add this app's own row counts to the Directory's usage_day. */
  NOTE_USAGE?: (written: number, read: number) => Promise<void>;
  /** Inside a budget's Durable Object: queue registering a new Plaid Item's route in the Directory. */
  ROUTE_LINK?: (providerItemId: string, connectionId: string) => Promise<void>;
  /** Inside a budget's Durable Object: point-in-time recovery of its database (runbooks/restore.md). */
  RESTORE_TO?: (at: number) => Promise<{ undo: string }>;
  /** Inside a budget's Durable Object: undo the last restore, with the bookmark the Directory kept. */
  RESTORE_UNDO?: () => Promise<{ undo: string } | null>;
  /** Inside a budget's Durable Object: the last restore, from the Directory. */
  LAST_RESTORE?: () => Promise<{ at: number; to: number | null } | null>;
}

export interface Jobs {
  /** Runs a sync for a connection whose lease `runId` already holds (routes/settings.ts startSync). */
  sync(runId: string, connectionId: string, trigger: string): Promise<void>;
}
