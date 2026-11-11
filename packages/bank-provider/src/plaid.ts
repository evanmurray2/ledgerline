import {
  type BankDataProvider,
  type CompletedLink,
  type Connection,
  type LinkResult,
  type LinkSession,
  type NormalizedTxn,
  type ProviderAccount,
  type ProviderEvent,
  type ProviderLiability,
  type ProviderWebhookEvent,
  type StagedPage,
  type SyncPage,
  ProviderError,
} from './types.js';

/** Plaid's history window is fixed when an Item is created; the design sets it once (180 days). */
export const PLAID_DAYS_REQUESTED = 180;
export const PLAID_MAX_SYNC_COUNT = 500;

export type PlaidEnv = 'sandbox' | 'production';

export interface PlaidConfig {
  clientId: string;
  secret: string;
  env: PlaidEnv;
  /** Overrides the API origin (tests and the local Plaid-shaped mock). */
  baseUrl?: string;
  webhookUrl?: string;
  /** Registered OAuth redirect URI (needed by OAuth institutions in some browsers). */
  redirectUri?: string;
  clientName?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const ORIGINS: Record<PlaidEnv, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

/** Plaid reports amounts as decimal dollars with outflows positive. Ours are integer cents, outflow negative. */
export function plaidAmountToCents(amount: number): number {
  const cents = -Math.round(amount * 100);
  return cents === 0 ? 0 : cents;
}

/** Balances keep Plaid's sign (cards: amount owed, positive). */
function balanceToCents(amount: number | null | undefined): number | null {
  if (amount === null || amount === undefined) return null;
  const c = Math.round(amount * 100);
  return c === 0 ? 0 : c;
}

interface PlaidTxn {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code?: string | null;
  date: string;
  authorized_date?: string | null;
  pending: boolean;
  pending_transaction_id?: string | null;
  name?: string | null;
  original_description?: string | null;
  merchant_name?: string | null;
  merchant_entity_id?: string | null;
  payment_channel?: string | null;
  personal_finance_category?: { primary?: string; detailed?: string } | null;
}

function isPlaidTxn(v: unknown): v is PlaidTxn {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.transaction_id === 'string' &&
    typeof t.account_id === 'string' &&
    typeof t.amount === 'number' &&
    Number.isFinite(t.amount) &&
    typeof t.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(t.date) &&
    typeof t.pending === 'boolean'
  );
}

export function normalizePlaidTxn(t: PlaidTxn): NormalizedTxn {
  return {
    providerTxnId: t.transaction_id,
    providerAccountId: t.account_id,
    amount: plaidAmountToCents(t.amount),
    date: t.date,
    authorizedDate: t.authorized_date ?? null,
    pending: t.pending,
    pendingProviderTxnId: t.pending_transaction_id ?? null,
    rawName: t.original_description ?? t.name ?? '',
    plaidName: t.name ?? null,
    merchantName: t.merchant_name ?? null,
    merchantEntityId: t.merchant_entity_id ?? null,
    providerCategory: t.personal_finance_category?.detailed ?? null,
    paymentChannel: t.payment_channel ?? null,
    isoCurrency: t.iso_currency_code ?? null,
  };
}

/**
 * Pulls next_cursor and has_more out of a /transactions/sync body without parsing it, so the fetch step stays
 * cheap. Top-level keys follow the transaction arrays, so the last match is the top-level one; key names inside
 * string values are escaped and cannot match.
 */
/** Same, from the raw bytes: decodes only the last 4 KB unless the fields are not there. */
export function scanSyncTailBytes(bytes: Uint8Array): { nextCursor: string; hasMore: boolean } {
  const dec = new TextDecoder();
  if (bytes.length > 4096) {
    try {
      return scanSyncTail(dec.decode(bytes.subarray(bytes.length - 4096)), false);
    } catch {
      /* fall through to the whole body */
    }
  }
  return scanSyncTail(dec.decode(bytes));
}

