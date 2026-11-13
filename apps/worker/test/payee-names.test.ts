// Payees from Plaid, live sync (docs/payee-names.md 4–7): keys, the name of a new payee, a filed row never moving,
// names that follow Plaid only while the payee is new, keys that follow a rename, and payment apps.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER, type MergeResult } from '@ledgerline/contracts';
import { budgetApi } from '../src/routes/api.js';
import type { AppEnv } from '../src/http/context.js';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { storeDb } from './store-db.js';
import { acquire } from '../src/sync/lease.js';
import { applyPage, beginRun, rawPageKey } from '../src/sync/steps.js';
import { processPending } from '../src/sync/process.js';

const db = storeDb('payee-names');
const NOW = Date.parse('2026-11-14T20:00:00Z');
const provider = new PlaidProvider({ clientId: 'x', secret: 'y', env: 'sandbox' });
const B = 'b_payee_names';
const C = 'con_payee_names';

function plaidTxn(id: string, amount: number, name: string, o: Record<string, unknown> = {}) {
  return {
    transaction_id: id,
    account_id: 'pa_card',
    amount,
    date: '2026-11-10',
    authorized_date: '2026-11-10',
    pending: false,
    pending_transaction_id: null,
    name,
    original_description: name.toUpperCase(),
    merchant_name: null,
    merchant_entity_id: null,
    payment_channel: 'in store',
    personal_finance_category: null,
    iso_currency_code: 'USD',
    ...o,
  };
}

