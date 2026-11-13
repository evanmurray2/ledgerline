// Banks of a sealed budget (docs/privacy.md 5.5, D-87): a new link is exchanged and stamped on the server, which
// keeps its token and no word about it; its first run describes it, and a device writes the link's connection and
// accounts from it as the server's own exchange wrote them; removing a bank ends it at Plaid, and the device marks
// it removed. Plaid is faked at the fetch level, and the test bank answers by cursor: no real bank is asked.
import { normalizePlaidAccount, PlaidProvider, type BankDataProvider } from '@ledgerline/bank-provider';
import { decryptToken, tokenKeyBytes } from '@ledgerline/platform';
import {
  ACTION,
  type Action,
  type BudgetKeys,
  deriveBudgetKeys,
  fromHex,
  newChallenge,
  randomBytes,
  signRequest,
  utf8,
  afterRun,
  checkLinkMac,
  cursorHash,
  openRun,
  serverKeys,
  toHex,
  type FiledRun,
} from '@ledgerline/seal';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.js';
import type { AppEnv } from '../src/http/context.js';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import { FILED_LINK, fileOpened, UnsupportedRun } from '../src/local/sealed-filing.js';
import { SEALED_FETCH, sealedFetchHandler, sealedFetchId, type FetchState } from '../src/seal/fetch-job.js';
import { beginSealedRun, completeSealedRun, sealLinkDescription } from '../src/seal/runs.js';
import { sealedApi } from '../src/seal/sealed-routes.js';
import { signedActionOf, type SignedPart } from '../src/http/signed-request.js';
import { BUDGET, T0 } from './log-writer.js';
import { handed, LINK_A, LINK_B, ring, world, type World } from './sealed-world.js';
import { copyDb } from './store-db.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
const plaid = new PlaidProvider({ clientId: 'x', secret: 'y', env: 'sandbox' });
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A device's signature of one request over the body `text`, with a challenge as the Directory hands it over. */
async function signAs(keys: BudgetKeys, action: Action, text: string): Promise<SignedPart> {
  const challenge = toHex(newChallenge());
  const sig = await signRequest(keys, BUDGET, action, fromHex(challenge), utf8(text));
  return { action, challenge, signature: toHex(sig) };
}

/** What Plaid says about the new link: two accounts, a checking account and a card. */
const PLAID_ACCOUNTS = [
  {
    account_id: 'pa-chk',
    name: 'Everyday Checking',
    official_name: null,
    type: 'depository',
    subtype: 'checking',
    mask: '1111',
    balances: { current: 1234.56, available: 1200, limit: null, iso_currency_code: 'USD' },
  },
  {
    account_id: 'pa-card',
    name: 'Rewards Card',
    official_name: 'Rewards Visa',
    type: 'credit',
    subtype: 'credit card',
    mask: '2222',
    balances: { current: 300.25, available: 4699.75, limit: 5000, iso_currency_code: 'USD' },
  },
];

/** Plaid, at the fetch level: what it was asked, and what its newest Link session says. */
function fakePlaid() {
  const asked: { path: string; body: Record<string, unknown> }[] = [];
  const st = {
    sessions: [] as unknown[],
    token: 'access-new-1',
    item: 'item-new-1',
    removeError: null as string | null,
  };
  const real = globalThis.fetch;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== 'plaid.test') return real(input as RequestInfo, init);
    const text = input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}');
    const body = JSON.parse(text || '{}') as Record<string, unknown>;
    asked.push({ path: url.pathname, body });
    switch (url.pathname) {
      case '/link/token/create':
        return json({
          link_token: 'link-new-1',
          expiration: 'x',
          hosted_link_url: 'https://secure.plaid.test/hl/1',
        });
      case '/link/token/get':
        return json({ link_sessions: st.sessions });
      case '/item/public_token/exchange':
        return json({ access_token: st.token, item_id: st.item });
      case '/item/get':
        return json({ item: { institution_id: 'ins_1' } });
      case '/institutions/get_by_id':
        return json({ institution: { name: 'Bank One' } });
      case '/accounts/get':
        return json({ accounts: PLAID_ACCOUNTS });
      case '/item/remove':
        if (st.removeError)
          return new Response(
            JSON.stringify({ error_code: st.removeError, error_type: 'ITEM_ERROR', error_message: 'x' }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        return json({ request_id: 'r' });
      default:
        return json({});
    }
  });
  return { asked, st };
}

