// The mock API (VITE_MOCK=1, dev and tests only). Every screen and every change is answered by the phone's real
// engine over a November 2026 copy (apps/worker/src/local/november-copy.ts), so the mock runs the server's own
// routes and Money rules. Only what needs a real server is answered here: passkey sign-in, Plaid Link, the
// sign-in list, usage events and notes, and the daily-limit scenarios.
import { CSRF_HEADER, LinkExchange, LinkTokenRequest, NoteRequest, UsageBatch } from '@ledgerline/contracts';
import type { z } from 'zod';

type LocalEngine = MockCopy['engine'];
type SqlJsDb = MockCopy['db'];

export type Scenario =
  'default' | 'firstrun' | 'empty' | 'readonly' | 'resting' | 'syncfail' | 'newmonth' | 'samepurchase';

export interface MockResponse {
  status: number;
  body: unknown;
}

/** Opens a November copy; the browser passes one that knows where sql.js's wasm is. */
export type OpenCopy = (now: () => number) => Promise<MockCopy>;

class MockHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success)
    throw new MockHttpError(400, 'bad_request', r.error.issues[0]?.message ?? 'Invalid request');
  return r.data;
}

/** The mock's clock: Nov 14, 2026 at 10 AM Pacific; Dec 1 for a new month, Oct 1 for an empty budget. */
export function scenarioNow(scenario: Scenario): number {
  if (scenario === 'newmonth') return Date.UTC(2026, 11, 1, 18, 0);
  if (scenario === 'empty') return Date.UTC(2026, 9, 1, 18, 0);
  return Date.UTC(2026, 10, 14, 18, 0);
}

/** Categories an empty budget keeps (the prototype's empty state). */
const EMPTY_KEEPS = ['rent', 'electric', 'internet', 'groceries', 'dining', 'gas'];

/** Turns the November copy into a scenario's starting state, through the same tables the server keeps. */
async function shape(db: SqlJsDb, scenario: Scenario, now: number): Promise<boolean> {
  const run = (sql: string) => db.prepare(sql).run();
  if (scenario === 'samepurchase') {
    await samePurchase(db, now);
    return true;
  }
  if (scenario === 'syncfail') {
    await run(
      `UPDATE connection SET status = 'error', last_attempt_at = ${now - 3_600_000} WHERE id = 'con_chase'`,
    );
    return false;
  }
  if (scenario === 'empty' || scenario === 'firstrun') {
    for (const t of [
      'txn_link',
      'expected_reimbursement',
      'txn_split',
      'manual_pending',
      'txn_overlay',
      'bank_txn',
      'assignment',
      'target',
      'alert',
    ])
      await run(`DELETE FROM ${t}`);
    if (scenario === 'empty') {
      const keep = EMPTY_KEEPS.map((c) => `'${c}'`).join(', ');
      await run(`DELETE FROM category WHERE kind != 'cc_payment' AND id NOT IN (${keep})`);
      await run(
        `DELETE FROM category_group WHERE id NOT IN (SELECT group_id FROM category WHERE group_id IS NOT NULL)`,
      );
    } else {
      for (const t of [
        'category',
        'category_group',
        'liability_snapshot',
        'account',
        'provider_account',
        'connection',
      ])
        await run(`DELETE FROM ${t}`);
      await run(`UPDATE budget SET budget_start_month = NULL`);
    }
    return true;
  }
  return false;
}

/**
 * What the mock tests use that the November fixture doesn't have, with no change to any amount, category or date:
 * payee history (Blue Bottle Coffee twice Dining out, Amazon twice Household and once Shopping, so both come suggested), a second
 * "Amazon" payee offered as "Same as your Amazon?", a "Bluebottle Coffee" spelling to join, a bank text on CVS,
 * and a row from before the budget on checking.
 */
