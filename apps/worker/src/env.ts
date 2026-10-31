export interface Env {
  DB: D1Database;
  /** Raw provider pages (staging and permanent archive). */
  RAW: R2Bucket;
  /** Nightly backups land here from GitHub Actions; the Worker only reads manifests for the watchdog. */
  BACKUPS?: R2Bucket;
  SYNC: Workflow<SyncParams>;
  MAINTENANCE: Workflow<MaintenanceParams>;
  ASSETS?: Fetcher;
  /** 'sandbox' | 'production'. Production keys exist only in the production Worker. */
  PLAID_ENV: string;
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  /** Local Plaid-shaped mock (development and tests only). */
  PLAID_BASE_URL?: string;
  PLAID_WEBHOOK_URL?: string;
  /** "1:base64key,2:base64key" and the current version. */
  TOKEN_KEYS?: string;
  TOKEN_KEY_CURRENT?: string;
  /** Cloudflare Access: team domain (https://<team>.cloudflareaccess.com) and application audience tag. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Local development only: trust this email instead of an Access JWT. Refused when PLAID_ENV is production. */
  DEV_AUTH_EMAIL?: string;
  /** Account-wide D1 usage via GraphQL Analytics (read-only token). */
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  /** Plaid page size: 500 by default, 250 if Phase 1 shows the apply step over budget. */
  SYNC_PAGE_SIZE?: string;
  /** Enables /__measure routes (local go/no-go harness only). */
  MEASURE?: string;
  APP_VERSION?: string;
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
}