const FINISHED = [
  {
    started_at: '2026-11-14T19:00:00Z',
    finished_at: '2026-11-14T19:01:00Z',
    results: { item_add_results: [{ public_token: 'public-new-1' }] },
  },
];

/** A device's copy of the budget, with nothing filed: a budget row, as the copy has. */
async function deviceCopy(
  name: string,
  budget: { start: string | null; tz: string } = { start: null, tz: 'America/Los_Angeles' },
) {
  const db = copyDb(`${name}-${Math.random()}`);
  await migrateLocal(db, T0);
  await db
    .prepare(
      `INSERT INTO budget (id, name, budget_start_month, time_zone, created_at, updated_at) VALUES (?1, 'My budget', ?2, ?3, 1, 1)`,
    )
    .bind(BUDGET, budget.start, budget.tz)
    .run();
  return db;
}

/** The rows a new link writes in the budget, without ids: the connection, its bank accounts, accounts, categories. */
async function linkRows(db: Env['DB'], connectionId: string) {
  const conn = await db
    .prepare(
      `SELECT provider, institution_name, status, days_requested, setup_done, linked_at, removed_at, created_at, updated_at
       FROM connection WHERE id = ?1`,
    )
    .bind(connectionId)
    .first();
  const pas = (
    await db
      .prepare(
        `SELECT provider_account_id, name, official_name, type, subtype, mask, current_balance, available_balance,
           credit_limit, iso_currency, balance_as_of, created_at, updated_at
         FROM provider_account WHERE connection_id = ?1 ORDER BY provider_account_id`,
      )
      .bind(connectionId)
      .all()
  ).results;
  const accounts = (
    await db
      .prepare(
        `SELECT a.provider_account_id, a.name, a.role, a.kind, a.budget_from, a.starting_balance, a.opening_anchor,
           a.created_at, a.updated_at,
           (SELECT json_object('name', c.name, 'kind', c.kind, 'id_is_pay', c.id = 'pay_' || a.id, 'at', c.created_at)
              FROM category c WHERE c.card_account_id = a.id) AS card_category
         FROM account a JOIN provider_account p ON p.provider_account_id = a.provider_account_id
         WHERE p.connection_id = ?1 ORDER BY a.provider_account_id`,
      )
      .bind(connectionId)
      .all()
  ).results;
  return { conn, pas, accounts };
}