export function scanSyncTail(body: string, fullFallback = true): { nextCursor: string; hasMore: boolean } {
  const tail = body.length > 4096 ? body.slice(body.length - 4096) : body;
  const CUR = /"next_cursor"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  const MORE = /"has_more"\s*:\s*(true|false)/g;
  const cur = lastMatch(tail, CUR) ?? (fullFallback ? lastMatch(body, new RegExp(CUR)) : null);
  const more = lastMatch(tail, MORE) ?? (fullFallback ? lastMatch(body, new RegExp(MORE)) : null);
  if (cur === null || more === null)
    throw new ProviderError('BAD_PAGE', 'sync page is missing next_cursor or has_more', true);
  return { nextCursor: JSON.parse(`"${cur}"`) as string, hasMore: more === 'true' };
}

function lastMatch(s: string, re: RegExp): string | null {
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(s)) !== null) last = m[1] ?? null;
  return last;
}

export function parsePlaidSyncPage(body: string): SyncPage {
  const j = JSON.parse(body) as Record<string, unknown>;
  const events: ProviderEvent[] = [];
  const take = (kind: 'added' | 'modified', list: unknown) => {
    if (!Array.isArray(list)) throw new ProviderError('BAD_PAGE', `${kind} is not a list`, true);
    for (let i = 0; i < list.length; i++) {
      const t: unknown = list[i];
      if (!isPlaidTxn(t)) throw new ProviderError('BAD_PAGE', `malformed ${kind} transaction`, true);
      const n = normalizePlaidTxn(t);
      events.push({
        kind,
        providerTxnId: n.providerTxnId,
        providerAccountId: n.providerAccountId,
        payload: n,
        rawPath: `${kind}/${i}`,
      });
    }
  };
  take('added', j.added);
  take('modified', j.modified);
  if (!Array.isArray(j.removed)) throw new ProviderError('BAD_PAGE', 'removed is not a list', true);
  const removed = j.removed as unknown[];
  for (let i = 0; i < removed.length; i++) {
    const o = removed[i] as Record<string, unknown>;
    if (typeof o?.transaction_id !== 'string')
      throw new ProviderError('BAD_PAGE', 'malformed removed row', true);
    const acct = typeof o.account_id === 'string' ? o.account_id : null;
    events.push({
      kind: 'removed',
      providerTxnId: o.transaction_id,
      providerAccountId: acct,
      payload: { providerTxnId: o.transaction_id, providerAccountId: acct },
      rawPath: `removed/${i}`,
    });
  }
  if (typeof j.next_cursor !== 'string' || typeof j.has_more !== 'boolean') {
    throw new ProviderError('BAD_PAGE', 'missing next_cursor or has_more', true);
  }
  return { events, nextCursor: j.next_cursor, hasMore: j.has_more };
}

/**
 * Plaid's webhook signing keys by key id, shared by every provider in the isolate: the Worker and the budget's store
 * each build a provider per webhook, and a per-instance cache would ask Plaid for the key every time.
 */
const WEBHOOK_KEYS = new Map<
  string,
  { jwk: JsonWebKey | null; expiredAt: number | null; fetchedAt: number }
>();
const KEY_TTL_MS = 24 * 3_600_000;
const MISSING_KEY_TTL_MS = 10 * 60_000;
const MAX_CACHED_KEYS = 50;

/** Tests only: forget cached webhook keys. */
export function resetWebhookKeyCache(): void {
  WEBHOOK_KEYS.clear();
}

