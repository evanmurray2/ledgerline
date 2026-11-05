// Bank pending rows and their posted rows (D-47, docs/payee-names.md 9.3), through the real pipeline, in every order a
// bank sends them: with and without the provider's link, the pending row removed before, with or after the posted row,
// or not for days. Without the link they pair only on exact evidence: Plaid's merchant id or names, or the same amount
// on the same day; the bank's own text (original_description) is never compared.
import { env } from 'cloudflare:test';
import { storeDb } from './store-db.js';
import { phoneTables, workOut } from './work-out.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView } from '@ledgerline/contracts';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { acquire } from '../src/sync/lease.js';
import { applyPage, beginRun, rawPageKey } from '../src/sync/steps.js';
import { healPending, processPending } from '../src/sync/process.js';
import { LocalEngine } from '../src/local/engine.js';

const db = storeDb('pending-match');
const NOW = Date.parse('2026-11-14T20:00:00Z');
const provider = new PlaidProvider({ clientId: 'x', secret: 'y', env: 'sandbox' });
const B = 'b_pm';
const C = 'con_pm';
const engine = new LocalEngine(db, { budgetId: B, userId: 'u_pm', email: 'owner@example.com' }, () => NOW);

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
  for (;;) if ((await processPending({ ...env, DB: db } as never, B, NOW)).caughtUp) break;
  await db.batch([
    db.prepare(`UPDATE connection SET sync_lock = NULL, lock_expires = NULL WHERE id = ?1`).bind(C),
    db.prepare(`UPDATE sync_run SET phase = 'done' WHERE id = ?1`).bind(run),
  ]);
  // The phone works out the lines after it syncs (D-45).
  await workOut(db, B, NOW);
}

const overlay = (key: string) =>
  db.prepare(`SELECT * FROM txn_overlay WHERE txn_key = ?1`).bind(key).first<Record<string, unknown>>();
const keyOf = async (providerId: string) =>
  (await db
    .prepare(`SELECT txn_key FROM bank_txn WHERE provider_txn_id = ?1`)
    .bind(providerId)
    .first<{ txn_key: string }>())!.txn_key;

const visible = async (ids: string[]) =>
  (
    await db
      .prepare(
        `SELECT provider_txn_id AS id, status FROM v_transaction WHERE provider_txn_id IN (${ids.map((_, i) => `?${i + 1}`).join(',')}) ORDER BY id`,
      )
      .bind(...ids)
      .all<{ id: string; status: string }>()
  ).results;
const spent = async (key: string) =>
  (await db
    .prepare(
      `SELECT coalesce(sum(amount), 0) AS a FROM budget_line WHERE txn_key = ?1 AND kind IN ('cat', 'uncat')`,
    )
    .bind(key)
    .first<{ a: number }>())!.a;
const categorize = (key: string, cat: string) =>
  db
    .prepare(`UPDATE txn_overlay SET category_id = ?2, categorized_by = 'user' WHERE txn_key = ?1`)
    .bind(key, cat)
    .run();
const pend = (id: string, amount: number, date: string, name: string, o: Record<string, unknown> = {}) =>
  plaidTxn(id, 'pa_card', amount, date, name, { pending: true, authorized_date: date, ...o });
const removal = (id: string) => ({ transaction_id: id, account_id: 'pa_card' });
const heal = async () => {
  const r = await healPending({ ...env, DB: db } as never, B, C, NOW);
  await workOut(db, B, NOW);
  return r;
};
/** The open "Same purchase?" question about a row, if any. */
const askOf = async (ref: string) =>
  db
    .prepare(`SELECT id, data FROM alert WHERE type = 'same_purchase' AND ref_key = ?1 AND acked_at IS NULL`)
    .bind(ref)
    .first<{ id: string; data: string }>();
const call = async (method: string, path: string, body?: unknown) => {
  const r = await engine.request(method, path, body);
  return { status: r.status, json: (await r.json()) as unknown };
};
/** What these rows count together: their budget lines (Spent), whatever key each has now. */
const together = async (ids: string[]) => {
  let total = 0;
  for (const k of new Set(await Promise.all(ids.map(keyOf)))) total += await spent(k);
  return total;
};