async function mockHistory(db: SqlJsDb, now: number): Promise<void> {
  const run = (sql: string, ...args: unknown[]) =>
    db
      .prepare(sql)
      .bind(...args)
      .run();
  const payeeOf = async (key: string) =>
    (await db
      .prepare(`SELECT payee_id FROM txn_overlay WHERE txn_key = ?1`)
      .bind(key)
      .first<{ payee_id: string }>())!.payee_id;
  const point = async (keys: string[], payeeId: string, raw: string) => {
    for (const k of keys) {
      await run(`UPDATE txn_overlay SET payee_id = ?2 WHERE txn_key = ?1`, k, payeeId);
      await run(`UPDATE bank_txn SET raw_name = ?2 WHERE txn_key = ?1`, k, raw);
    }
  };
  const newPayee = async (id: string, name: string) =>
    run(
      `INSERT INTO payee (id, budget_id, name, created_at, updated_at) SELECT ?1, id, ?2, ?3, ?3 FROM budget`,
      id,
      name,
      now,
    );
  await point(['o-dining', 'n-dining'], await payeeOf('n-bluebottle'), 'BLUE BOTTLE COFFEE');
  await point(['o-target', 'n-target', 'o-household'], await payeeOf('n-amazon-s'), 'AMAZON.COM');
  await newPayee('py_amazon_mktp', 'Amazon');
  await point(['n-amazon-f'], 'py_amazon_mktp', 'AMZN MKTP US*2K4');
  await newPayee('py_bluebottle_sf', 'Bluebottle Coffee');
  await point(['o-personal'], 'py_bluebottle_sf', 'BLUEBOTTLECOFFEE SF');
  await run(`UPDATE bank_txn SET raw_name = 'CVS/PHARMACY #0812' WHERE txn_key = 'n-cvs'`);
  // A history row, stored as CSV history import stored one (budgets may still hold such rows).
  await run(
    `INSERT INTO bank_txn (provider_txn_id, budget_id, connection_id, provider_account_id, amount, date, pending, raw_name, txn_key, first_apply_seq, last_apply_seq, created_at, updated_at)
     SELECT 'csv_checking_2026-09-28_0', a.budget_id, pa.connection_id, a.provider_account_id, -1234, '2026-09-28', 0,
       'OLD BAKERY SF', 'p:csv_checking_2026-09-28_0', 0, 0, ?1, ?1
     FROM account a JOIN provider_account pa ON pa.provider_account_id = a.provider_account_id WHERE a.id = 'checking'`,
    now,
  );
  await newPayee('py_old_bakery', 'Old Bakery');
  await run(
    `INSERT INTO txn_overlay (txn_key, budget_id, payee_id, created_at, updated_at)
     SELECT 'p:csv_checking_2026-09-28_0', id, 'py_old_bakery', ?1, ?1 FROM budget`,
    now,
  );
}

/**
 * "Same purchase?" (docs/payee-names.md 9.1, 9.2) on the Sapphire card: your entry "Dinner at Nopa" and the bank's
 * pending "SQ *NOPA SF" at a different amount, asked about; your entry "Tacos" covering the bank's pending
 * "TACOS EL PASTOR", and a posted "PHO 24 SAN FRANCISCO" paired with the bank's pending "PHO 24", for Not the same.
 */
async function samePurchase(db: SqlJsDb, now: number): Promise<void> {
  const run = (sql: string, ...args: unknown[]) =>
    db
      .prepare(sql)
      .bind(...args)
      .run();
  const entry = (key: string, date: string, amount: number, name: string, covers: string | null) =>
    run(
      `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, covers_provider_txn_id, created_at, updated_at)
       SELECT ?1, id, ?1, 'sapphire', 'pending', ?2, ?3, ?4, ?5, ?6, ?6 FROM budget`,
      key,
      date,
      amount,
      name,
      covers,
      now,
    );
  const bank = (id: string, date: string, amount: number, raw: string, pairedTo?: string) =>
    run(
      `INSERT INTO bank_txn (provider_txn_id, budget_id, connection_id, provider_account_id, amount, date, authorized_date, pending, raw_name, plaid_name, payment_channel, txn_key, first_apply_seq, last_apply_seq, created_at, updated_at)
       SELECT ?1, budget_id, connection_id, provider_account_id, ?2, ?3, ?3, ?6, ?4, ?4, 'in store', coalesce(?7, 'p:' || ?1), 0, 0, ?5, ?5
       FROM bank_txn WHERE provider_account_id = 'pa_sapphire' LIMIT 1`,
      id,
      amount,
      date,
      raw,
      now,
      pairedTo ? 0 : 1,
      pairedTo ?? null,
    );
  await entry('m:sp-dinner', '2026-11-13', -4200, 'Dinner at Nopa', null);
  await bank('sp-nopa', '2026-11-14', -4650, 'SQ *NOPA SF');
  await run(
    `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at) SELECT 'al-sp', id, 'same_purchase', 'p:sp-nopa', ?1, ?2 FROM budget`,
    JSON.stringify({ candidates: ['m:sp-dinner'] }),
    now,
  );
  await bank('sp-tacos', '2026-11-12', -1250, 'TACOS EL PASTOR');
  await entry('m:sp-tacos', '2026-11-12', -1250, 'Tacos', 'sp-tacos');
  // A posted "PHO 24 SAN FRANCISCO" (with a tip) that the app paired with the bank's pending "PHO 24" (D-65).
  await bank('sp-pho-p', '2026-11-11', -1800, 'PHO 24');
  await bank('sp-pho', '2026-11-12', -2100, 'PHO 24 SAN FRANCISCO', 'p:sp-pho-p');
  await run(
    `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, created_by, created_at)
     SELECT 'lk-sp-pho', id, 'pending_match', 'p:sp-pho', 'p:sp-pho-p', 'auto', ?1 FROM budget`,
    now,
  );
}

