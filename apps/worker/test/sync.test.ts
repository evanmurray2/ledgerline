// The sync pipeline on a local D1 + R2 inside workerd: staged pages → apply (fenced, chunked) → watermark
// processing (rules, matcher, transfers, Waiting to match) → budget lines → recompute.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { acquire } from '../src/sync/lease.js';
import { applyPage, beginRun, rawPageKey } from '../src/sync/steps.js';
import { processPending } from '../src/sync/process.js';
import { recompute } from '../src/budget/recompute.js';

const db = env.DB;
const NOW = Date.parse('2026-11-14T20:00:00Z');
const provider = new PlaidProvider({ clientId: 'x', secret: 'y', env: 'sandbox' });
const B = 'b_sync';
const C = 'con_sync';

function plaidTxn(
  id: string,
  account: string,
  amount: number,
  date: string,
  name: string,
  o: Record<string, unknown> = {},
) {
  return {
    transaction_id: id,
    account_id: account,
    amount,
    date,
    authorized_date: date,
    pending: false,
    pending_transaction_id: null,
    name,
    original_description: name,
    merchant_name: o.merchant ?? null,
    merchant_entity_id: null,
    payment_channel: account === 'pa_card' ? 'in store' : 'online',
    personal_finance_category: null,
    iso_currency_code: 'USD',
    ...o,
  };
}

let runN = 0;
async function sync(
  added: unknown[],
  removed: { transaction_id: string; account_id: string }[] = [],
): Promise<void> {
  const run = `run_${++runN}`;
  expect(await acquire(db, C, run, NOW)).toBe(true);
  const ctx = { db, raw: env.RAW, connectionId: C, budgetId: B, holder: run, now: NOW };
  await beginRun(ctx, 'test');
  const body = JSON.stringify({ added, modified: [], removed, next_cursor: `cur${runN}`, has_more: false });
  const key = rawPageKey(B, C, run, 0, 0);
  await env.RAW.put(key, body);
  await db.batch([
    db
      .prepare(
        `INSERT INTO sync_page (sync_run_id, page, budget_id, restart, r2_key, sha256, bytes, next_cursor, has_more, created_at) VALUES (?1, 0, ?2, 0, ?3, 'x', ?4, ?5, 0, ?6)`,
      )
      .bind(run, B, key, body.length, `cur${runN}`, NOW),
    db.prepare(`UPDATE sync_run SET pages_fetched = 1 WHERE id = ?1`).bind(run),
  ]);
  for (let chunk = 0; ; chunk++) {
    const r = await applyPage(ctx, provider, run, 0, chunk);
    if (r.pageDone) break;
  }
  for (;;) if ((await processPending(env as never, B, NOW)).caughtUp) break;
  await db.batch([
    db.prepare(`UPDATE connection SET sync_lock = NULL, lock_expires = NULL WHERE id = ?1`).bind(C),
    db.prepare(`UPDATE sync_run SET phase = 'done' WHERE id = ?1`).bind(run),
  ]);
}

const overlay = (key: string) =>
  db.prepare(`SELECT * FROM txn_overlay WHERE txn_key = ?1`).bind(key).first<Record<string, unknown>>();
const keyOf = async (providerId: string) =>
  (await db
    .prepare(`SELECT txn_key FROM bank_txn WHERE provider_txn_id = ?1`)
    .bind(providerId)
    .first<{ txn_key: string }>())!.txn_key;