describe('posted rows claim their pending rows', () => {
  beforeAll(async () => {
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

  it('no link, pending still listed (the bank keeps it for hours): the same merchant name pairs, tip and all', async () => {
    // As Bank of America sends them: no link, bank texts that differ, and Plaid's names that agree.
    await sync([pend('jb-p', 35.75, '2026-11-08', 'JUNEBUG', { original_description: 'JUNEBUG' })]);
    await categorize('p:jb-p', 'dining');
    await sync([
      plaidTxn('jb', 'pa_card', 42.75, '2026-11-10', 'Junebug', {
        original_description: 'TST*JUNEBUG New Orleans LA',
        merchant: 'Junebug',
        authorized_date: '2026-11-08',
      }),
    ]);
    expect(await keyOf('jb')).toBe('p:jb-p');
    expect(await visible(['jb', 'jb-p'])).toEqual([{ id: 'jb', status: 'posted' }]);
    expect(await overlay('p:jb-p')).toMatchObject({
      category_id: 'dining',
      alert: JSON.stringify(['amount_changed:-3575:-4275']),
    });
    expect(await spent('p:jb-p')).toBe(-4275);
    // Plaid removes the pending row later: nothing else happens to it, or to anything else.
    await sync([], [removal('jb-p')]);
    expect(await keyOf('jb')).toBe('p:jb-p');
    expect((await overlay('p:jb-p'))?.orphaned_at).toBeNull();
  });

  it('a pending row you marked won’t clear still lets its posted row count, and says so (same amount and day)', async () => {
    await sync([pend('hd-p', 25.3, '2026-11-08', 'PY HEARD DAT KITCHEN')]);
    await db.prepare(`UPDATE txn_overlay SET wont_clear = 1 WHERE txn_key = 'p:hd-p'`).run();
    await sync([
      plaidTxn('hd', 'pa_card', 25.3, '2026-11-10', 'PY *HEARD DAT KITCHEN NEW ORLE', {
        authorized_date: '2026-11-08',
      }),
    ]);
    expect(await keyOf('hd')).toBe('p:hd-p');
    expect(await overlay('p:hd-p')).toMatchObject({
      wont_clear: 0,
      alert: JSON.stringify(['cleared_despite_wont_clear']),
    });
    expect(await spent('p:hd-p')).toBe(-2530);
  });

  it('won’t clear set after the posted row arrived first, then the pending row removed: the charge still counts', async () => {
    await sync([pend('wc-p', 30, '2026-11-08', 'SHOP C')]);
    // No exact evidence on arrival (another name, and the day differs: the bank's authorization date is missing)...
    await sync([plaidTxn('wc', 'pa_card', 30, '2026-11-09', 'XYZ', { authorized_date: null })]);
    expect(await keyOf('wc')).toBe('p:wc');
    await db
      .prepare(
        `UPDATE txn_overlay SET wont_clear = 1, category_id = 'dining', categorized_by = 'user' WHERE txn_key = 'p:wc-p'`,
      )
      .run();
    // ...and later the posted row is claimed by the same pending row through the provider's link.
    await sync(
      [
        plaidTxn('wc', 'pa_card', 30, '2026-11-09', 'XYZ', {
          authorized_date: null,
          pending_transaction_id: 'wc-p',
        }),
      ],
      [removal('wc-p')],
    );
    expect(await keyOf('wc')).toBe('p:wc-p');
    expect(await overlay('p:wc-p')).toMatchObject({ wont_clear: 0, category_id: 'dining' });
    expect(await spent('p:wc-p')).toBe(-3000);
  });

  it('pending row removed in one sync, posted row in a later one: still paired, your category kept', async () => {
    await sync([pend('rm-p', 20, '2026-11-08', 'SHOP B')]);
    await categorize('p:rm-p', 'dining');
    await sync([], [removal('rm-p')]);
    expect((await overlay('p:rm-p'))?.orphaned_at).not.toBeNull();
    await sync([plaidTxn('rm', 'pa_card', 20, '2026-11-10', 'SHOP B', { authorized_date: '2026-11-08' })]);
    expect(await keyOf('rm')).toBe('p:rm-p');
    expect(await overlay('p:rm-p')).toMatchObject({ category_id: 'dining', orphaned_at: null });
  });

  it('with the provider’s link but the pending row still listed: shown once, counted once', async () => {
    await sync([pend('ln-p', 50, '2026-11-08', 'SHOP A')]);
    await sync([plaidTxn('ln', 'pa_card', 50, '2026-11-10', 'SHOP A', { pending_transaction_id: 'ln-p' })]);
    expect(await visible(['ln', 'ln-p'])).toEqual([{ id: 'ln', status: 'posted' }]);
    const listed = await db
      .prepare(`SELECT count(*) AS n FROM v_txn_bank WHERE key = 'p:ln-p' AND status = 'pending'`)
      .first<{ n: number }>();
    expect(listed!.n).toBe(0);
  });

  it('two tabs at the same bar post together: both claim a pending row; the holds stay pending', async () => {
    await sync([
      pend('cl1-p', 23.5, '2026-11-08', 'CAFE LAFITTE'),
      pend('cl2-p', 23.25, '2026-11-08', 'CAFE LAFITTE'),
      pend('clh-p', 5, '2026-11-08', 'CAFE LAFITTE'),
    ]);
    await sync([
      plaidTxn('cl1', 'pa_card', 28.5, '2026-11-10', 'Cafe Lafitte', {
        original_description: 'CAFE LAFITTE 504-5256724 LA',
        authorized_date: '2026-11-08',
      }),
      plaidTxn('cl2', 'pa_card', 28.25, '2026-11-10', 'Cafe Lafitte', {
        original_description: 'CAFE LAFITTE 504-5256724 LA',
        authorized_date: '2026-11-08',
      }),
    ]);
    expect(new Set([await keyOf('cl1'), await keyOf('cl2')])).toEqual(new Set(['p:cl1-p', 'p:cl2-p']));
    expect(await visible(['cl1', 'cl2', 'cl1-p', 'cl2-p', 'clh-p'])).toEqual([
      { id: 'cl1', status: 'posted' },
      { id: 'cl2', status: 'posted' },
      { id: 'clh-p', status: 'pending' },
    ]);
  });

  it('a posted row’s own category fills in when the pending row it claims had none', async () => {
    await sync([pend('el-p', 97.9, '2026-11-08', 'ELIZABETH S RESTAURANT')]);
    // An earlier release left the two unpaired; the posted row was categorized on its own.
    await sync([
      plaidTxn('el', 'pa_card', 97.9, '2026-11-10', "ELIZABETH'S RESTAURANT NEW ORL", {
        authorized_date: '2026-11-08',
      }),
    ]);
    await db.batch([
      db.prepare(`UPDATE bank_txn SET txn_key = 'p:el' WHERE provider_txn_id = 'el'`),
      db
        .prepare(
          `INSERT OR IGNORE INTO txn_overlay (txn_key, budget_id, created_at, updated_at) VALUES ('p:el', ?1, 0, 0)`,
        )
        .bind(B),
      db.prepare(
        `UPDATE txn_overlay SET category_id = 'dining', categorized_by = 'payee' WHERE txn_key = 'p:el'`,
      ),
      db.prepare(`UPDATE txn_overlay SET category_id = NULL, categorized_by = NULL WHERE txn_key = 'p:el-p'`),
    ]);
    expect(await visible(['el', 'el-p'])).toHaveLength(2);
    // A sync that only brings posted rows doesn't look back (CPU)...
    await sync([plaidTxn('other', 'pa_card', 3, '2026-11-12', 'SOMETHING ELSE')]);
    expect(await keyOf('el')).toBe('p:el');
    // ...the next one that brings any pending row on the card heals it.
    await sync([pend('new-p', 7, '2026-11-13', 'NEW PLACE')]);
    expect(await keyOf('el')).toBe('p:el-p');
    expect(await overlay('p:el-p')).toMatchObject({ category_id: 'dining', categorized_by: 'payee' });
    expect(await visible(['el', 'el-p'])).toEqual([{ id: 'el', status: 'posted' }]);
    expect(await spent('p:el')).toBe(0);
  });

  it('a sync with no news from the bank still heals a pair an older release left unpaired', async () => {
    await sync([pend('old-p', 42.75, '2026-11-08', 'JUNEBUG')]);
    await sync([
      plaidTxn('old', 'pa_card', 42.75, '2026-11-10', 'TST*JUNEBUG New Orleans LA', {
        authorized_date: '2026-11-08',
      }),
    ]);
    // As the owner's card was before the fix: both rows, unpaired.
    await db.prepare(`UPDATE bank_txn SET txn_key = 'p:old' WHERE provider_txn_id = 'old'`).run();
    await db.prepare(`UPDATE txn_overlay SET wont_clear = 1 WHERE txn_key = 'p:old-p'`).run();
    expect(await visible(['old', 'old-p'])).toHaveLength(2);
    expect(await healPending({ ...env, DB: db } as never, B, C, NOW)).toEqual({ changed: true });
    expect(await keyOf('old')).toBe('p:old-p');
    expect(await visible(['old', 'old-p'])).toEqual([{ id: 'old', status: 'posted' }]);
    expect(await spent('p:old-p')).toBe(-4275);
    // Nothing left to heal: a second run changes nothing.
    expect(await healPending({ ...env, DB: db } as never, B, C, NOW)).toEqual({ changed: false });
  });

  it('a date or phone number in the bank text never blocks the pair (the same merchant); the next sync heals it', async () => {
    await sync([
      pend('ride-p', 18.5, '2026-11-09', 'LYFT *RIDE 11/09 855-865-9553', { merchant_entity_id: 'ent_lyft' }),
    ]);
    await sync([
      plaidTxn('ride', 'pa_card', 21.5, '2026-11-11', 'LYFT *RIDE SAN FRANCISCO CA', {
        merchant: 'Lyft',
        merchant_entity_id: 'ent_lyft',
        authorized_date: '2026-11-09',
      }),
    ]);
    expect(await keyOf('ride')).toBe('p:ride-p');
    expect(await visible(['ride', 'ride-p'])).toEqual([{ id: 'ride', status: 'posted' }]);
    // As the owner's rows were before the fix: both rows, unpaired. The next sync's heal step pairs them.
    await db.prepare(`UPDATE bank_txn SET txn_key = 'p:ride' WHERE provider_txn_id = 'ride'`).run();
    expect(await visible(['ride', 'ride-p'])).toHaveLength(2);
    expect(await healPending({ ...env, DB: db } as never, B, C, NOW)).toEqual({ changed: true });
    expect(await keyOf('ride')).toBe('p:ride-p');
    expect(await spent('p:ride-p')).toBe(-2150);
  });

  it('never pairs yesterday’s posted coffee with today’s pending one', async () => {
    await sync([pend('cof-p', 5, '2026-11-12', 'BLUE BOTTLE')]);
    await sync([
      plaidTxn('cof', 'pa_card', 5, '2026-11-12', 'SQ *BLUE BOTTLE', { authorized_date: '2026-11-11' }),
    ]);
    expect(await keyOf('cof')).toBe('p:cof');
    expect(await visible(['cof', 'cof-p'])).toHaveLength(2);
  });

  it('the provider’s link wins over a pair made without it: that posted row gets its own key back', async () => {
    await sync([pend('lk-p', 12, '2026-11-08', 'TACO SHOP')]);
    await sync([
      plaidTxn('lk-a', 'pa_card', 12, '2026-11-10', 'TACO SHOP', { authorized_date: '2026-11-08' }),
    ]);
    expect(await keyOf('lk-a')).toBe('p:lk-p');
    await sync([
      plaidTxn('lk-b', 'pa_card', 12, '2026-11-10', 'TACO SHOP', { pending_transaction_id: 'lk-p' }),
    ]);
    expect(await keyOf('lk-b')).toBe('p:lk-p');
    expect(await keyOf('lk-a')).toBe('p:lk-a');
  });
  it('a tip whose pending row has another Plaid name: "Same purchase?" asks; Yes pairs as an automatic pair would', async () => {
    await sync([pend('sk-p', 150, '2026-11-11', 'SUSHI KO')]);
    await categorize('p:sk-p', 'dining');
    expect(await together(['sk-p'])).toBe(-15000);
    await sync([
      plaidTxn('sk', 'pa_card', 185, '2026-11-12', 'SUSHI KO RESTAURANT', { authorized_date: '2026-11-11' }),
    ]);
    // No exact evidence (another name, another amount): both stay and count until you answer.
    expect(await keyOf('sk')).toBe('p:sk');
    expect(await together(['sk', 'sk-p'])).toBe(-15000 - 18500);
    const a = (await askOf('p:sk'))!;
    expect(JSON.parse(a.data)).toEqual({ candidates: ['p:sk-p'] });
    // The heal step asks the same question a live batch did, and writes nothing when it's already asked.
    expect(await heal()).toEqual({ changed: false });
    await db.prepare(`DELETE FROM alert WHERE id = ?1`).bind(a.id).run();
    await heal();
    const again = (await askOf('p:sk'))!;
    expect(again.data).toBe(a.data);
    const view = (await call('GET', '/api/activity?filter=attention')).json as ActivityView;
    const card = view.samePurchase.find((x) => x.id === again.id)!;
    expect(card.row.key).toBe('p:sk');
    expect(card.candidates.map((x) => x.key)).toEqual(['p:sk-p']);
    expect(
      (await call('POST', `/api/same-purchase/${again.id}`, { answer: 'yes', key: 'p:sk-p' })).status,
    ).toBe(200);
    await workOut(db, B, NOW);
    // As an automatic pair: the posted row takes the pending row's key, category and all; counted once.
    expect(await keyOf('sk')).toBe('p:sk-p');
    expect(await visible(['sk', 'sk-p'])).toEqual([{ id: 'sk', status: 'posted' }]);
    expect(await overlay('p:sk-p')).toMatchObject({ category_id: 'dining' });
    expect(await together(['sk', 'sk-p'])).toBe(-18500);
    expect(await askOf('p:sk')).toBeNull();
    // The bank removes its pending row later: still once.
    await sync([], [removal('sk-p')]);
    expect(await together(['sk', 'sk-p'])).toBe(-18500);
  });

  it('No to "Same purchase?" is remembered: never asked again, never paired, by a batch or the heal step', async () => {
    await sync([pend('fu-p', 300, '2026-11-12', 'GAS STATION A')]);
    await sync([
      plaidTxn('fu', 'pa_card', 310, '2026-11-13', 'FUEL STOP B', { authorized_date: '2026-11-12' }),
    ]);
    const a = (await askOf('p:fu'))!;
    expect(JSON.parse(a.data)).toEqual({ candidates: ['p:fu-p'] });
    expect((await call('POST', `/api/same-purchase/${a.id}`, { answer: 'no', key: 'p:fu-p' })).status).toBe(
      200,
    );
    expect(await askOf('p:fu')).toBeNull();
    await heal();
    await sync([pend('fu-other', 2, '2026-11-13', 'SOMETHING')]);
    expect(await askOf('p:fu')).toBeNull();
    expect(await keyOf('fu')).toBe('p:fu');
    expect(await together(['fu', 'fu-p'])).toBe(-30000 - 31000);
  });

  it('different merchant ids with the same amount on the same day still pair (exact evidence)', async () => {
    await sync([pend('br-p', 6.4, '2026-11-12', 'STARBUCKS 12345', { merchant_entity_id: 'ent_sb_1' })]);
    await sync([
      plaidTxn('br', 'pa_card', 6.4, '2026-11-13', 'STARBUCKS STORE 67890', {
        merchant_entity_id: 'ent_sb_2',
        authorized_date: '2026-11-12',
      }),
    ]);
    expect(await keyOf('br')).toBe('p:br-p');
    expect(await together(['br', 'br-p'])).toBe(-640);
  });
});
