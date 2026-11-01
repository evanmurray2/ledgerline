// The sync pipeline on a local D1 inside workerd: staged pages → apply (fenced, chunked) → watermark
// processing (rules, matcher, transfers, Waiting to match) → budget lines → recompute.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { acquire } from '../src/sync/lease.js';
import { applyPage, beginRun, rawPageKey } from '../src/sync/steps.js';
import { processPending } from '../src/sync/process.js';
import { recompute } from '../src/budget/recompute.js';
import { Scoped } from '../src/db/scoped.js';
import { inBudgetByAccount, monthTotals } from '../src/ledger/totals.js';
import type { Month } from '@ledgerline/domain';

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
  const ctx = { db, connectionId: C, budgetId: B, holder: run, now: NOW };
  await beginRun(ctx, 'test');
  const body = JSON.stringify({ added, modified: [], removed, next_cursor: `cur${runN}`, has_more: false });
  const key = rawPageKey(B, C, run, 0, 0);
  await db.batch([
    db
      .prepare(
        `INSERT INTO raw_page (key, budget_id, body, sha256, bytes, created_at) VALUES (?1, ?2, ?3, 'x', ?4, ?5)`,
      )
      .bind(key, B, body, body.length, NOW),
    db
      .prepare(
        `INSERT INTO sync_page (sync_run_id, page, budget_id, restart, raw_key, sha256, bytes, next_cursor, has_more, created_at) VALUES (?1, 0, ?2, 0, ?3, 'x', ?4, ?5, 0, ?6)`,
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

  it('a page of 150 transactions with 100 different payees processes (D1 allows 100 bound parameters)', async () => {
    const added = Array.from({ length: 150 }, (_, i) =>
      plaidTxn(`bulk${i}`, 'pa_card', 1 + i / 100, '2026-11-13', `SHOP ${i % 100}`, {
        merchant: `Shop ${i % 100}`,
        pending: i % 2 === 0,
      }),
    );
    await sync(added);
    const n = await db
      .prepare(
        `SELECT count(*) AS n FROM budget_line WHERE budget_id = ?1 AND txn_key IN (SELECT txn_key FROM bank_txn WHERE provider_txn_id LIKE 'bulk%')`,
      )
      .bind(B)
      .first<{ n: number }>();
    expect(n!.n).toBeGreaterThanOrEqual(150);
    const raw = await db
      .prepare(`SELECT count(*) AS n FROM raw_page WHERE budget_id = ?1`)
      .bind(B)
      .first<{ n: number }>();
    expect(raw!.n).toBeGreaterThan(0);
    // The archive is append-only.
    await expect(db.prepare(`DELETE FROM raw_page`).run()).rejects.toThrow(/append-only/);
    // The posted rows that name these pending rows are linked in chunks too.
    await sync(
      Array.from({ length: 75 }, (_, i) =>
        plaidTxn(`bulkp${i}`, 'pa_card', 1 + (i * 2) / 100, '2026-11-14', `SHOP ${(i * 2) % 100}`, {
          pending_transaction_id: `bulk${i * 2}`,
        }),
      ),
      Array.from({ length: 75 }, (_, i) => ({ transaction_id: `bulk${i * 2}`, account_id: 'pa_card' })),
    );
    expect(await keyOf('bulkp10')).toBe(await keyOf('bulk20'));
  });

  it('history before the budget start needs nothing: no Waiting to match, no transfer to sort out', async () => {
    await sync([
      plaidTxn('old-zelle', 'pa_chk', -250, '2026-08-03', 'ZELLE FROM ALEX'),
      plaidTxn('old-out', 'pa_chk', 300, '2026-08-12', 'ONLINE TRANSFER TO SAVINGS'),
      plaidTxn('old-in', 'pa_sav', -300, '2026-08-12', 'ONLINE TRANSFER FROM CHECKING'),
      plaidTxn('old-venmo', 'pa_chk', 40, '2026-09-02', 'VENMO PAYMENT'),
    ]);
    for (const id of ['old-zelle', 'old-out', 'old-in', 'old-venmo']) {
      const o = await overlay(await keyOf(id));
      expect(o).toMatchObject({ wtm_state: null, transfer_state: null });
    }
    const lines = await db
      .prepare(
        `SELECT count(*) AS n FROM budget_line WHERE txn_key IN (SELECT txn_key FROM bank_txn WHERE provider_txn_id LIKE 'old-%')`,
      )
      .first<{ n: number }>();
    expect(lines!.n).toBe(0);
  });

  it('stored month totals always equal a full recount, through syncs that change, move and remove old rows', async () => {
    const s = new Scoped(db, B, 'test');
    const direct = async () => {
      const byMonth = (
        await db
          .prepare(
            `SELECT substr(date, 1, 7) AS m, sum(amount) AS a FROM v_txn_bank WHERE budget_id = ?1 AND status = 'posted' GROUP BY m`,
          )
          .bind(B)
          .all<{ m: string; a: number }>()
      ).results;
      const byAccount = (
        await db
          .prepare(
            `SELECT account_id, sum(amount) AS a FROM v_transaction WHERE budget_id = ?1 AND status = 'posted'
               AND (date >= budget_from OR pending_at_link = 1) GROUP BY account_id`,
          )
          .bind(B)
          .all<{ account_id: string; a: number }>()
      ).results;
      return {
        months: Object.fromEntries(byMonth.filter((r) => r.m >= '2026-01').map((r) => [r.m, r.a])),
        accounts: Object.fromEntries(byAccount.map((r) => [r.account_id, r.a])),
      };
    };
    const stored = async () => {
      const t = await monthTotals(s, '2026-01' as Month, '2026-11' as Month, NOW);
      const months: Record<string, number> = {};
      for (const [m, accts] of t) {
        const sum = [...accts.values()].reduce((x, v) => x + v.all, 0);
        if (accts.size) months[m] = sum;
      }
      return { months, accounts: Object.fromEntries(inBudgetByAccount(t)) };
    };
    expect(await stored()).toEqual(await direct());
    const done = await db
      .prepare(`SELECT count(*) AS n FROM month_total_done WHERE budget_id = ?1`)
      .bind(B)
      .first<{ n: number }>();
    expect(done!.n).toBeGreaterThan(5); // finished months are now stored
    expect(await stored()).toEqual(await direct()); // and read back the same

    // A sync changes an old row's amount, moves another to a different month, and removes a third.
    await sync(
      [
        plaidTxn('old-out', 'pa_chk', 333, '2026-08-12', 'ONLINE TRANSFER TO SAVINGS'),
        plaidTxn('old-venmo', 'pa_chk', 40, '2026-07-02', 'VENMO PAYMENT'),
      ],
      [{ transaction_id: 'old-in', account_id: 'pa_sav' }],
    );
    expect(await stored()).toEqual(await direct());
  });

  it('recompute after the sync: RTA excludes Waiting to match', async () => {
    const r = await recompute(db, B, NOW, { force: true, fullFrom: true });
    expect(r.ok).toBe(true);
    expect(r.rta).toBe(500000); // starting balance only; the $1,000 Zelle waits to match
  });
});