/** Settings → Sign-in in the mock: this phone and a laptop, and an iPad that's signed out with the budget saved. */
const SIGN_INS = () => [
  {
    id: 'si_phone',
    name: 'iPhone · Home Screen app',
    signedInAt: '2026-11-14T08:00:00Z',
    current: true,
    live: true,
  },
  { id: 'si_mac', name: 'Mac · Safari', signedInAt: '2026-11-13T21:30:00Z', current: false, live: true },
  {
    id: 'si_ipad',
    name: 'iPad',
    signedInAt: '2026-11-12T19:00:00Z',
    current: false,
    saved: true,
    live: false,
  },
];

export class MockServer {
  /** Every mutation request's headers, for tests that check the CSRF header. */
  lastMutationHeaders: Record<string, string> | null = null;
  usageEvents: unknown[] = [];
  notes: unknown[] = [];
  private signIns = SIGN_INS();
  private passkeys = [
    { id: 'pk_mock', name: 'iPhone', createdAt: '2026-10-31T18:00:00Z', lastUsedAt: '2026-11-14T08:00:00Z' },
  ];
  private ready: Promise<{ engine: LocalEngine; db: SqlJsDb }>;
  readonly now: number;

  constructor(
    readonly scenario: Scenario,
    private readonly open: OpenCopy,
  ) {
    this.now = scenarioNow(scenario);
    this.ready = this.start();
  }

  private async start() {
    const copy = await this.open(() => this.now);
    if (this.scenario !== 'empty' && this.scenario !== 'firstrun') await mockHistory(copy.db, this.now);
    if (await shape(copy.db, this.scenario, this.now)) {
      await copy.db
        .prepare(`UPDATE local_state SET value = ?1 WHERE key = 'derive'`)
        .bind(JSON.stringify({ full: true, keys: [], fromMonth: null }))
        .run();
      await copy.engine.derive();
    }
    return copy;
  }

  /** The copy, for tests that look at what a change stored. */
  async db(): Promise<SqlJsDb> {
    return (await this.ready).db;
  }

  private get readOnly() {
    return this.scenario === 'readonly' || this.scenario === 'resting';
  }

