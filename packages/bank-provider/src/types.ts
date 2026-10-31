/** Normalized bank data. Nothing outside an adapter sees provider field names. */

export type ProviderId = 'plaid' | 'csv' | 'fake';

/** Amounts are signed integer cents with outflow negative. */
export interface NormalizedTxn {
  providerTxnId: string;
  providerAccountId: string;
  amount: number;
  date: string;
  authorizedDate: string | null;
  pending: boolean;
  pendingProviderTxnId: string | null;
  rawName: string;
  merchantName: string | null;
  merchantEntityId: string | null;
  providerCategory: string | null;
  paymentChannel: string | null;
  isoCurrency: string | null;
}

export interface RemovedTxn {
  providerTxnId: string;
  providerAccountId: string | null;
}

/** One event as stored in bank_event: normalized payload plus the provider's raw JSON. */
export interface ProviderEvent {
  kind: 'added' | 'modified' | 'removed';
  providerTxnId: string;
  providerAccountId: string | null;
  payload: NormalizedTxn | RemovedTxn;
  /** Where the record sits in the raw page: 'added/12', 'modified/0', 'removed/3'. */
  rawPath: string;
}

export interface SyncPage {
  events: ProviderEvent[];
  nextCursor: string;
  hasMore: boolean;
}

/** What the fetch step stages: the body bytes exactly as received plus the two fields it needs to continue. */
export interface StagedPage {
  body: Uint8Array;
  nextCursor: string;
  hasMore: boolean;
}

export interface ProviderAccount {
  providerAccountId: string;
  name: string;
  officialName: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  /** Cards and loans: amount owed (positive). Depository: balance. Cents. */
  currentBalance: number | null;
  availableBalance: number | null;
  creditLimit: number | null;
  isoCurrency: string | null;
}

export interface ProviderLiability {
  providerAccountId: string;
  statementBalance: number | null;
  statementDate: string | null;
  dueDate: string | null;
  minimumPayment: number | null;
  aprBasisPoints: number | null;
}

export interface ProviderHolding {
  providerAccountId: string;
  securityName: string;
  quantity: string;
  value: number | null;
}

export interface Connection {
  id: string;
  /** Decrypted only inside the sync Workflow. */
  accessToken: string;
  providerItemId: string | null;
}

export interface LinkSession {
  linkToken: string;
  expiration: string;
}

export interface CompletedLink {
  accessToken: string;
  providerItemId: string;
  institutionId: string | null;
  institutionName: string | null;
}

export interface ProviderWebhookEvent {
  type: 'sync_updates_available' | 'item_error' | 'login_repaired' | 'pending_expiration' | 'other';
  providerItemId: string | null;
  code: string;
}

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const MUTATION_DURING_PAGINATION = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';

export interface BankDataProvider {
  readonly id: ProviderId;
  createLinkSession(opts: {
    mode: 'new' | 'repair';
    accessToken?: string;
    userId: string;
  }): Promise<LinkSession>;
  completeLink(publicToken: string): Promise<CompletedLink>;
  /** One raw page; the apply step parses it later with parsePage(). */
  fetchSyncPage(conn: Connection, cursor: string | null, count: number): Promise<StagedPage>;
  parsePage(body: string): SyncPage;
  getAccounts(conn: Connection): Promise<ProviderAccount[]>;
  getHoldings?(conn: Connection): Promise<ProviderHolding[]>;
  getLiabilities?(conn: Connection): Promise<ProviderLiability[]>;
  verifyWebhook(req: Request): Promise<ProviderWebhookEvent | null>;
}
