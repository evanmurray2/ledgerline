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
  /** The bank's own text (Plaid's original_description, else its name). */
  rawName: string;
  /** Plaid's short `name`, as sent (docs/payee-names.md 3). */
  plaidName: string | null;
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
  /** The page on the provider's own site where the person links the bank, when one was asked for. */
  hostedUrl?: string;
}

/**
 * Where a hosted Link session stands. `publicTokens` holds one token for each bank the person linked; a repair
 * (update mode) finishes with none.
 */
export interface LinkResult {
  state: 'waiting' | 'exited' | 'finished';
  publicTokens: string[];
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
    /** Link on the provider's own site, with no provider script in the app. The person comes back to this address. */
    hosted?: { completionUrl: string };
  }): Promise<LinkSession>;
  /** What a hosted Link session came to. The app finishes a link by asking, not by trusting where the browser lands. */
  linkResult(linkToken: string): Promise<LinkResult>;
  completeLink(publicToken: string): Promise<CompletedLink>;
  /** Removes the Item at the provider (`/item/remove`): the link ends there, and its token stops working. One already
   * gone is not an error. */
  removeItem(accessToken: string): Promise<void>;
  /** One raw page; the apply step parses it later with parsePage(). */
  fetchSyncPage(conn: Connection, cursor: string | null, count: number): Promise<StagedPage>;
  parsePage(body: string): SyncPage;
  getAccounts(conn: Connection): Promise<ProviderAccount[]>;
  getHoldings?(conn: Connection): Promise<ProviderHolding[]>;
  getLiabilities?(conn: Connection): Promise<ProviderLiability[]>;
  /** The bank an Item is at; its name is null when the provider can't say it. */
  getInstitution?(conn: Connection): Promise<{ id: string | null; name: string | null }>;
  verifyWebhook(req: Request): Promise<ProviderWebhookEvent | null>;
}