describe('sync pipeline', () => {
  beforeAll(async () => {
    await db.batch([
      db
        .prepare(
          `INSERT INTO budget (id, name, budget_start_month, time_zone, created_at, updated_at) VALUES (?1, 'B', '2026-10', 'America/Los_Angeles', 0, 0)`,
        )
        .bind(B),
      db
        .prepare(
          `INSERT INTO connection (id, budget_id, provider, institution_name, linked_at, created_at, updated_at) VALUES (?1, ?2, 'plaid', 'Bank', 0, 0, 0)`,
        )
        .bind(C, B),
      db
        .prepare(
          `INSERT INTO account (id, budget_id, provider_account_id, name, kind, budget_from, starting_balance, created_at, updated_at) VALUES ('a_chk', ?1, 'pa_chk', 'Checking', 'checking', '2026-10-01', 500000, 0, 0)`,
        )
        .bind(B),
      db
        .prepare(
          `INSERT INTO account (id, budget_id, provider_account_id, name, kind, budget_from, starting_balance, created_at, updated_at) VALUES ('a_sav', ?1, 'pa_sav', 'Savings', 'savings', '2026-10-01', 0, 0, 0)`,
        )
        .bind(B),
      db
        .prepare(
          `INSERT INTO account (id, budget_id, provider_account_id, name, kind, budget_from, starting_balance, created_at, updated_at) VALUES ('a_card', ?1, 'pa_card', 'Card', 'credit', '2026-10-01', 0, 0, 0)`,
        )
        .bind(B),
      db
        .prepare(
          `INSERT INTO category (id, budget_id, name, kind, created_at, updated_at) VALUES ('groceries', ?1, 'Groceries', 'spending', 0, 0)`,
        )
        .bind(B),
      db
        .prepare(
          `INSERT INTO category (id, budget_id, name, kind, created_at, updated_at) VALUES ('dining', ?1, 'Dining out', 'spending', 0, 0)`,
        )
        .bind(B),
      db
        .prepare(
          `INSERT INTO category (id, budget_id, name, kind, card_account_id, created_at, updated_at) VALUES ('pay_card', ?1, 'Card', 'cc_payment', 'a_card', 0, 0)`,
        )
        .bind(B),
      db
        .prepare(
          `INSERT INTO rule (id, budget_id, sort, name, conditions, actions, created_at, updated_at) VALUES ('r1', ?1, 1, 'TJ', ?2, ?3, 0, 0)`,
        )
        .bind(
          B,
          JSON.stringify({ all: [{ field: 'description', op: 'contains', value: 'TRADER JOE' }] }),
          JSON.stringify([{ type: 'set_category', categoryId: 'groceries' }]),
        ),
      db
        .prepare(
          `INSERT INTO budget_line (budget_id, txn_key, line, month, date, seq, kind, account_id, card, category_id, amount, ref) VALUES (?1, 'start:a_chk', 'start', '2026-10', '2026-10-01', -1, 'rta', 'a_chk', 0, NULL, 500000, NULL)`,
        )
        .bind(B),
    ]);
    await sync([
      plaidTxn('uber-p', 'pa_card', 31.4, '2026-11-13', 'UBER EATS', { pending: true }),
      plaidTxn('tj', 'pa_card', 64.22, '2026-11-14', 'TRADER JOE S #123 OAKLAND CA', {
        merchant: 'Trader Joe’s',
      }),
      plaidTxn('zelle', 'pa_chk', -1000, '2026-11-03', 'ZELLE FROM SAM'),
      plaidTxn('xfer-out', 'pa_chk', 500, '2026-11-12', 'ONLINE TRANSFER TO SAVINGS'),
      plaidTxn('xfer-in', 'pa_sav', -500, '2026-11-12', 'ONLINE TRANSFER FROM CHECKING'),
      plaidTxn('amazon', 'pa_card', 38.1, '2026-11-13', 'AMAZON MKTPL*2K4RT8'),
    ]);
  });

  it('applies events once and builds the projection', async () => {
    const n = await db
      .prepare(`SELECT count(*) AS n FROM bank_event WHERE budget_id = ?1`)
      .bind(B)
      .first<{ n: number }>();
    expect(n?.n).toBe(6);
    const tj = await db
      .prepare(`SELECT amount, pending FROM bank_txn WHERE provider_txn_id = 'tj'`)
      .first<{ amount: number; pending: number }>();
    expect(tj).toEqual({ amount: -6422, pending: 0 }); // Plaid's outflow sign flipped
  });

  it('rules categorize, transfers pair, person-to-person money waits to match', async () => {
    expect(await overlay(await keyOf('tj'))).toMatchObject({
      category_id: 'groceries',
      categorized_by: 'rule',
      rule_id: 'r1',
    });
    expect(await overlay(await keyOf('xfer-out'))).toMatchObject({
      transfer_state: 'paired',
      transfer_account_id: 'a_sav',
    });
    expect(await overlay(await keyOf('xfer-in'))).toMatchObject({
      transfer_state: 'paired',
      transfer_account_id: 'a_chk',
    });
    expect(await overlay(await keyOf('zelle'))).toMatchObject({ wtm_state: 'waiting' });
    expect((await overlay(await keyOf('amazon')))?.category_id).toBeNull();
    const wait = await db
      .prepare(`SELECT sum(amount) AS a FROM budget_line WHERE budget_id = ?1 AND kind = 'wait'`)
      .bind(B)
      .first<{ a: number }>();
    expect(wait?.a).toBe(100000);
  });

  it('a posted row inherits the pending row’s txn_key, so your category survives posting', async () => {
    const pk = await keyOf('uber-p');
    await db
      .prepare(`UPDATE txn_overlay SET category_id = 'dining', categorized_by = 'user' WHERE txn_key = ?1`)
      .bind(pk)
      .run();
    await sync(
      [plaidTxn('uber', 'pa_card', 36.1, '2026-11-14', 'UBER EATS', { pending_transaction_id: 'uber-p' })],
      [{ transaction_id: 'uber-p', account_id: 'pa_card' }],
    );
    expect(await keyOf('uber')).toBe(pk);
    expect(await overlay(pk)).toMatchObject({ category_id: 'dining', categorized_by: 'user' });
    const line = await db
      .prepare(`SELECT amount, category_id FROM budget_line WHERE txn_key = ?1 AND kind = 'cat'`)
      .bind(pk)
      .first();
    expect(line).toEqual({ amount: -3610, category_id: 'dining' });
  });

  it('a re-issued posted row (same amount, within 3 days) inherits the old row’s category', async () => {
    const old = await keyOf('tj');
    await sync(
      [plaidTxn('tj2', 'pa_card', 64.22, '2026-11-15', 'TRADER JOE S')],
      [{ transaction_id: 'tj', account_id: 'pa_card' }],
    );
    expect(await keyOf('tj2')).toBe(old);
  });

  it('recompute after the sync: RTA excludes Waiting to match', async () => {
    const r = await recompute(db, B, NOW, { force: true, fullFrom: true });
    expect(r.ok).toBe(true);
    expect(r.rta).toBe(500000); // starting balance only; the $1,000 Zelle waits to match
  });
});
