// A fake Plaid for the e2e Worker (playwright.bank.config.ts): the Worker's PLAID_BASE_URL points here, so a bank is
// linked, fetched and removed with no request to Plaid itself (CLAUDE.md: never a real link). It answers the
// endpoints packages/bank-provider/src/plaid.ts calls, and serves a page in place of Plaid's hosted Link that
// finishes the session at once and sends the browser back to the app.
//   node fake-plaid.mjs <port>
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 8796);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** link token → { finished, publicToken, completion } */
const sessions = new Map();
/** public token → item id; access token → item id */
const publics = new Map();
const items = new Map();
let n = 0;

const ACCOUNTS = [
  {
    account_id: 'e2e-checking',
    name: 'E2E Checking',
    official_name: null,
    type: 'depository',
    subtype: 'checking',
    mask: '0001',
    balances: { current: 1250.5, available: 1250.5, limit: null, iso_currency_code: 'USD' },
  },
];

const txn = (id, amount, date, name) => ({
  transaction_id: id,
  account_id: 'e2e-checking',
  amount,
  date,
  authorized_date: date,
  pending: false,
  pending_transaction_id: null,
  name,
  original_description: name,
  merchant_name: name,
  merchant_entity_id: null,
  payment_channel: 'in store',
  personal_finance_category: null,
  iso_currency_code: 'USD',
});

/**
 * The transactions a new link brings (Plaid's outflow is positive): two today, which the budget counts, and one
 * from before the link, which only moves the account's starting balance.
 */
const added = () => [
  txn('e2e-txn-1', 42.15, today(), 'E2E COFFEE ROASTERS'),
  txn('e2e-txn-2', 18.0, today(), 'E2E BOOKSHOP'),
  txn('e2e-txn-0', 99.0, daysAgo(40), 'E2E OLD PURCHASE'),
];

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const plaidError = (res, code, status = 400) =>
  json(res, status, {
    error_type: 'INVALID_INPUT',
    error_code: code,
    error_message: code,
    request_id: 'e2e',
  });

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  // Plaid's hosted Link, as the browser sees it: the person "links" at once and goes back to the app.
  if (req.method === 'GET' && url.pathname.startsWith('/hosted/')) {
    const s = sessions.get(decodeURIComponent(url.pathname.slice('/hosted/'.length)));
    if (!s) return plaidError(res, 'INVALID_LINK_TOKEN', 404);
    s.finished = true;
    res.writeHead(302, { location: s.completion });
    return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let b;
    try {
      b = JSON.parse(raw || '{}');
    } catch {
      return plaidError(res, 'INVALID_BODY');
    }
    if (!b.client_id || !b.secret) return plaidError(res, 'INVALID_API_KEYS');
    const item = () => items.get(b.access_token);
    switch (url.pathname) {
      case '/link/token/create': {
        const token = `link-sandbox-e2e-${++n}`;
        const completion = b.hosted_link?.completion_redirect_uri ?? null;
        sessions.set(token, { finished: false, publicToken: `public-sandbox-e2e-${n}`, completion });
        return json(res, 200, {
          link_token: token,
          expiration: new Date(Date.now() + 30 * 60_000).toISOString(),
          ...(completion ? { hosted_link_url: `http://localhost:${PORT}/hosted/${token}` } : {}),
          request_id: 'e2e',
        });
      }
      case '/link/token/get': {
        const s = sessions.get(b.link_token);
        if (!s) return plaidError(res, 'INVALID_LINK_TOKEN');
        const started_at = new Date(Date.now() - 60_000).toISOString();
        return json(res, 200, {
          link_sessions: s.finished
            ? [
                {
                  started_at,
                  finished_at: new Date().toISOString(),
                  results: { item_add_results: [{ public_token: s.publicToken }] },
                },
              ]
            : [{ started_at, finished_at: null }],
          request_id: 'e2e',
        });
      }
      case '/item/public_token/exchange': {
        if (!b.public_token?.startsWith('public-sandbox-e2e-'))
          return plaidError(res, 'INVALID_PUBLIC_TOKEN');
        const id = b.public_token.slice('public-sandbox-e2e-'.length);
        const access = `access-sandbox-e2e-${id}`;
        items.set(access, { id: `item-e2e-${id}`, synced: false, removed: false });
        publics.set(b.public_token, access);
        return json(res, 200, { access_token: access, item_id: `item-e2e-${id}`, request_id: 'e2e' });
      }
      case '/item/get':
        if (!item() || item().removed) return plaidError(res, 'ITEM_NOT_FOUND');
        return json(res, 200, { item: { item_id: item().id, institution_id: 'ins_e2e' }, request_id: 'e2e' });
      case '/institutions/get_by_id':
        return json(res, 200, {
          institution: { institution_id: 'ins_e2e', name: 'E2E Bank' },
          request_id: 'e2e',
        });
      case '/accounts/get':
        if (!item() || item().removed) return plaidError(res, 'ITEM_NOT_FOUND');
        return json(res, 200, { accounts: ACCOUNTS, request_id: 'e2e' });
      case '/liabilities/get':
        if (!item() || item().removed) return plaidError(res, 'ITEM_NOT_FOUND');
        return json(res, 200, { accounts: ACCOUNTS, liabilities: { credit: [] }, request_id: 'e2e' });
      case '/transactions/sync': {
        const it = item();
        if (!it || it.removed) return plaidError(res, 'ITEM_NOT_FOUND');
        // The first page brings the transactions; after that the cursor has nothing new.
        const first = !b.cursor;
        it.synced = true;
        return json(res, 200, {
          accounts: ACCOUNTS,
          added: first ? added() : [],
          modified: [],
          removed: [],
          next_cursor: `cursor-e2e-${today()}`,
          has_more: false,
          transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
          request_id: 'e2e',
        });
      }
      case '/item/remove':
        if (!item()) return plaidError(res, 'ITEM_NOT_FOUND');
        item().removed = true;
        return json(res, 200, { request_id: 'e2e' });
      default:
        return plaidError(res, 'UNKNOWN_ENDPOINT', 404);
    }
  });
});

server.listen(PORT, 'localhost', () => console.log(`fake Plaid on http://localhost:${PORT}`));
