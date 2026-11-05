// The one-time re-file job (docs/payee-names.md 8.2, 8.3; src/sync/refile-payees.ts): payees made by the old rules
// (cleaned bank text, title case) become payees from Plaid's values, every existing transaction filed again in date
// order. Names you chose stay; money never changes.
import { env, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { CSRF_HEADER, type MergeResult } from '@ledgerline/contracts';
import { budgetStub, storeDb } from './store-db.js';
import { acquire } from '../src/sync/lease.js';
import { applyPage, beginRun, rawPageKey } from '../src/sync/steps.js';
import { processPending } from '../src/sync/process.js';
import { budgetApi } from '../src/routes/api.js';
import type { AppEnv } from '../src/http/context.js';
import {
  QUEUE_REFILE,
  REFILE_PAYEES_ID,
  REFILE_ROWS,
  refilePayeesStep,
  type RefileState,
} from '../src/sync/refile-payees.js';
import { FILL_PLAID_NAME_ID } from '../src/sync/fill-plaid-name.js';
import {
  DROP_TEXT_ALIASES_ID,
  DROP_TEXT_ALIASES_ROWS,
  QUEUE_DROP_TEXT_ALIASES,
} from '../src/sync/drop-text-aliases.js';

const STORE = 'refile-payees';
const db = storeDb(STORE);
const NOW = Date.parse('2026-11-14T20:00:00Z');
const provider = new PlaidProvider({ clientId: 'x', secret: 'y', env: 'sandbox' });
const B = 'b_refile';
const C = 'con_refile';

function plaidTxn(id: string, amount: number, raw: string, name: string, o: Record<string, unknown> = {}) {
  return {
    transaction_id: id,
    account_id: 'pa_card',
    amount,
    date: '2026-11-01',
    authorized_date: null,
    pending: false,
    pending_transaction_id: null,
    name,
    original_description: raw,
    merchant_name: null,
    merchant_entity_id: null,
    payment_channel: 'online',
    personal_finance_category: null,
    iso_currency_code: 'USD',
    ...o,
  };
}

let runN = 0;
async function sync(added: unknown[], modified: unknown[] = []): Promise<void> {
  const run = `run_rf_${++runN}`;
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

/** The app's own routes on this store (as the phone's engine runs them). */
const routes = new Hono<AppEnv>();
routes.use('*', async (c, next) => {
  c.set('requestId', 'test');
  c.set('userId', 'owner');
  c.set('budgetId', B);
  c.set('email', 'owner@example.com');
  c.set('sessionId', '');
  c.set('syncEpoch', 'test');
  return next();
});
routes.route('/api', budgetApi);
const post = (path: string, body: unknown) =>
  routes.fetch(
    new Request(`https://engine.local/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1', origin: 'https://engine.local' },
      body: JSON.stringify(body),
    }),
    {
      DB: db,
      PLAID_ENV: 'engine',
      USAGE: async () => ({
        written: 0,
        read: 0,
        do: { requests: 0, gbs: 0 },
        workers: 0,
        refreshedAt: null,
      }),
      JOBS: { sync: async () => undefined },
    } as never,
    { waitUntil: () => undefined, passThroughOnException() {} } as never,
  );

/**
 * The payees as the old rules made them: one per cleaned bank text (or merchant id), named after the merchant name
 * or the cleaned text in title case, with a `d:` (or `m:`) alias, and named_by 'user' as migration 0007 left them.
 */
async function asOldRulesMadeThem(): Promise<void> {
  const rows = (
    await db
      .prepare(
        `SELECT b.txn_key, b.raw_name, b.merchant_name, b.merchant_entity_id FROM bank_txn b WHERE b.budget_id = ?1 ORDER BY b.first_apply_seq`,
      )
      .bind(B)
      .all<{
        txn_key: string;
        raw_name: string;
        merchant_name: string | null;
        merchant_entity_id: string | null;
      }>()
  ).results;
  const title = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase());
  // The old rules' cleaned text, enough for these rows (the app no longer cleans bank text).
  const oldText = (raw: string) =>
    raw
      .toUpperCase()
      .replace(/\s+[A-Z][A-Z .'-]*\sCA$/, '')
      .replace(/\.COM\b.*$/, '')
      .replace(/#?\d+|\*+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const stmts = [
    db.prepare(`UPDATE txn_overlay SET payee_id = NULL WHERE budget_id = ?1`).bind(B),
    db.prepare(`DELETE FROM payee_alias WHERE budget_id = ?1`).bind(B),
    db.prepare(`DELETE FROM payee WHERE budget_id = ?1`).bind(B),
  ];
  const made = new Map<string, string>();
  for (const r of rows) {
    const key = r.merchant_entity_id
      ? `m:${r.merchant_entity_id}`
      : `d:${oldText(r.raw_name).replace(/\s/g, '')}`;
    let id = made.get(key);
    if (!id) {
      id = `old_${made.size}`;
      made.set(key, id);
      stmts.push(
        db
          .prepare(
            `INSERT INTO payee (id, budget_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0)`,
          )
          .bind(id, B, r.merchant_name ?? title(oldText(r.raw_name))),
        db
          .prepare(
            `INSERT INTO payee_alias (id, budget_id, pattern, merchant_entity_id, payee_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 0)`,
          )
          .bind(`alias_${id}`, B, key.startsWith('d:') ? key.slice(2) : null, r.merchant_entity_id, id),
      );
    }
    stmts.push(db.prepare(`UPDATE txn_overlay SET payee_id = ?2 WHERE txn_key = ?1`).bind(r.txn_key, id));
  }
  await db.batch(stmts);
}

/**
 * A join as the old release recorded it: no named_by and no added key in its audit row. `first` is how the first
 * release recorded it, as in the owner's data: `before` is the JSON text 'null' and `after` has no `keep`.
 */
async function oldJoin(keep: string, other: string, name?: string, first = false): Promise<string> {
  const r = await post('/settings/payees/merge', { keep, ids: [keep, other], ...(name ? { name } : {}) });
  expect(r.status, await r.clone().text()).toBe(200);
  const { undoId } = (await r.json()) as MergeResult;
  await db.batch([
    db
      .prepare(
        `UPDATE audit_log SET before = json_remove(before, '$.namedBy', '$.added') WHERE action = 'payee.merge' AND entity_id = ?1`,
      )
      .bind(undoId),
    ...(first
      ? [
          db
            .prepare(
              `UPDATE audit_log SET before = 'null', after = json_remove(after, '$.keep') WHERE action = 'payee.merge' AND entity_id = ?1`,
            )
            .bind(undoId),
        ]
      : []),
    db.prepare(`UPDATE payee SET named_by = 'user' WHERE budget_id = ?1`).bind(B),
    db.prepare(`DELETE FROM payee_alias WHERE pattern LIKE 'n:%'`),
  ]);
  return undoId;
}

const payeeOf = async (providerId: string) =>
  db
    .prepare(
      `SELECT p.id, p.name, p.named_by FROM bank_txn b JOIN txn_overlay o ON o.txn_key = b.txn_key
       JOIN payee p ON p.id = o.payee_id WHERE b.provider_txn_id = ?1`,
    )
    .bind(providerId)
    .first<{ id: string; name: string; named_by: string }>();

/** Everything about each transaction but its payee. */
const money = async () =>
  (
    await db
      .prepare(
        `SELECT o.txn_key, o.category_id, o.categorized_by, o.memo, o.budget_month, o.to_rta, o.transfer_state, o.wtm_state,
           o.estimated_amount, o.wont_clear, (SELECT count(*) FROM txn_split t WHERE t.txn_key = o.txn_key) AS splits,
           (SELECT count(*) FROM expected_reimbursement e WHERE e.txn_key = o.txn_key) AS owed
         FROM txn_overlay o WHERE o.budget_id = ?1 ORDER BY o.txn_key`,
      )
      .bind(B)
      .all()
  ).results;

async function runJob(state: RefileState = {}): Promise<number> {
  let steps = 0;
  for (;;) {
    const r = await refilePayeesStep(db, B, REFILE_PAYEES_ID, state, NOW);
    steps++;
    if (r.done) break;
    expect(r.runAt).toBe(NOW);
    state = r.state;
    if (steps > 200) throw new Error('job did not finish');
  }
  await db.prepare(`DELETE FROM job WHERE id = ?1`).bind(REFILE_PAYEES_ID).run();
  return steps;
}

describe('the payee re-file job', () => {
  let hluUndo: string;
  let gas: string;
  let picked: string;

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
          `INSERT INTO account (id, budget_id, provider_account_id, name, kind, budget_from, starting_balance, created_at, updated_at) VALUES ('a_card_rf', ?1, 'pa_card', 'Card', 'credit', '2026-10-01', 0, 0, 0)`,
        )
        .bind(B),
      db
        .prepare(
          `INSERT INTO category (id, budget_id, name, kind, created_at, updated_at) VALUES ('fun_rf', ?1, 'Fun', 'spending', 0, 0)`,
        )
        .bind(B),
    ]);
    // Nov 1, first link: Plaid's enrichment isn't done, so no merchant names.
    await sync([
      plaidTxn('hulu-a', 17.99, 'HLU*HULUPLUS HULU.COM/BILL CA', 'Hlu Huluplus'),
      plaidTxn('hulu-b', 7.99, 'HULU SANTA MONICA CA', 'Hulu Santa Monica', { date: '2026-11-02' }),
      plaidTxn('gas-1', 40, 'SHELL OIL 5744 OAKLAND CA', 'Shell'),
      plaidTxn('gas-2', 41, 'SHELL OIL 9911 BERKELEY CA', 'Shell', { date: '2026-11-03' }),
      plaidTxn('cafe-1', 4, 'BLUE BOTTLE 01', 'Blue Bottle Coffee'),
      plaidTxn('cafe-2', 5, 'BLUEBOTTLE COFFEE', 'Blue Bottle Coffee', { date: '2026-11-04' }),
    ]);
    // The old rules made payees from the cleaned text.
    await asOldRulesMadeThem();
    // Nov 2, six hours later: the same rows again, now with Hulu's merchant name and id; a filed row never moves.
    await sync(
      [],
      [
        plaidTxn('hulu-a', 17.99, 'HLU*HULUPLUS HULU.COM/BILL CA', 'Hlu Huluplus', {
          merchant_name: 'Hulu',
          merchant_entity_id: 'ent_hulu',
        }),
        plaidTxn('hulu-b', 7.99, 'HULU SANTA MONICA CA', 'Hulu Santa Monica', {
          date: '2026-11-02',
          merchant_name: 'Hulu',
          merchant_entity_id: 'ent_hulu',
        }),
      ],
    );
    const a = (await payeeOf('hulu-a'))!;
    const b = (await payeeOf('hulu-b'))!;
    expect([a.name, b.name]).toEqual(['Hlu Huluplus Hulu', 'Hulu']);
    // Nov 2, a merge under the name the app had made.
    hluUndo = await oldJoin(a.id, b.id, undefined, true);
    // A payee you renamed, and a join under a name you picked.
    gas = (await payeeOf('gas-1'))!.id;
    expect((await post(`/settings/payees/${gas}`, { name: 'My gas' })).status).toBe(200);
    const c1 = (await payeeOf('cafe-1'))!.id;
    const c2 = (await payeeOf('cafe-2'))!.id;
    expect(c1).not.toBe(c2);
    await oldJoin(c1, c2, 'Coffee shop');
    picked = c1;
    await db.prepare(`UPDATE payee SET named_by = 'user' WHERE budget_id = ?1`).bind(B).run();
    // Your edits on a transaction the job moves.
    await db
      .prepare(
        `UPDATE txn_overlay SET category_id = 'fun_rf', categorized_by = 'user', memo = 'tv' WHERE txn_key = (SELECT txn_key FROM bank_txn WHERE provider_txn_id = 'hulu-b')`,
      )
      .run();
  });

  it('waits for the plaid_name fill and for processing to catch up', async () => {
    await db
      .prepare(
        `INSERT INTO job (id, kind, state, run_at, created_at, updated_at) VALUES (?1, 'fill_plaid_name', '{}', 0, 0, 0)`,
      )
      .bind(FILL_PLAID_NAME_ID)
      .run();
    const r = await refilePayeesStep(db, B, REFILE_PAYEES_ID, {}, NOW);
    expect(r).toMatchObject({ done: false, state: {}, runAt: NOW + 60_000 });
    await db.prepare(`DELETE FROM job WHERE id = ?1`).bind(FILL_PLAID_NAME_ID).run();
    await db
      .prepare(`UPDATE budget SET processed_through = processed_through - 1 WHERE id = ?1`)
      .bind(B)
      .run();
    expect(await refilePayeesStep(db, B, REFILE_PAYEES_ID, {}, NOW)).toMatchObject({ runAt: NOW + 60_000 });
    await db
      .prepare(`UPDATE budget SET processed_through = processed_through + 1 WHERE id = ?1`)
      .bind(B)
      .run();
  });

  it('files every transaction again: Hulu ends as one payee named Hulu; your names and money stay', async () => {
    const before = await money();
    await runJob();
    const a = (await payeeOf('hulu-a'))!;
    expect(a).toMatchObject({ name: 'Hulu', named_by: 'sync' });
    expect((await payeeOf('hulu-b'))!.id).toBe(a.id);
    // The renamed payee keeps its name, its transactions and the key of its name.
    expect(await payeeOf('gas-1')).toMatchObject({ id: gas, name: 'My gas', named_by: 'user' });
    expect((await payeeOf('gas-2'))!.id).toBe(gas);
    const key = await db
      .prepare(`SELECT payee_id FROM payee_alias WHERE pattern = 'n:my gas'`)
      .first<{ payee_id: string }>();
    expect(key?.payee_id).toBe(gas);
    // A join under a name you picked is yours too.
    expect(await payeeOf('cafe-1')).toMatchObject({ id: picked, name: 'Coffee shop', named_by: 'user' });
    expect((await payeeOf('cafe-2'))!.id).toBe(picked);
    expect(await money()).toEqual(before);
    // The emptied payee points at the one its rows went to.
    const left = await db
      .prepare(
        `SELECT count(*) AS n FROM payee WHERE budget_id = ?1 AND merged_into IS NULL AND name LIKE 'Hlu%'`,
      )
      .bind(B)
      .first<{ n: number }>();
    expect(left!.n).toBe(0);
    const audit = await db
      .prepare(`SELECT after FROM audit_log WHERE action = 'payee.refile'`)
      .all<{ after: string }>();
    expect(audit.results).toHaveLength(1);
    expect(JSON.parse(audit.results[0]!.after)).toMatchObject({ userPayees: 2, filed: 2 });
    // The next Hulu row finds the payee by its keys.
    await sync([plaidTxn('hulu-c', 17.99, 'HLU*HULUPLUS HULU.COM/BILL CA', 'Hulu', { date: '2026-12-01' })]);
    expect((await payeeOf('hulu-c'))!.id).toBe(a.id);
  });

  it('refuses Undo of a join made before it', async () => {
    const r = await post(`/settings/payees/merge/${hluUndo}/undo`, {});
    expect(r.status).toBe(409);
    expect(((await r.json()) as { message?: string }).message ?? '').toMatch(/changed since/);
  });

  it('is restartable: a step run again, or the whole job run again, changes nothing', async () => {
    const payees = async () =>
      (
        await db
          .prepare(
            `SELECT o.txn_key, o.payee_id, p.name FROM txn_overlay o JOIN payee p ON p.id = o.payee_id ORDER BY o.txn_key`,
          )
          .all()
      ).results;
    const was = await payees();
    await runJob();
    expect(await payees()).toEqual(was);
    // Each step's state is in its own batch: run the refile step twice from the same state.
    const st: RefileState = { phase: 'refile', moves: {} };
    await refilePayeesStep(db, B, REFILE_PAYEES_ID, st, NOW);
    await refilePayeesStep(db, B, REFILE_PAYEES_ID, st, NOW);
    expect(await payees()).toEqual(was);
  });

  it('files in chunks of REFILE_ROWS, in date order', async () => {
    await sync(
      Array.from({ length: REFILE_ROWS + 5 }, (_, i) =>
        plaidTxn(`many-${i}`, 1 + i, `STORE ${i % 3} #${i}`, `Store ${i % 3} #${i}`, {
          date: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`,
          merchant_name: `Store ${i % 3}`,
        }),
      ),
    );
    await asOldRulesMadeThem();
    const steps = await runJob();
    expect(steps).toBeGreaterThanOrEqual(6);
    const named = await db
      .prepare(
        `SELECT DISTINCT p.name FROM bank_txn b JOIN txn_overlay o ON o.txn_key = b.txn_key JOIN payee p ON p.id = o.payee_id WHERE b.provider_txn_id LIKE 'many-%' ORDER BY p.name`,
      )
      .all<{ name: string }>();
    expect(named.results.map((r) => r.name)).toEqual(['Store 0', 'Store 1', 'Store 2']);
  });

  it('is queued once: where old payees exist and it hasn’t run, by the store at start and by the fill', async () => {
    const queue = (store: string) =>
      runInDurableObject(budgetStub(store), async (_o, st) => {
        st.storage.sql.exec(QUEUE_REFILE, NOW);
        return st.storage.sql.exec(`SELECT id FROM job WHERE id = ?`, REFILE_PAYEES_ID).toArray().length;
      });
    // This store has run it (its audit row): not again.
    expect(await queue(STORE)).toBe(0);
    // A new store, with no old payees: never.
    expect(await queue('refile-new')).toBe(0);
    // Old payees and no audit row: queued, once.
    const old = budgetStub('refile-old');
    await runInDurableObject(old, async (_o, st) => {
      st.storage.sql.exec(
        `INSERT INTO budget (id, name, created_at, updated_at) VALUES ('b_old', 'B', 0, 0)`,
      );
      st.storage.sql.exec(
        `INSERT INTO payee (id, budget_id, name, created_at, updated_at) VALUES ('p1', 'b_old', 'Shell', 0, 0)`,
      );
      st.storage.sql.exec(
        `INSERT INTO payee_alias (id, budget_id, pattern, payee_id, created_at) VALUES ('a1', 'b_old', 'SHELLOIL', 'p1', 0)`,
      );
    });
    expect(await queue('refile-old')).toBe(1);
    expect(await queue('refile-old')).toBe(1);
    // The fill job queues it when it finishes.
    await runInDurableObject(old, async (o, st) => {
      st.storage.sql.exec(`DELETE FROM job WHERE id = ?`, REFILE_PAYEES_ID);
      st.storage.sql.exec(
        `INSERT INTO job (id, kind, state, run_at, created_at, updated_at) VALUES (?, 'fill_plaid_name', '{}', 0, 0, 0)`,
        FILL_PLAID_NAME_ID,
      );
      await o.alarm();
      expect(
        st.storage.sql.exec(`SELECT id FROM job WHERE id = ?`, FILL_PLAID_NAME_ID).toArray(),
      ).toHaveLength(0);
      expect(st.storage.sql.exec(`SELECT id FROM job WHERE id = ?`, REFILE_PAYEES_ID).toArray()).toHaveLength(
        1,
      );
    });
  });
  it('then the old cleaned-text aliases go: queued once the job is done, deleted a step at a time', async () => {
    const store = budgetStub('drop-text-aliases');
    const n = DROP_TEXT_ALIASES_ROWS + 20;
    const left = await runInDurableObject(store, async (o, st) => {
      const sql = st.storage.sql;
      sql.exec(`INSERT INTO budget (id, name, created_at, updated_at) VALUES ('b_drop', 'B', 0, 0)`);
      sql.exec(
        `INSERT INTO payee (id, budget_id, name, created_at, updated_at) VALUES ('p1', 'b_drop', 'Shell', 0, 0)`,
      );
      for (let i = 0; i < n; i++)
        sql.exec(
          `INSERT INTO payee_alias (id, budget_id, pattern, payee_id, created_at) VALUES (?, 'b_drop', ?, 'p1', 0)`,
          `old_${i}`,
          `SHELLOIL${i}`,
        );
      sql.exec(
        `INSERT INTO payee_alias (id, budget_id, pattern, merchant_entity_id, payee_id, created_at) VALUES
           ('n:shell', 'b_drop', 'n:shell', NULL, 'p1', 0), ('m_old', 'b_drop', NULL, 'ent_shell', 'p1', 0)`,
      );
      const queued = () => sql.exec(`SELECT id FROM job WHERE id = ?`, DROP_TEXT_ALIASES_ID).toArray().length;
      // Not while the re-file job hasn't finished (QUEUE_REFILE still needs them).
      sql.exec(QUEUE_DROP_TEXT_ALIASES, NOW);
      expect(queued()).toBe(0);
      // The re-file job's last step: its audit row, then the job queues the deletion as it ends.
      sql.exec(
        `INSERT INTO audit_log (budget_id, action, entity, created_at) VALUES ('b_drop', 'payee.refile', 'payee', 0)`,
      );
      sql.exec(
        `INSERT INTO job (id, kind, state, run_at, created_at, updated_at) VALUES (?, 'refile_payees', '{"phase":"done"}', 0, 0, 0)`,
        REFILE_PAYEES_ID,
      );
      for (
        let i = 0;
        i < 10 &&
        sql.exec(`SELECT 1 FROM job WHERE failed_at IS NULL AND run_at <= ?`, Date.now()).toArray().length;
        i++
      )
        await o.alarm();
      expect(sql.exec(`SELECT id FROM job`).toArray()).toEqual([]);
      // Queued once only: the job row is gone and nothing is left to delete.
      sql.exec(QUEUE_DROP_TEXT_ALIASES, NOW);
      expect(queued()).toBe(0);
      return sql
        .exec(`SELECT id FROM payee_alias ORDER BY id`)
        .toArray()
        .map((r) => r.id);
    });
    // The `n:` key and the merchant id stay; every cleaned-text pattern is gone, and the phone is told.
    expect(left).toEqual(['m_old', 'n:shell']);
    const logged = await runInDurableObject(store, async (_o, st) =>
      st.storage.sql
        .exec(`SELECT count(*) AS n FROM change_log WHERE tbl = 'payee_alias' AND deleted = 1`)
        .one(),
    );
    expect(logged.n).toBe(n);
  });
});
