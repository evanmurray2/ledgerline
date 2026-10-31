// A local stand-in for the Plaid API, used when Plaid Sandbox keys are not available and by end-to-end tests.
// It serves the same request and response shapes as Plaid's /transactions/sync and friends, with transaction
// objects sized like Sandbox's (location, counterparties, personal_finance_category and so on), so CPU and D1
// measurements see realistic payloads. It is not a Plaid client and never talks to Plaid.
//
// Usage: node tools/plaid-mock/server.mjs [--port 8788] [--txns 3000] [--seed 1]
import http from 'node:http';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const PORT = Number(args.port ?? 8788);
const TOTAL = Number(args.txns ?? 3000);
import { generate, ACCOUNTS } from './data.mjs';
const DATA = generate(TOTAL, Number(args.seed ?? 1));
let failNextWithMutation = Number(args.mutations ?? 0);

function send(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

const items = new Map();
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, {
        error_type: 'INVALID_REQUEST',
        error_code: 'INVALID_BODY',
        error_message: 'bad json',
      });
    }
    const path = req.url.split('?')[0];
    if (path === '/__control/mutation') {
      failNextWithMutation = Number(body.times ?? 1);
      return send(res, 200, { ok: true });
    }
    if (!body.client_id || !body.secret) {
      return send(res, 400, {
        error_type: 'INVALID_INPUT',
        error_code: 'INVALID_API_KEYS',
        error_message: 'missing keys',
      });
    }
    switch (path) {
      case '/transactions/sync': {
        const count = Math.min(500, Math.max(1, Number(body.count ?? 100)));
        const start = body.cursor ? Number(Buffer.from(body.cursor, 'base64').toString()) : 0;
        if (failNextWithMutation > 0 && start > 0) {
          failNextWithMutation--;
          return send(res, 400, {
            error_type: 'TRANSACTIONS_ERROR',
            error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
            error_message:
              'Underlying transaction data changed since last page was fetched. Please restart pagination from last update.',
          });
        }
        const added = DATA.slice(start, start + count);
        const next = start + added.length;
        return send(res, 200, {
          accounts: [],
          added,
          has_more: next < DATA.length,
          modified: [],
          next_cursor: Buffer.from(String(next)).toString('base64'),
          removed: [],
          request_id: `req_${Date.now()}`,
          transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
        });
      }
      case '/accounts/get':
        return send(res, 200, {
          accounts: ACCOUNTS.map((a) => ({
            account_id: a.account_id,
            balances: {
              available: a.bal,
              current: a.bal,
              iso_currency_code: 'USD',
              limit: a.type === 'credit' ? 10000 : null,
              unofficial_currency_code: null,
            },
            mask: a.mask,
            name: a.name,
            official_name: a.name,
            subtype: a.subtype,
            type: a.type,
          })),
          item: { item_id: 'item_mock' },
          request_id: 'req',
        });
      case '/sandbox/public_token/create':
        return send(res, 200, { public_token: `public-sandbox-${Date.now()}`, request_id: 'req' });
      case '/item/public_token/exchange': {
        const id = `item_${items.size + 1}`;
        items.set(id, true);
        return send(res, 200, { access_token: `access-sandbox-${id}`, item_id: id, request_id: 'req' });
      }
      case '/item/get':
        return send(res, 200, {
          item: { institution_id: 'ins_109508', item_id: 'item_mock' },
          request_id: 'req',
        });
      case '/institutions/get_by_id':
        return send(res, 200, {
          institution: { name: 'First Platypus Bank', institution_id: 'ins_109508' },
          request_id: 'req',
        });
      case '/link/token/create':
        return send(res, 200, {
          link_token: `link-sandbox-${Date.now()}`,
          expiration: new Date(Date.now() + 4 * 3600e3).toISOString(),
          request_id: 'req',
        });
      case '/liabilities/get':
        return send(res, 200, {
          accounts: [],
          liabilities: {
            credit: [
              {
                account_id: 'acc_credit',
                last_statement_balance: 611.4,
                last_statement_issue_date: '2026-10-28',
                next_payment_due_date: '2026-11-25',
                minimum_payment_amount: 35,
                aprs: [{ apr_percentage: 21.24 }],
              },
            ],
          },
          request_id: 'req',
        });
      default:
        return send(res, 404, {
          error_type: 'INVALID_REQUEST',
          error_code: 'NOT_FOUND',
          error_message: path,
        });
    }
  });
});
server.listen(PORT, '127.0.0.1', () =>
  console.log(`plaid-mock listening on ${PORT} with ${TOTAL} transactions`),
);