export class PlaidProvider implements BankDataProvider {
  readonly id = 'plaid' as const;
  private readonly origin: string;
  private readonly f: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly cfg: PlaidConfig) {
    this.origin = cfg.baseUrl ?? ORIGINS[cfg.env];
    this.f = cfg.fetch ?? ((...a) => fetch(...a));
    this.now = cfg.now ?? (() => Date.now());
  }

  private async call(path: string, body: Record<string, unknown>): Promise<Response> {
    return this.f(`${this.origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.cfg.clientId, secret: this.cfg.secret, ...body }),
    });
  }

  private async json<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.call(path, body);
    const text = await res.text();
    if (!res.ok) throw plaidError(res.status, text);
    return JSON.parse(text) as T;
  }

  /** Every Link session asks for the same history window; a test asserts this. */
  linkTokenRequest(opts: {
    mode: 'new' | 'repair';
    accessToken?: string;
    userId: string;
    hosted?: { completionUrl: string };
  }): Record<string, unknown> {
    const req: Record<string, unknown> = {
      user: { client_user_id: opts.userId },
      client_name: this.cfg.clientName ?? 'Ledgerline',
      country_codes: ['US'],
      language: 'en',
      transactions: { days_requested: PLAID_DAYS_REQUESTED },
    };
    if (this.cfg.webhookUrl) req.webhook = this.cfg.webhookUrl;
    if (this.cfg.redirectUri) req.redirect_uri = this.cfg.redirectUri;
    if (opts.hosted) req.hosted_link = { completion_redirect_uri: opts.hosted.completionUrl };
    if (opts.mode === 'repair') {
      if (!opts.accessToken)
        throw new ProviderError('REPAIR_NEEDS_TOKEN', 'update mode needs the existing Item', false);
      req.access_token = opts.accessToken; // update mode reuses the Item instead of creating a new one
    } else {
      req.products = ['transactions'];
      req.optional_products = ['liabilities'];
    }
    return req;
  }

  async createLinkSession(opts: {
    mode: 'new' | 'repair';
    accessToken?: string;
    userId: string;
    hosted?: { completionUrl: string };
  }): Promise<LinkSession> {
    const r = await this.json<{ link_token: string; expiration: string; hosted_link_url?: string }>(
      '/link/token/create',
      this.linkTokenRequest(opts),
    );
    if (opts.hosted && !r.hosted_link_url)
      throw new ProviderError('NO_HOSTED_LINK', 'the provider gave no hosted Link page', false);
    return {
      linkToken: r.link_token,
      expiration: r.expiration,
      ...(r.hosted_link_url ? { hostedUrl: r.hosted_link_url } : {}),
    };
  }

  /**
   * The newest session of a link token (`/link/token/get`). A session with no `finished_at` is still open; one that
   * finished with an `exit` and linked nothing was left by the person.
   */
  async linkResult(linkToken: string): Promise<LinkResult> {
    const r = await this.json<{
      link_sessions?: {
        started_at?: string;
        finished_at?: string | null;
        exit?: unknown;
        results?: { item_add_results?: { public_token?: string }[] | null } | null;
      }[];
    }>('/link/token/get', { link_token: linkToken });
    const sessions = [...(r.link_sessions ?? [])].sort((a, b) =>
      (a.started_at ?? '').localeCompare(b.started_at ?? ''),
    );
    // A finished session with a linked bank wins over a later one the person only opened and left.
    const publicTokens = sessions.flatMap((s) =>
      s.finished_at
        ? (s.results?.item_add_results ?? []).flatMap((i) => (i.public_token ? [i.public_token] : []))
        : [],
    );
    if (publicTokens.length > 0) return { state: 'finished', publicTokens };
    const last = sessions.at(-1);
    if (!last?.finished_at) return { state: 'waiting', publicTokens: [] };
    return { state: last.exit ? 'exited' : 'finished', publicTokens: [] };
  }

  async completeLink(publicToken: string): Promise<CompletedLink> {
    const r = await this.json<{ access_token: string; item_id: string }>('/item/public_token/exchange', {
      public_token: publicToken,
    });
    const item = await this.json<{ item: { institution_id?: string | null }; status?: unknown }>(
      '/item/get',
      {
        access_token: r.access_token,
      },
    );
    const instId = item.item.institution_id ?? null;
    let instName: string | null = null;
    if (instId) {
      try {
        const inst = await this.json<{ institution: { name: string } }>('/institutions/get_by_id', {
          institution_id: instId,
          country_codes: ['US'],
        });
        instName = inst.institution.name;
      } catch {
        instName = null;
      }
    }
    return {
      accessToken: r.access_token,
      providerItemId: r.item_id,
      institutionId: instId,
      institutionName: instName,
    };
  }

  async fetchSyncPage(conn: Connection, cursor: string | null, count: number): Promise<StagedPage> {
    const body: Record<string, unknown> = {
      access_token: conn.accessToken,
      count,
      options: { include_original_description: true, days_requested: PLAID_DAYS_REQUESTED },
    };
    if (cursor) body.cursor = cursor;
    const res = await this.call('/transactions/sync', body);
    if (!res.ok) throw plaidError(res.status, await res.text());
    // Kept as bytes: the fetch step reads only the tail, then decodes once to store the text (D-26).
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { nextCursor, hasMore } = scanSyncTailBytes(bytes);
    return { body: bytes, nextCursor, hasMore };
  }

  parsePage(body: string): SyncPage {
    return parsePlaidSyncPage(body);
  }

  async getAccounts(conn: Connection): Promise<ProviderAccount[]> {
    const r = await this.json<{ accounts: PlaidAccount[] }>('/accounts/get', {
      access_token: conn.accessToken,
    });
    return r.accounts.map(normalizePlaidAccount);
  }

  async getLiabilities(conn: Connection): Promise<ProviderLiability[]> {
    const r = await this.json<{ liabilities: { credit?: PlaidCredit[] | null } }>('/liabilities/get', {
      access_token: conn.accessToken,
    });
    return (r.liabilities.credit ?? []).map((c) => ({
      providerAccountId: c.account_id,
      statementBalance: balanceToCents(c.last_statement_balance),
      statementDate: c.last_statement_issue_date ?? null,
      dueDate: c.next_payment_due_date ?? null,
      minimumPayment: balanceToCents(c.minimum_payment_amount),
      aprBasisPoints:
        c.aprs && c.aprs[0] && typeof c.aprs[0].apr_percentage === 'number'
          ? Math.round(c.aprs[0].apr_percentage * 100)
          : null,
    }));
  }

  /** Sandbox only: creates a test Item without Link. */
  async sandboxCreateItem(institutionId = 'ins_109508', overrideUsername?: string): Promise<CompletedLink> {
    if (this.cfg.env !== 'sandbox') throw new ProviderError('NOT_SANDBOX', 'sandbox only', false);
    const opts: Record<string, unknown> = {
      webhook: this.cfg.webhookUrl,
      transactions: { days_requested: PLAID_DAYS_REQUESTED },
    };
    if (overrideUsername) opts.override_username = overrideUsername;
    const pt = await this.json<{ public_token: string }>('/sandbox/public_token/create', {
      institution_id: institutionId,
      initial_products: ['transactions'],
      options: opts,
    });
    return this.completeLink(pt.public_token);
  }

  async verifyWebhook(req: Request): Promise<ProviderWebhookEvent | null> {
    const jwt = req.headers.get('plaid-verification');
    if (!jwt) return null;
    const raw = await req.text();
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: { iat?: number; request_body_sha256?: string };
    try {
      header = JSON.parse(b64urlDecodeText(h)) as typeof header;
      claims = JSON.parse(b64urlDecodeText(p)) as typeof claims;
    } catch {
      return null;
    }
    if (header.alg !== 'ES256' || !header.kid) return null;
    const key = await this.webhookKey(header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64urlDecode(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return null;
    if (typeof claims.iat !== 'number' || this.now() / 1000 - claims.iat > 5 * 60) return null;
    const digest = await sha256Hex(raw);
    if (!claims.request_body_sha256 || !timingSafeEqual(digest, claims.request_body_sha256)) return null;
    let body: { webhook_type?: string; webhook_code?: string; item_id?: string };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return null;
    }
    return classifyWebhook(body);
  }

  private async webhookKey(kid: string): Promise<CryptoKey | null> {
    const cacheKey = `${this.cfg.env}|${this.cfg.baseUrl ?? ''}|${kid}`;
    const now = this.now();
    let entry = WEBHOOK_KEYS.get(cacheKey);
    if (entry && now - entry.fetchedAt > (entry.jwk ? KEY_TTL_MS : MISSING_KEY_TTL_MS)) entry = undefined;
    if (!entry) {
      try {
        const r = await this.json<{ key: JsonWebKey & { expired_at?: number | null } }>(
          '/webhook_verification_key/get',
          {
            key_id: kid,
          },
        );
        entry = { jwk: r.key, expiredAt: r.key.expired_at ?? null, fetchedAt: now };
      } catch (e) {
        // A key id Plaid doesn't know (a forged webhook) is remembered briefly, so repeats don't call Plaid.
        // Other failures (Plaid down) aren't, and the webhook is retried by Plaid.
        if (!(e instanceof ProviderError) || e.retryable) return null;
        entry = { jwk: null, expiredAt: null, fetchedAt: now };
      }
      if (WEBHOOK_KEYS.size >= MAX_CACHED_KEYS) WEBHOOK_KEYS.clear();
      WEBHOOK_KEYS.set(cacheKey, entry);
    }
    if (!entry.jwk) return null;
    if (entry.expiredAt !== null && entry.expiredAt * 1000 < now) return null;
    const { kty, crv, x, y } = entry.jwk;
    return crypto.subtle.importKey('jwk', { kty, crv, x, y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'verify',
    ]);
  }
}

export function classifyWebhook(body: {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
}): ProviderWebhookEvent {
  const code = `${body.webhook_type ?? ''}:${body.webhook_code ?? ''}`;
  const itemId = body.item_id ?? null;
  if (code === 'TRANSACTIONS:SYNC_UPDATES_AVAILABLE')
    return { type: 'sync_updates_available', providerItemId: itemId, code };
  if (code === 'ITEM:ERROR') return { type: 'item_error', providerItemId: itemId, code };
  if (code === 'ITEM:LOGIN_REPAIRED') return { type: 'login_repaired', providerItemId: itemId, code };
  if (code === 'ITEM:PENDING_EXPIRATION' || code === 'ITEM:PENDING_DISCONNECT')
    return { type: 'pending_expiration', providerItemId: itemId, code };
  return { type: 'other', providerItemId: itemId, code };
}

interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  type: string;
  subtype?: string | null;
  mask?: string | null;
  balances: {
    current?: number | null;
    available?: number | null;
    limit?: number | null;
    iso_currency_code?: string | null;
  };
}

interface PlaidCredit {
  account_id: string;
  last_statement_balance?: number | null;
  last_statement_issue_date?: string | null;
  next_payment_due_date?: string | null;
  minimum_payment_amount?: number | null;
  aprs?: { apr_percentage?: number }[] | null;
}

export function normalizePlaidAccount(a: PlaidAccount): ProviderAccount {
  return {
    providerAccountId: a.account_id,
    name: a.name,
    officialName: a.official_name ?? null,
    type: a.type,
    subtype: a.subtype ?? null,
    mask: a.mask ?? null,
    currentBalance: balanceToCents(a.balances.current),
    availableBalance: balanceToCents(a.balances.available),
    creditLimit: balanceToCents(a.balances.limit),
    isoCurrency: a.balances.iso_currency_code ?? null,
  };
}

function plaidError(status: number, text: string): ProviderError {
  let code = `HTTP_${status}`;
  let message = 'Plaid request failed';
  try {
    const j = JSON.parse(text) as { error_code?: string; error_message?: string };
    if (j.error_code) code = j.error_code;
    if (j.error_message) message = j.error_message;
  } catch {
    /* non-JSON error body */
  }
  const retryable =
    status >= 500 || status === 429 || code === 'RATE_LIMIT_EXCEEDED' || code === 'INTERNAL_SERVER_ERROR';
  return new ProviderError(code, message, retryable);
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlDecodeText(s: string): string {
  return new TextDecoder().decode(b64urlDecode(s));
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', ENC.encode(s));
  return hex(new Uint8Array(d));
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function hex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += HEX[b[i] as number];
  return out;
}

const ENC = new TextEncoder();

export async function sha256HexBytes(bytes: BufferSource): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