describe('a new bank in a sealed budget, and removing one', () => {
  let p: ReturnType<typeof fakePlaid>;
  beforeAll(() => {
    p = fakePlaid();
  });
  afterAll(() => vi.restoreAllMocks());

  it('links, describes, files on a device, then removes', async () => {
    await world(
      async (x: World) => {
        // The bank routes answer only for a budget marked locked (seal/sealed-routes.ts).
        x.sql(`INSERT INTO store_mark (key, at) VALUES ('sealed', 1)`);
        const env = {
          DB: x.db,
          TOKEN_KEYS: '1:a passphrase of at least thirty-two characters!',
          TOKEN_KEY_CURRENT: '1',
          PLAID_ENV: 'sandbox',
          PLAID_CLIENT_ID: 'test-client',
          PLAID_SECRET: 'test-secret',
          PLAID_BASE_URL: 'http://plaid.test',
          FAKE_NOW: new Date(T0 + 3000).toISOString(),
        } as unknown as Env;
        let admin = false;
        // What the Directory hands the store for a signed request (http/signed-request.ts): here the device signs
        // each one with the budget's key, as the app does, unless a test says otherwise.
        let signed: SignedPart | null = null;
        const app = new Hono<AppEnv>();
        app.use('*', async (c, next) => {
          c.set('budgetId', BUDGET);
          c.set('userId', 'owner');
          c.set('isAdmin', admin);
          c.set('signed', signed);
          return next();
        });
        app.route('/api', sealedApi);
        const call = async (
          method: string,
          path: string,
          body?: unknown,
          e: Partial<Env> = {},
          o: { sign?: (action: Action, text: string) => Promise<SignedPart | null> } = {},
        ) => {
          const removing = /\/connections\/([^/]+)\/remove$/.exec(path);
          const text =
            method === 'GET'
              ? undefined
              : JSON.stringify(body ?? (removing ? { connectionId: removing[1] } : {}));
          const action = signedActionOf(method, path);
          signed = action ? await (o.sign ?? ((a, t) => signAs(x.w.keys, a, t)))(action, text!) : null;
          const r = await app.request(
            `${ORIGIN}${path}`,
            { method, headers: H, body: text },
            { ...env, ...e },
          );
          return { status: r.status, json: (await r.json()) as Record<string, unknown> };
        };
        // A stolen session with a fresh passkey check, and no budget key: every serious request is refused.
        const unsigned = { sign: async () => null };
        for (const [path, body] of [
          ['/api/settings/connections/link-token', { mode: 'new', hosted: true, confirmSlot: true }],
          ['/api/settings/connections/link-token', { mode: 'repair', connectionId: `con_${LINK_A}` }],
          ['/api/settings/connections/link-finish', { linkToken: 'link-new-1', mode: 'new' }],
          [`/api/settings/connections/con_${LINK_A}/remove`, { connectionId: `con_${LINK_A}` }],
        ] as const)
          expect(await call('POST', path, body, {}, unsigned)).toEqual({
            status: 403,
            json: { error: 'unsigned', message: 'Open your budget on this device, then try again.' },
          });
        // A key that is not the budget's, a signature of another request, or a body other than the one signed.
        const other = await deriveBudgetKeys(randomBytes(32), BUDGET, 1);
        expect(
          (
            await call(
              'POST',
              '/api/settings/connections/link-token',
              { mode: 'new' },
              {},
              {
                sign: (a, t) => signAs(other, a, t),
              },
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await call(
              'POST',
              '/api/settings/connections/link-token',
              { mode: 'new' },
              {},
              {
                sign: (_a, t) => signAs(x.w.keys, ACTION.linkFinish, t),
              },
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await call(
              'POST',
              '/api/settings/connections/link-token',
              { mode: 'new' },
              {},
              {
                sign: (a) => signAs(x.w.keys, a, '{"mode":"new","confirmSlot":true}'),
              },
            )
          ).status,
        ).toBe(403);
        // Removing a bank: the signed body must name the bank of the address.
        expect(
          await call('POST', `/api/settings/connections/con_${LINK_A}/remove`, {
            connectionId: `con_${LINK_B}`,
          }),
        ).toMatchObject({ status: 403, json: { error: 'unsigned' } });
        expect(p.asked).toEqual([]);

        // ---- a link token for a new bank: the same checks as before the budget was sealed
        expect(
          await call('POST', '/api/settings/connections/link-token', { mode: 'new', hosted: true }),
        ).toMatchObject({
          status: 403,
          json: { error: 'banks_off' },
        });
        admin = true;
        expect(
          await call(
            'POST',
            '/api/settings/connections/link-token',
            { mode: 'new', hosted: true },
            { PLAID_ENV: 'production' },
          ),
        ).toMatchObject({ status: 409, json: { error: 'confirm_slot' } });
        const lt = await call('POST', '/api/settings/connections/link-token', {
          mode: 'new',
          hosted: true,
          confirmSlot: true,
        });
        expect(lt).toEqual({
          status: 200,
          json: { linkToken: 'link-new-1', hostedUrl: 'https://secure.plaid.test/hl/1' },
        });
        expect(p.asked.at(-1)!.body).toMatchObject({ products: ['transactions'], hosted_link: {} });

        // ---- the person is still on Plaid's page, then finishes there
        expect(
          await call('POST', '/api/settings/connections/link-finish', {
            linkToken: 'link-new-1',
            mode: 'new',
          }),
        ).toEqual({
          status: 200,
          json: { status: 'waiting' },
        });
        p.st.sessions = FINISHED;
        const fin = await call('POST', '/api/settings/connections/link-finish', {
          linkToken: 'link-new-1',
          mode: 'new',
        });
        expect(fin.json.status).toBe('linked');
        const connectionId = fin.json.connectionId as string;
        expect(connectionId).toMatch(/^con_[0-9A-HJKMNP-TV-Z]{26}$/);
        const linkId = connectionId.slice(4);

        // The link is kept with its token encrypted and the Worker's stamp, a fetch asked for, and no word about the
        // bank: no name and no account.
        const row = (await x.db
          .prepare(`SELECT * FROM bank_link WHERE connection_id = ?1`)
          .bind(connectionId)
          .first<Record<string, unknown>>())!;
        expect(row).toMatchObject({
          id: linkId,
          budget_id: BUDGET,
          provider: 'plaid',
          provider_item_id: 'item-new-1',
          status: 'ok',
          check_result: 'ok',
          fetch_requested: 1,
          linked_at: T0 + 3000,
        });
        expect(JSON.stringify(row)).not.toContain('Bank One');
        expect(
          await decryptToken(ring, String(row.access_token_enc), Number(row.key_version), connectionId),
        ).toBe('access-new-1');
        const k = await serverKeys(await tokenKeyBytes(ring.keys[1]!), 1);
        expect(
          await checkLinkMac(
            k,
            BUDGET,
            linkId,
            'item-new-1',
            unb64(String(row.access_token_enc)),
            unb64(String(row.mac)),
          ),
        ).toBe(true);
        // The same Item finished again is the same link, not a new one.
        const again = await call('POST', '/api/settings/connections/link-finish', {
          linkToken: 'link-new-1',
          mode: 'new',
        });
        expect(again.json).toEqual({ status: 'linked', connectionId });
        const listed = await call('GET', '/api/settings/connections');
        expect(listed.json).toMatchObject({ used: 3, limit: 10 });
        // Health, for the ops token: each link from `bank_link` (the old tables are emptied), none fetched yet.
        const usage = async () => ({ written: 10, read: 20 });
        const health = await call('GET', '/api/health', undefined, { USAGE: usage } as Partial<Env>);
        expect(health.status).toBe(200);
        expect(health.json).toMatchObject({ ok: false, watermarkLag: 0, usage: { rowsRead: 20 } });
        const linked = (
          await x.db
            .prepare(`SELECT connection_id FROM bank_link WHERE status != 'removed' ORDER BY linked_at`)
            .all<{ connection_id: string }>()
        ).results.map((r) => r.connection_id);
        expect((health.json.connections as { id: string; stale: boolean }[]).map((h) => h.id)).toEqual(
          linked,
        );
        expect(linked).toContain(connectionId);

        // ---- the fetch: the link's first run describes it, and its transactions come with the next run
        const bankPage = {
          added: [
            {
              transaction_id: 'new-link-1',
              account_id: 'pa-chk',
              amount: 12.5,
              iso_currency_code: 'USD',
              date: '2027-01-14',
              authorized_date: null,
              name: 'COFFEE',
              merchant_name: null,
              pending: false,
              pending_transaction_id: null,
            },
          ],
          modified: [],
          removed: [],
          next_cursor: 'after-1',
          has_more: false,
        };
        const bank = {
          getAccounts: async (c: { accessToken: string }) => {
            expect(c.accessToken).toBe('access-new-1');
            return PLAID_ACCOUNTS.map(normalizePlaidAccount);
          },
          getInstitution: async () => ({ id: 'ins_1', name: 'Bank One' }),
          fetchSyncPage: async (_c: unknown, cursor: string | null) => {
            expect(cursor).toBeNull();
            return {
              body: new TextEncoder().encode(JSON.stringify(bankPage)),
              nextCursor: 'after-1',
              hasMore: false,
            };
          },
          parsePage: (body: string) => plaid.parsePage(body),
          getLiabilities: async () => [],
        } as unknown as BankDataProvider;
        const h = sealedFetchHandler({
          runs: x.d,
          provider: () => bank,
          pageSize: 100,
          budgetState: async () => 'normal',
        });
        let fs: FetchState = { phase: 'begin', linkId };
        for (let i = 0; ; i++) {
          if (i > 30) throw new Error('the fetch did not finish');
          const step = await h(
            { id: 'j', kind: SEALED_FETCH, connectionId: null, state: fs, attempts: 1, recurring: false },
            T0 + 4000 + i,
          );
          if ('done' in step) break;
          fs = step.state as FetchState;
        }

        // ---- a device files both runs
        const db = await deviceCopy('sealed-link-phone');
        const first = await openRun(x.filing, await handed(x.db, 1));
        expect(first.pages.map((pg) => pg.what)).toEqual([3]);
        await fileOpened({ DB: db } as Env, BUDGET, first, plaid);
        const filedLink = await db
          .prepare(`SELECT value FROM setting WHERE key = ?1`)
          .bind(`${FILED_LINK}${linkId}`)
          .first<{ value: string }>();
        // The link's cursor after its first run is the empty one: the next run starts from it.
        expect(filedLink!.value).toBe(toHex(await cursorHash('')));
        const rows = await linkRows(db, connectionId);
        expect(rows.conn).toMatchObject({
          provider: 'plaid',
          institution_name: 'Bank One',
          status: 'ok',
          setup_done: 1,
          linked_at: T0 + 3000,
          removed_at: null,
        });
        expect(rows.pas.map((r) => r.provider_account_id)).toEqual(['pa-card', 'pa-chk']);
        expect(rows.accounts).toMatchObject([
          { provider_account_id: 'pa-card', kind: 'credit', starting_balance: -30025 },
          { provider_account_id: 'pa-chk', kind: 'checking', starting_balance: 123456, card_category: null },
        ]);
        expect(JSON.parse(String(rows.accounts[0]!.card_category))).toMatchObject({
          name: 'Rewards Card',
          kind: 'cc_payment',
          id_is_pay: 1,
        });
        const second = await openRun(afterRun(x.filing, first), await handed(x.db, 2));
        await fileOpened({ DB: db } as Env, BUDGET, second, plaid);
        const txn = await db
          .prepare(
            `SELECT a.id AS account_id, t.connection_id FROM bank_txn t
             JOIN account a ON a.provider_account_id = t.provider_account_id WHERE t.provider_txn_id = 'new-link-1'`,
          )
          .first<{ account_id: string; connection_id: string }>();
        expect(txn).toMatchObject({
          account_id: expect.stringMatching(/^acc_/),
          connection_id: connectionId,
        });
        const engine = new LocalEngine(
          db,
          { budgetId: BUDGET, userId: 'owner', email: 'o@example.com' },
          () => T0 + 10_000,
        );
        const shown = async () =>
          (
            (await (await engine.request('GET', '/api/accounts')).json()) as {
              groups: { accounts: { name: string; meta: string; drift: number | null }[] }[];
            }
          ).groups.flatMap((g) => g.accounts);
        expect((await shown()).map((a) => a.name).sort()).toEqual(['Everyday Checking', 'Rewards Card']);

        // ---- remove the bank: Plaid ends the Item, the token goes, the fetches stop, the link still counts
        await x.db
          .prepare(
            `INSERT INTO job (id, kind, state, run_at, created_at, updated_at) VALUES (?1, ?2, '{}', ?3, 1, 1)`,
          )
          .bind(sealedFetchId(linkId), SEALED_FETCH, T0 + 99_999_999)
          .run();
        const before = p.asked.length;
        expect(await call('POST', `/api/settings/connections/${connectionId}/remove`)).toEqual({
          status: 200,
          json: { ok: true },
        });
        expect(p.asked.slice(before)).toEqual([
          {
            path: '/item/remove',
            body: { client_id: 'test-client', secret: 'test-secret', access_token: 'access-new-1' },
          },
        ]);
        expect(
          await x.db
            .prepare(
              `SELECT status, access_token_enc, key_version, provider_item_id, mac FROM bank_link WHERE id = ?1`,
            )
            .bind(linkId)
            .first(),
        ).toEqual({
          status: 'removed',
          access_token_enc: null,
          key_version: null,
          provider_item_id: null,
          mac: null,
        });
        expect(
          await x.db
            .prepare(`SELECT count(*) AS n FROM job WHERE id = ?1`)
            .bind(sealedFetchId(linkId))
            .first(),
        ).toEqual({ n: 0 });
        const after = await call('GET', '/api/settings/connections');
        expect(after.json.used).toBe(3);
        expect(
          (after.json.items as { id: string; status: string }[]).find((i) => i.id === connectionId),
        ).toMatchObject({
          status: 'removed',
        });
        // Asked again, it answers as before and asks Plaid nothing; a link it doesn't know is gone.
        expect(await call('POST', `/api/settings/connections/${connectionId}/remove`)).toEqual({
          status: 200,
          json: { ok: true },
        });
        expect(p.asked.length).toBe(before + 1);
        expect((await call('POST', '/api/settings/connections/con_nothing/remove')).status).toBe(404);
        // A refresh of a removed link asks nothing of the bank.
        expect((await call('POST', `/api/settings/connections/${connectionId}/refresh`)).status).toBe(404);
        // A link whose token Plaid no longer takes (its Item was ended some other way) is removed all the same.
        p.st.removeError = 'INVALID_ACCESS_TOKEN';
        expect(await call('POST', `/api/settings/connections/con_${LINK_B}/remove`)).toEqual({
          status: 200,
          json: { ok: true },
        });
        expect(await x.db.prepare(`SELECT status FROM bank_link WHERE id = ?1`).bind(LINK_B).first()).toEqual(
          { status: 'removed' },
        );
        // Any other refusal is not taken as removed.
        p.st.removeError = 'INTERNAL_SERVER_ERROR';
        expect((await call('POST', `/api/settings/connections/con_${LINK_A}/remove`)).status).toBe(500);
        expect(await x.db.prepare(`SELECT status FROM bank_link WHERE id = ?1`).bind(LINK_A).first()).toEqual(
          { status: 'ok' },
        );
        p.st.removeError = null;

        // ---- the device marks it removed: its accounts and rows stay, counted, not linked (D-87)
        const marked = await engine.request(
          'POST',
          `/api/settings/connections/${connectionId}/mark-removed`,
          {},
          {
            id: 'remove-bank-edit-1',
            at: T0 + 10_000,
          },
        );
        expect(marked.status).toBe(200);
        expect(
          await db
            .prepare(`SELECT status, removed_at FROM connection WHERE id = ?1`)
            .bind(connectionId)
            .first(),
        ).toEqual({ status: 'removed', removed_at: T0 + 10_000 });
        const left = await shown();
        expect(left.map((a) => a.name).sort()).toEqual(['Everyday Checking', 'Rewards Card']);
        expect(left.every((a) => a.meta.endsWith('· not linked') && a.drift === null)).toBe(true);
        expect(
          await db.prepare(`SELECT count(*) AS n FROM bank_txn WHERE provider_txn_id = 'new-link-1'`).first(),
        ).toEqual({ n: 1 });
        const conns = (await (await engine.request('GET', '/api/settings/connections')).json()) as {
          items: { id: string; status: string }[];
        };
        expect(conns.items.find((i) => i.id === connectionId)?.status).toBe('removed');

        // ---- every link ever made counts: removed ones too
        for (let i = 0; i < 7; i++)
          await x.db
            .prepare(
              `INSERT INTO bank_link (id, connection_id, budget_id, provider, linked_at, status, created_at) VALUES (?1, ?2, ?3, 'plaid', 1, 'removed', 1)`,
            )
            .bind(`old-${i}`, `con_old-${i}`, BUDGET)
            .run();
        expect(
          await call('POST', '/api/settings/connections/link-token', { mode: 'new', confirmSlot: true }),
        ).toMatchObject({
          status: 409,
          json: { error: 'item_limit' },
        });
      },
      { described: false },
    );
  });

  it('a description this version can’t read is not filed, and not skipped', async () => {
    await world(
      async (x) => {
        expect(await beginSealedRun(x.d, LINK_A, T0 + 2100)).toMatchObject({ describes: true });
        await sealLinkDescription(x.d, { bank: 'Some Bank', accounts: [] });
        expect(await completeSealedRun(x.d, T0 + 2100)).toEqual({ run: 1 });
        const db = await deviceCopy('sealed-link-odd');
        const first = await openRun(x.filing, await handed(x.db, 1));
        await expect(fileOpened({ DB: db } as Env, BUDGET, first, plaid)).rejects.toBeInstanceOf(
          UnsupportedRun,
        );
        expect(await db.prepare(`SELECT count(*) AS n FROM connection`).first()).toEqual({ n: 0 });
      },
      { described: false },
    );
  });
});

describe('a new link filed on a device writes its connection, bank accounts, accounts and card categories', () => {
  it('as the link’s first run describes them', async () => {
    const db = await deviceCopy('sealed-link-new', { start: '2026-11', tz: 'America/Los_Angeles' });
    const linkId = '01HNNNNNNNNNNNNNNNNNNNNNNN';
    const linkedAt = Date.parse('2026-11-14T20:00:00Z');
    const description = {
      v: 1,
      linkId,
      linkedAt,
      institution: 'Bank One',
      accounts: PLAID_ACCOUNTS.map(normalizePlaidAccount),
    };
    const filed = {
      manifest: {
        run: 1,
        linkId,
        restart: 0,
        runTime: linkedAt + 1000,
        inboxVersion: 1,
        cursorAfter: await cursorHash(''),
        added: 0,
        modified: 0,
        removed: 0,
      },
      manifestHash: new Uint8Array(32),
      pages: [{ what: 3, payload: new TextEncoder().encode(JSON.stringify(description)) }],
      receipt: new Uint8Array(32),
    } as unknown as FiledRun;
    await fileOpened({ DB: db } as Env, BUDGET, filed, plaid);
    const mine = await linkRows(db, `con_${linkId}`);
    expect(mine.conn).toMatchObject({ provider: 'plaid', institution_name: 'Bank One', linked_at: linkedAt });
    expect(mine.accounts.length).toBe(2);
  });
});