let runN = 0;
async function sync(added: unknown[], modified: unknown[] = []): Promise<void> {
  const run = `run_pnm_${++runN}`;
  expect(await acquire(db, C, run, NOW)).toBe(true);
  const ctx = { db, connectionId: C, budgetId: B, holder: run, now: NOW };
  await beginRun(ctx, 'test');
  const body = JSON.stringify({ added, modified, removed: [], next_cursor: `cur${runN}`, has_more: false });
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

/** The app's own routes on this test store, as the phone's engine runs them (local/engine.ts). */
const routes = new Hono<AppEnv>();
routes.use('*', async (c, next) => {
  c.set('requestId', 'test');
  c.set('userId', 'owner');
  c.set('budgetId', B);
  c.set('email', 'owner@example.com');
  c.set('sessionId', '');
  return next();
});
routes.route('/api', budgetApi);
async function post(path: string, body: unknown): Promise<Response> {
  const env = {
    DB: db,
    PLAID_ENV: 'engine',
    USAGE: async () => ({ written: 0, read: 0, do: { requests: 0, gbs: 0 }, workers: 0, refreshedAt: null }),
    JOBS: { sync: async () => undefined },
  };
  return routes.fetch(
    new Request(`https://engine.local/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', origin: 'https://engine.local' },
      body: JSON.stringify(body),
    }),
    env as never,
    { waitUntil: () => undefined, passThroughOnException() {} } as never,
  );
}

const payeeOf = async (providerId: string) =>
  db
    .prepare(
      `SELECT p.id, p.name, p.named_by FROM bank_txn b JOIN txn_overlay o ON o.txn_key = b.txn_key
       JOIN payee p ON p.id = o.payee_id WHERE b.provider_txn_id = ?1`,
    )
    .bind(providerId)
    .first<{ id: string; name: string; named_by: string }>();
const keysOf = async (payeeId: string) =>
  (
    await db
      .prepare(
        `SELECT coalesce(pattern, 'm:' || merchant_entity_id) AS k FROM payee_alias WHERE payee_id = ?1 ORDER BY k`,
      )
      .bind(payeeId)
      .all<{ k: string }>()
  ).results.map((r) => r.k);

describe('payees from Plaid, live sync', () => {
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
          `INSERT INTO account (id, budget_id, provider_account_id, name, kind, budget_from, starting_balance, created_at, updated_at) VALUES ('a_card_pnm', ?1, 'pa_card', 'Card', 'credit', '2026-10-01', 0, 0, 0)`,
        )
        .bind(B),
      db
        .prepare(
          `INSERT INTO account (id, budget_id, provider_account_id, name, kind, budget_from, starting_balance, created_at, updated_at) VALUES ('a_chk_pnm', ?1, 'pa_chk', 'Checking', 'checking', '2026-10-01', 0, 0, 0)`,
        )
        .bind(B),
    ]);
  });

  it('names a new payee after the merchant name, else Plaid’s name, exactly, and gives it the row’s keys', async () => {
    await sync([
      plaidTxn('sb1', 5, 'STARBUCKS 0123', { merchant_name: 'Starbucks', merchant_entity_id: 'ent_sb' }),
      plaidTxn('odd', 3, 'SQ *ODD SHOP 44', { original_description: 'SQ *ODD SHOP 44 OAKLAND CA' }),
    ]);
    const sb = (await payeeOf('sb1'))!;
    expect(sb).toMatchObject({ name: 'Starbucks', named_by: 'sync' });
    expect(await keysOf(sb.id)).toEqual(['m:ent_sb', 'n:starbucks', 'n:starbucks 0123']);
    expect((await payeeOf('odd'))!.name).toBe('SQ *ODD SHOP 44');
    // Another store: the merchant id decides.
    await sync([
      plaidTxn('sb2', 6, 'STARBUCKS 9999', { merchant_name: 'Starbucks', merchant_entity_id: 'ent_sb' }),
    ]);
    expect((await payeeOf('sb2'))!.id).toBe(sb.id);
    expect(await keysOf(sb.id)).toContain('n:starbucks 9999');
  });

  it('a filed row never moves, and sync never joins two payees', async () => {
    await sync([plaidTxn('sh1', 40, 'Shell')]);
    await sync([
      plaidTxn('so1', 41, 'Shell Oil', { merchant_name: 'Shell Oil', merchant_entity_id: 'ent_shell' }),
    ]);
    const shell = (await payeeOf('sh1'))!;
    const oil = (await payeeOf('so1'))!;
    expect(oil.id).not.toBe(shell.id);
    // sh1 comes again with the other payee's merchant id: it stays where it was filed.
    await sync(
      [],
      [plaidTxn('sh1', 40, 'Shell', { merchant_name: 'Shell Oil', merchant_entity_id: 'ent_shell' })],
    );
    expect((await payeeOf('sh1'))!.id).toBe(shell.id);
    // A new row with keys of both: the first key (merchant id) decides; nothing is joined.
    await sync([plaidTxn('sh2', 42, 'Shell', { merchant_entity_id: 'ent_shell' })]);
    expect((await payeeOf('sh2'))!.id).toBe(oil.id);
    expect((await payeeOf('sh1'))!.id).toBe(shell.id);
    expect(await keysOf(shell.id)).toContain('n:shell');
  });

  it('a new payee’s name follows its first row as Plaid sends it again, and only that row', async () => {
    await sync([
      plaidTxn('hl1', 17.99, 'Hlu Huluplus Hulu', { original_description: 'HLU*HULUPLUS HULU.COM/BILL CA' }),
      plaidTxn('hl2', 17.99, 'Hlu Huluplus Hulu', {
        date: '2026-11-11',
        original_description: 'HLU*HULUPLUS HULU.COM/BILL CA',
      }),
    ]);
    const p = (await payeeOf('hl1'))!;
    expect(p.name).toBe('Hlu Huluplus Hulu');
    // Another row of the payee changes nothing.
    await sync(
      [],
      [plaidTxn('hl2', 17.99, 'Hlu Huluplus Hulu', { date: '2026-11-11', merchant_name: 'Hulu Plus' })],
    );
    expect((await payeeOf('hl1'))!.name).toBe('Hlu Huluplus Hulu');
    // The row that made it comes again with a merchant name: the payee takes it, and its keys.
    await sync(
      [],
      [
        plaidTxn('hl1', 17.99, 'Hlu Huluplus Hulu', {
          merchant_name: 'Hulu',
          merchant_entity_id: 'ent_hulu',
        }),
      ],
    );
    expect(await payeeOf('hl1')).toMatchObject({ id: p.id, name: 'Hulu', named_by: 'sync' });
    expect(await keysOf(p.id)).toEqual(expect.arrayContaining(['m:ent_hulu', 'n:hulu']));
    await sync([plaidTxn('hl3', 17.99, 'Hulu', { merchant_name: 'Hulu' })]);
    expect((await payeeOf('hl3'))!.id).toBe(p.id);
  });

  it('never takes another payee’s name', async () => {
    await sync([plaidTxn('ta1', 9, 'Taco Place')]);
    await sync([plaidTxn('tb1', 8, 'TACO PL 22')]);
    const other = (await payeeOf('tb1'))!;
    await sync([], [plaidTxn('tb1', 8, 'TACO PL 22', { merchant_name: 'taco place' })]);
    expect((await payeeOf('tb1'))!).toMatchObject({ id: other.id, name: 'TACO PL 22' });
  });

  it('stops following Plaid once you categorize one of its transactions', async () => {
    await sync([plaidTxn('cf1', 4, 'Cafe X')]);
    const p = (await payeeOf('cf1'))!;
    await db
      .prepare(
        `INSERT INTO category (id, budget_id, name, kind, created_at, updated_at) VALUES ('dining_pnm', ?1, 'Dining', 'spending', 0, 0)`,
      )
      .bind(B)
      .run();
    await db
      .prepare(
        `UPDATE txn_overlay SET category_id = 'dining_pnm', categorized_by = 'user' WHERE txn_key = (SELECT txn_key FROM bank_txn WHERE provider_txn_id = 'cf1')`,
      )
      .run();
    await sync([], [plaidTxn('cf1', 4, 'Cafe X', { merchant_name: 'Cafe Excellent' })]);
    expect((await payeeOf('cf1'))!).toMatchObject({ id: p.id, name: 'Cafe X' });
  });

  it('stops following Plaid once you rename it', async () => {
    await sync([plaidTxn('rn1', 4, 'Book Nook 7')]);
    const p = (await payeeOf('rn1'))!;
    await db.prepare(`UPDATE payee SET name = 'My books', named_by = 'user' WHERE id = ?1`).bind(p.id).run();
    await sync([], [plaidTxn('rn1', 4, 'Book Nook 7', { merchant_name: 'Book Nook' })]);
    expect((await payeeOf('rn1'))!.name).toBe('My books');
  });

  it('Venmo rows are one payee; Zelle rows are one per person', async () => {
    await sync([
      plaidTxn('v1', 20, 'Venmo', { account_id: 'pa_chk', original_description: 'VENMO PAYMENT 1023 ALICE' }),
      plaidTxn('v2', 35, 'Venmo', { account_id: 'pa_chk', original_description: 'VENMO PAYMENT 4410 BOB' }),
      plaidTxn('z1', -50, 'Zelle from Sam Lee', { account_id: 'pa_chk' }),
      plaidTxn('z2', -60, 'Zelle from Sam Lee', { account_id: 'pa_chk', date: '2026-11-12' }),
      plaidTxn('z3', -70, 'Zelle from Kim Park', { account_id: 'pa_chk' }),
    ]);
    const v = (await payeeOf('v1'))!;
    expect(v.name).toBe('Venmo');
    expect((await payeeOf('v2'))!.id).toBe(v.id);
    const sam = (await payeeOf('z1'))!;
    expect(sam.name).toBe('Zelle from Sam Lee');
    expect((await payeeOf('z2'))!.id).toBe(sam.id);
    expect((await payeeOf('z3'))!.id).not.toBe(sam.id);
  });

  it('a posted row that takes over your entry’s overlay, which has no payee, is filed then', async () => {
    await db.batch([
      db
        .prepare(
          `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, repeats, created_at, updated_at)
           VALUES ('mp_pnm', ?1, 'm:entry_pnm', 'a_card_pnm', 'pending', '2026-11-09', -1234, 'Corner Store', 'never', 0, 0)`,
        )
        .bind(B),
      db
        .prepare(
          `INSERT INTO txn_overlay (txn_key, budget_id, categorized_by, created_at, updated_at) VALUES ('m:entry_pnm', ?1, 'user', 0, 0)`,
        )
        .bind(B),
    ]);
    await sync([plaidTxn('en1', 12.34, 'Corner Store')]);
    const key = (await db
      .prepare(`SELECT txn_key FROM bank_txn WHERE provider_txn_id = 'en1'`)
      .first<{ txn_key: string }>())!.txn_key;
    expect(key).toBe('m:entry_pnm');
    expect((await payeeOf('en1'))!.name).toBe('Corner Store');
  });

  it('a rename gives the payee the key of its new name, so the next row with that Plaid name finds it', async () => {
    await sync([plaidTxn('gy1', 30, 'PLANET FIT 0042')]);
    const p = (await payeeOf('gy1'))!;
    const r = await post(`/settings/payees/${p.id}`, { name: 'Gym' });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await payeeOf('gy1')).toMatchObject({ name: 'Gym', named_by: 'user' });
    expect(await keysOf(p.id)).toContain('n:gym');
    await sync([plaidTxn('gy2', 30, 'GYM')]);
    expect((await payeeOf('gy2'))!.id).toBe(p.id);
  });

  it('a join moves every key and adds the name’s key; Undo moves them back and re-files later rows by key', async () => {
    await sync([
      plaidTxn('ja1', 12, 'Blue Bottle', { merchant_entity_id: 'ent_bb' }),
      plaidTxn('jb1', 13, 'BLUEBOTTLE COFFEE 9'),
    ]);
    const a = (await payeeOf('ja1'))!;
    const b = (await payeeOf('jb1'))!;
    const aKeys = await keysOf(a.id);
    const bKeys = await keysOf(b.id);
    const r = await post('/settings/payees/merge', { keep: a.id, ids: [a.id, b.id], name: 'Coffee' });
    expect(r.status, await r.clone().text()).toBe(200);
    const { undoId } = (await r.json()) as MergeResult;
    expect(await payeeOf('jb1')).toMatchObject({ id: a.id, name: 'Coffee', named_by: 'user' });
    expect(await keysOf(a.id)).toEqual([...aKeys, ...bKeys, 'n:coffee'].sort());
    // Rows that sync in after the join, by a key that was b's, and by the join's own key.
    await sync([plaidTxn('jb2', 14, 'BLUEBOTTLE COFFEE 9'), plaidTxn('jc1', 15, 'Coffee')]);
    expect((await payeeOf('jb2'))!.id).toBe(a.id);
    expect((await payeeOf('jc1'))!.id).toBe(a.id);
    expect((await post(`/settings/payees/merge/${undoId}/undo`, {})).status).toBe(200);
    expect(await payeeOf('ja1')).toMatchObject({ id: a.id, name: 'Blue Bottle', named_by: 'sync' });
    expect(await payeeOf('jb1')).toMatchObject({ id: b.id, name: 'BLUEBOTTLE COFFEE 9', named_by: 'sync' });
    expect((await payeeOf('jb2'))!.id).toBe(b.id);
    expect((await payeeOf('jc1'))!.id).toBe(a.id);
    expect(await keysOf(a.id)).toEqual(aKeys);
    expect(await keysOf(b.id)).toEqual(bKeys);
  });

  it('writes no old cleaned-text aliases', async () => {
    const old = await db
      .prepare(`SELECT count(*) AS n FROM payee_alias WHERE pattern IS NOT NULL AND pattern NOT LIKE 'n:%'`)
      .first<{ n: number }>();
    expect(old!.n).toBe(0);
  });
});
