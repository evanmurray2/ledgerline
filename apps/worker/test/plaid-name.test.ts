// Payee names from Plaid, PR 1 (docs/payee-names.md 3, 5, 8.1): filing stores Plaid's `name` in bank_txn.plaid_name,
// and filing's own new payees are named_by 'sync'.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { budgetDb } from './store-db.js';
import { acquire } from '../src/sync/lease.js';
import { applyPage, beginRun, rawPageKey } from '../src/sync/steps.js';
import { processPending } from '../src/sync/process.js';

const STORE = 'plaid-name';
const db = budgetDb(STORE);
const NOW = Date.parse('2026-11-14T20:00:00Z');
const provider = new PlaidProvider({ clientId: 'x', secret: 'y', env: 'sandbox' });
const B = 'b_plaid_name';
const C = 'con_plaid_name';

function plaidTxn(id: string, amount: number, raw: string, name: string | undefined, o: object = {}) {
  return {
    transaction_id: id,
    account_id: 'pa_card',
    amount,
    date: '2026-11-10',
    authorized_date: '2026-11-10',
    pending: false,
    pending_transaction_id: null,
    ...(name === undefined ? {} : { name }),
    original_description: raw,
    merchant_name: null,
    merchant_entity_id: null,
    payment_channel: 'in store',
    personal_finance_category: null,
    iso_currency_code: 'USD',
    ...o,
  };
}

let runN = 0;
async function sync(
  added: unknown[],
  modified: unknown[] = [],
  removed: { transaction_id: string; account_id: string }[] = [],
): Promise<void> {
  const run = `run_pn_${++runN}`;
  expect(await acquire(db, C, run, NOW)).toBe(true);
  const ctx = { db, connectionId: C, budgetId: B, holder: run, now: NOW };
  await beginRun(ctx, 'test');
  const body = JSON.stringify({ added, modified, removed, next_cursor: `cur${runN}`, has_more: false });
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
  for (let chunk = 0; ; chunk++) if ((await applyPage(ctx, provider, run, 0, chunk)).pageDone) break;
  for (;;) if ((await processPending({ ...env, DB: db } as never, B, NOW)).caughtUp) break;
  await db.batch([
    db.prepare(`UPDATE connection SET sync_lock = NULL, lock_expires = NULL WHERE id = ?1`).bind(C),
    db.prepare(`UPDATE sync_run SET phase = 'done' WHERE id = ?1`).bind(run),
  ]);
}

const plaidName = async (id: string) =>
  (
    await db
      .prepare(`SELECT plaid_name FROM bank_txn WHERE provider_txn_id = ?1`)
      .bind(id)
      .first<{ plaid_name: string | null }>()
  )?.plaid_name;

describe('Plaid names', () => {
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
          `INSERT INTO account (id, budget_id, provider_account_id, name, kind, budget_from, starting_balance, created_at, updated_at) VALUES ('a_card_pn', ?1, 'pa_card', 'Card', 'credit', '2026-10-01', 0, 0, 0)`,
        )
        .bind(B),
    ]);
    await sync([
      plaidTxn('hulu', 17.99, 'HLU*HULUPLUS HULU.COM/BILL CA', 'Hlu Huluplus'),
      plaidTxn('shell', 40, 'SHELL OIL 5744', 'Shell'),
      plaidTxn('noname', 5, 'MYSTERY 1', undefined),
      plaidTxn('gone', 9, 'GONE SOON', 'Gone'),
    ]);
  });

  it('a synced row stores Plaid’s name next to the bank text, and takes the newer one when it changes', async () => {
    expect(await plaidName('hulu')).toBe('Hlu Huluplus');
    expect(await plaidName('noname')).toBeNull();
    const row = await db
      .prepare(`SELECT raw_name FROM bank_txn WHERE provider_txn_id = 'hulu'`)
      .first<{ raw_name: string }>();
    expect(row?.raw_name).toBe('HLU*HULUPLUS HULU.COM/BILL CA');
    await sync(
      [],
      [plaidTxn('hulu', 17.99, 'HLU*HULUPLUS HULU.COM/BILL CA', 'Hulu', { merchant_name: 'Hulu' })],
    );
    expect(await plaidName('hulu')).toBe('Hulu');
  });

  it('payees the sync makes are named_by sync', async () => {
    const r = await db
      .prepare(
        `SELECT DISTINCT p.named_by FROM bank_txn b JOIN txn_overlay o ON o.txn_key = b.txn_key
         JOIN payee p ON p.id = o.payee_id WHERE b.budget_id = ?1`,
      )
      .bind(B)
      .all<{ named_by: string }>();
    expect(r.results.map((x) => x.named_by)).toEqual(['sync']);
  });
});
