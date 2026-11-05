// Payee names from Plaid, PR 1 (docs/payee-names.md 3, 5, 8.1): the sync stores Plaid's `name` in bank_txn.plaid_name,
// sync's own new payees are named_by 'sync', and a one-time job fills plaid_name on older rows from their raw pages.
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { budgetStub, storeDb } from './store-db.js';
import { acquire } from '../src/sync/lease.js';
import { applyPage, beginRun, rawPageKey } from '../src/sync/steps.js';
import { processPending } from '../src/sync/process.js';
import {
  FILL_PLAID_NAME_ID,
  FILL_PLAID_NAME_ROWS,
  fillPlaidNameStep,
  type FillPlaidNameState,
} from '../src/sync/fill-plaid-name.js';
import { BUDGET_MIGRATIONS } from '../src/store/migrations.gen.js';

const STORE = 'plaid-name';
const db = storeDb(STORE);
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

/** Every row as it was before migration 0007: no Plaid name. */
const forget = () => db.prepare(`UPDATE bank_txn SET plaid_name = NULL WHERE budget_id = ?1`).bind(B).run();

/** Migration 0007's statement that queues the job. */
function queueJob(): string {
  const sql = BUDGET_MIGRATIONS.find((m) => m.name.startsWith('0007'))!.sql;
  return sql.slice(sql.indexOf('INSERT INTO job'));
}

async function runJob(state: FillPlaidNameState = {}): Promise<{ steps: number; filled: number }> {
  let steps = 0;
  let filled = 0;
  for (;;) {
    const r = await fillPlaidNameStep(db, B, state);
    steps++;
    filled += r.filled;
    if (r.done) return { steps, filled };
    expect(r.state.before ?? Infinity).toBeLessThan(state.before ?? Infinity);
    state = r.state;
  }
}

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

  it('the job fills plaid_name from each row’s last raw page, and only from that page', async () => {
    // A second page: shell again, now without Plaid's name; gone is removed.
    await sync(
      [],
      [plaidTxn('shell', 40, 'SHELL OIL 5744', undefined)],
      [{ transaction_id: 'gone', account_id: 'pa_card' }],
    );
    await forget();
    const r = await runJob();
    expect(r.filled).toBe(1);
    // hulu: from its newest page ('Hulu', not the first page's 'Hlu Huluplus').
    expect(await plaidName('hulu')).toBe('Hulu');
    // shell's newest page has no name, so it stays empty: the older page's name is not used.
    expect(await plaidName('shell')).toBeNull();
    expect(await plaidName('noname')).toBeNull();
    // Removed rows are left alone.
    expect(await plaidName('gone')).toBeNull();
  });

  it('is restartable and idempotent, and never overwrites a name the sync wrote', async () => {
    await sync([plaidTxn('a1', 1, 'A ONE', 'A one'), plaidTxn('a2', 2, 'A TWO', 'A two')]);
    await sync([plaidTxn('b1', 3, 'B ONE', 'B one')]);
    await forget();
    // The first step reads the newest page (b1's).
    const first = await fillPlaidNameStep(db, B, {});
    if (first.done) throw new Error('expected a step');
    expect(first.filled).toBe(1);
    expect(await plaidName('b1')).toBe('B one');
    // The sync writes a newer name while the job runs: the job keeps it.
    await sync([], [plaidTxn('a2', 2, 'A TWO', 'A two, newer')]);
    const rest = await runJob(first.state);
    expect(await plaidName('a1')).toBe('A one');
    expect(await plaidName('a2')).toBe('A two, newer');
    expect(await plaidName('hulu')).toBe('Hulu');
    expect(rest.filled).toBe(2); // a1 and hulu
    // A step killed before its state was saved runs again from the older state, and a finished job run again from
    // the start: nothing left to write.
    expect((await runJob({})).filled).toBe(0);
    expect((await runJob(first.state)).filled).toBe(0);
  });

  it('reads a page longer than one step’s row limit in several steps', async () => {
    const many = Array.from({ length: FILL_PLAID_NAME_ROWS + 5 }, (_, i) =>
      plaidTxn(`m${i}`, 1 + i, `MANY ${i}`, `Many ${i}`),
    );
    await sync(many);
    await forget();
    const first = await fillPlaidNameStep(db, B, {});
    expect(first.filled).toBe(FILL_PLAID_NAME_ROWS);
    await runJob(first.done ? {} : first.state);
    for (const i of [0, FILL_PLAID_NAME_ROWS + 4]) expect(await plaidName(`m${i}`)).toBe(`Many ${i}`);
  });

  it('runs once from the store’s alarm and is gone when done', async () => {
    await forget();
    const stub = budgetStub(STORE);
    // The job row migration 0007 queues in a store that has bank history.
    await runInDurableObject(stub, async (_o, st) => {
      st.storage.sql.exec(queueJob());
      st.storage.sql.exec(`UPDATE job SET run_at = 0 WHERE id = ?`, FILL_PLAID_NAME_ID);
    });
    for (let i = 0; i < 50; i++) {
      const left = await runInDurableObject(stub, async (o) => {
        await o.alarm();
        return (await o.jobs()).filter((j) => j.id === FILL_PLAID_NAME_ID);
      });
      if (!left.length) break;
      expect(left[0]!.last_error).toBeNull();
    }
    expect((await runInDurableObject(stub, (o) => o.jobs())).map((j) => j.id)).not.toContain(
      FILL_PLAID_NAME_ID,
    );
    expect(await plaidName('hulu')).toBe('Hulu');
    expect(await plaidName('m3')).toBe('Many 3');
  });

  it('migration 0007 queues the job only where bank history exists', async () => {
    const queued = await runInDurableObject(budgetStub('plaid-name-empty'), async (_o, st) => {
      st.storage.sql.exec(queueJob());
      return st.storage.sql.exec(`SELECT id FROM job WHERE id = ?`, FILL_PLAID_NAME_ID).toArray().length;
    });
    expect(queued).toBe(0);
  });
});
