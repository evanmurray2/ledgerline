// A budget on one card connection, synced through the real pipeline (apply, process, heal, work out), with the
// readers the pairing tests check: keys, overlays, what an account lists and counts, the open questions, and the
// routes the phone runs. Shared by entry-covers.test.ts and bank-pair.test.ts.
import { env } from 'cloudflare:test';
import { expect } from 'vitest';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { storeDb } from './store-db.js';
import { phoneTables, workOut } from './work-out.js';
import { acquire } from '../src/sync/lease.js';
import { applyPage, beginRun, rawPageKey } from '../src/sync/steps.js';
import { healPending, processPending } from '../src/sync/process.js';
import { RECENT_TX, uncovered } from '../src/ledger/ledger.js';
import { LocalEngine } from '../src/local/engine.js';

const provider = new PlaidProvider({ clientId: 'x', secret: 'y', env: 'sandbox' });

export function plaidTxn(
  id: string,
  account: number,
  amount: number,
  date: string,
  name: string,
  o: Record<string, unknown> = {},
) {
  return {
    transaction_id: id,
    account_id: `pa_${account}`,
    amount,
    date,
    authorized_date: date,
    pending: false,
    pending_transaction_id: null,
    name,
    original_description: name,
    merchant_name: o.merchant ?? null,
    merchant_entity_id: null,
    payment_channel: 'in store',
    personal_finance_category: null,
    iso_currency_code: 'USD',
    ...o,
  };
}
export const pend = (id: string, account: number, amount: number, date: string, name: string, o = {}) =>
  plaidTxn(id, account, amount, date, name, { pending: true, ...o });
export const removal = (id: string, account: number) => ({ transaction_id: id, account_id: `pa_${account}` });

/** A budget `B` with connection `C` and credit cards `a_1`…`a_<accounts>` (Plaid accounts `pa_<n>`), at `now`. */
export function bankSync(name: string, B: string, C: string, accounts: number, now: number) {
  const db = storeDb(name);
  const engine = new LocalEngine(
    db,
    { budgetId: B, userId: `u_${B}`, email: 'owner@example.com' },
    () => now,
  );
  let runN = 0;

  async function setup(): Promise<void> {
    await phoneTables(db);
    await db
      .prepare(`CREATE TABLE IF NOT EXISTS local_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
      .run();
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
      ...Array.from({ length: accounts }, (_, i) =>
        db
          .prepare(
            `INSERT INTO account (id, budget_id, provider_account_id, name, kind, budget_from, starting_balance, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'credit', '2026-10-01', 0, 0, 0)`,
          )
          .bind(`a_${i + 1}`, B, `pa_${i + 1}`, `Card ${i + 1}`),
      ),
      db
        .prepare(
          `INSERT INTO category (id, budget_id, name, kind, created_at, updated_at) VALUES ('dining', ?1, 'Dining out', 'spending', 0, 0)`,
        )
        .bind(B),
    ]);
  }

  async function sync(
    added: unknown[],
    removed: { transaction_id: string; account_id: string }[] = [],
  ): Promise<void> {
    const run = `run_${++runN}`;
    expect(await acquire(db, C, run, now)).toBe(true);
    const ctx = { db, connectionId: C, budgetId: B, holder: run, now };
    await beginRun(ctx, 'test');
    const body = JSON.stringify({ added, modified: [], removed, next_cursor: `cur${runN}`, has_more: false });
    const key = rawPageKey(B, C, run, 0, 0);
    await db.batch([
      db
        .prepare(
          `INSERT INTO raw_page (key, budget_id, body, sha256, bytes, created_at) VALUES (?1, ?2, ?3, 'x', ?4, ?5)`,
        )
        .bind(key, B, body, body.length, now),
      db
        .prepare(
          `INSERT INTO sync_page (sync_run_id, page, budget_id, restart, raw_key, sha256, bytes, next_cursor, has_more, created_at) VALUES (?1, 0, ?2, 0, ?3, 'x', ?4, ?5, 0, ?6)`,
        )
        .bind(run, B, key, body.length, `cur${runN}`, now),
      db.prepare(`UPDATE sync_run SET pages_fetched = 1 WHERE id = ?1`).bind(run),
    ]);
    for (let chunk = 0; ; chunk++) {
      const r = await applyPage(ctx, provider, run, 0, chunk);
      if (r.pageDone) break;
    }
    for (;;) if ((await processPending({ ...env, DB: db } as never, B, now)).caughtUp) break;
    await db.batch([
      db.prepare(`UPDATE connection SET sync_lock = NULL, lock_expires = NULL WHERE id = ?1`).bind(C),
      db.prepare(`UPDATE sync_run SET phase = 'done' WHERE id = ?1`).bind(run),
    ]);
    await workOut(db, B, now);
  }
  const heal = async () => {
    const r = await healPending({ ...env, DB: db } as never, B, C, now);
    await workOut(db, B, now);
    return r;
  };

  const keyOf = async (providerId: string) =>
    (await db
      .prepare(`SELECT txn_key FROM bank_txn WHERE provider_txn_id = ?1`)
      .bind(providerId)
      .first<{ txn_key: string }>())!.txn_key;
  const overlay = (key: string) =>
    db.prepare(`SELECT * FROM txn_overlay WHERE txn_key = ?1`).bind(key).first<Record<string, unknown>>();

  /** What an account lists, as the screens list it: each row's key, source and status. */
  const listed = async (account: number) =>
    (
      await db
        .prepare(
          `SELECT key, source, status, amount FROM v_transaction WHERE budget_id = ?1 AND account_id = ?2
             AND ${uncovered('v_transaction')} ORDER BY source, key`,
        )
        .bind(B, `a_${account}`)
        .all<{ key: string; source: string; status: string; amount: number }>()
    ).results;
  /** What the account counts: its budget lines (Spent), and its pending total as Accounts shows it. */
  const counted = async (account: number) => {
    const spent = await db
      .prepare(
        `SELECT coalesce(sum(amount), 0) AS a FROM budget_line WHERE budget_id = ?1 AND account_id = ?2 AND kind IN ('cat', 'uncat')`,
      )
      .bind(B, `a_${account}`)
      .first<{ a: number }>();
    const pending = await db
      .prepare(
        `SELECT coalesce(sum(amount), 0) AS p FROM ${RECENT_TX} WHERE budget_id = ?1 AND account_id = ?2
           AND status IN ('pending', 'upcoming') AND wont_clear = 0`,
      )
      .bind(B, `a_${account}`)
      .first<{ p: number }>();
    return { spent: spent!.a, pending: pending!.p };
  };
  const asks = async () =>
    (
      await db
        .prepare(
          `SELECT id, ref_key, data FROM alert WHERE type = 'same_purchase' AND acked_at IS NULL ORDER BY ref_key`,
        )
        .all<{ id: string; ref_key: string; data: string }>()
    ).results;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await engine.request(method, path, body);
    return { status: r.status, json: (await r.json()) as unknown };
  };

  return { db, engine, setup, sync, heal, keyOf, overlay, listed, counted, asks, call };
}