  async handle(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<MockResponse> {
    try {
      const u = new URL(url, 'http://mock.local');
      const path = u.pathname.replace(/\/+$/, '');
      const mutation = method !== 'GET' && method !== 'HEAD';
      if (this.scenario === 'resting' && !/^\/api\/(session|auth)(\/|$)/.test(path))
        throw new MockHttpError(503, 'resting', 'Resting until the daily limit resets');
      if (mutation) {
        this.lastMutationHeaders = headers;
        if (headers[CSRF_HEADER] !== '1' || !(headers['content-type'] ?? '').startsWith('application/json'))
          throw new MockHttpError(403, 'csrf', 'Missing CSRF header');
        if (this.readOnly && !/^\/api\/(usage|notes)$/.test(path))
          throw new MockHttpError(503, 'read_only', 'Writes are paused until the daily limit resets');
      }
      const own = this.stub(method, path, body ?? {});
      if (own !== undefined) {
        if (method === 'POST' && path === '/api/settings/connections/exchange') await this.linked();
        return { status: own === null ? 204 : 200, body: own };
      }
      const { engine } = await this.ready;
      const r = await engine.request(method, `${path}${u.search}`, mutation ? (body ?? {}) : undefined);
      if (r.status === 200 && method === 'POST') await this.synced(path);
      const text = await r.text();
      let json: unknown = text ? (JSON.parse(text) as unknown) : null;
      if (path === '/api/session' && r.status === 200) json = this.session(json as Record<string, unknown>);
      return { status: r.status, body: json };
    } catch (e) {
      if (e instanceof MockHttpError)
        return { status: e.status, body: { error: e.code, message: e.message } };
      return { status: 500, body: { error: 'internal', message: e instanceof Error ? e.message : 'error' } };
    }
  }

  private syncs = 0;

  /**
   * A sync the server would run in the background (POST …/refresh), done at once: the bank's sync time moves on, and
   * a bank that failed or needed signing in is fine again.
   */
  private async synced(path: string): Promise<void> {
    const one = /^\/api\/settings\/connections\/([^/]+)\/refresh$/.exec(path);
    if (!one && path !== '/api/settings/connections/refresh') return;
    const { db } = await this.ready;
    const at = this.now + ++this.syncs * 60_000;
    if (one)
      await db
        .prepare(
          `UPDATE connection SET status = 'ok', last_synced_at = ?2, last_attempt_at = ?2 WHERE id = ?1`,
        )
        .bind(decodeURIComponent(one[1]!), at)
        .run();
    else
      await db
        .prepare(`UPDATE connection SET last_synced_at = ?1, last_attempt_at = ?1 WHERE removed_at IS NULL`)
        .bind(at)
        .run();
  }

  /** Plaid Link finished: a new connection, as the exchange would store it. */
  private async linked(): Promise<void> {
    const { db } = await this.ready;
    await db
      .prepare(
        `INSERT INTO connection (id, budget_id, provider, provider_item_id, institution_name, status, last_synced_at, linked_at, created_at, updated_at)
         SELECT ?1, id, 'plaid', ?1, 'New bank', 'ok', ?2, ?2, ?2, ?2 FROM budget`,
      )
      .bind(`con_mock_${++this.syncs}`, this.now)
      .run();
  }

  /** The daily-limit scenarios, on top of the engine's own session. */
  private session(s: Record<string, unknown>): unknown {
    if (!this.readOnly) return s;
    return {
      ...s,
      writeState: 'readonly',
      readOnlyUntil: '2026-11-15T00:00:00.000Z',
      readsPaused: this.scenario === 'resting',
    };
  }

  /** What only a real server can answer. `undefined`: the engine answers. */
  private stub(method: string, path: string, body: unknown): unknown {
    switch (`${method} ${path}`) {
      case 'GET /api/auth/status':
        return { signedIn: true, hasPasskey: true, setupOpen: false };
      case 'GET /api/settings/security':
        return {
          passkeys: this.passkeys,
          sessions: this.signIns.filter((x) => x.live).length,
          otherSessions: this.signIns.filter((x) => !x.current).length,
          signIns: this.signIns.filter((x) => x.live).map(({ live: _live, ...x }) => x),
        };
      case 'POST /api/settings/security/device-link':
        return { url: `${location.origin}/add-device#mock-token`, expiresAt: '2026-11-14T20:10:00Z' };
      case 'POST /api/settings/security/sign-out':
        return { ok: true };
      case 'POST /api/settings/security/sign-out-others':
        this.signIns = this.signIns.filter((x) => x.current);
        return { ok: true };
      case 'POST /api/settings/security/sign-out-session':
        this.signIns = this.signIns.filter((x) => x.current || x.id !== (body as { id?: string }).id);
        return { ok: true };
      case 'POST /api/settings/security/passkeys/pk_mock/rename':
        this.passkeys = this.passkeys.map((k) => ({ ...k, name: String((body as { name?: string }).name) }));
        return { ok: true };
      case 'POST /api/settings/connections/link-token':
        return { linkToken: `link-sandbox-mock-${parse(LinkTokenRequest, body).mode}` };
      case 'POST /api/settings/connections/exchange':
        parse(LinkExchange, body);
        return { ok: true, connectionId: 'con_mock', accounts: [] };
      case 'POST /api/usage':
        this.usageEvents.push(...parse(UsageBatch, body).events);
        return null;
      case 'POST /api/notes':
        this.notes.push(parse(NoteRequest, body));
        return { ok: true };
      default:
        return undefined;
    }
  }
}
