// The device's local engine (D-45, src/local/engine.ts): a copy whose edits rebuild only what changed shows exactly
// the screens a fresh copy shows after taking every row and working it all out from scratch.
import { beforeAll, describe, expect, it } from 'vitest';
import { LocalEngine, RECORDED_TABLES } from '../src/local/engine.js';
import type { ActivityView } from '@ledgerline/contracts';
import { copyOf } from './copy-of.js';
import { deviceNow, everythingAgain, newCopy, seed } from './phone.js';

const SCREENS = (m: string) => [
  `/api/budget/${m}`,
  `/api/budget/${m}/assign`,
  '/api/activity',
  '/api/activity?filter=attention',
  '/api/activity?filter=pending',
  '/api/activity?q=groceries',
  '/api/accounts',
  `/api/reports?month=${m}`,
  '/api/owed',
  '/api/settings/categories',
  '/api/settings/payees',
];

/** A new device: takes every row of `engine`'s copy and works it all out from scratch (the reference). */
async function freshCopy(engine: LocalEngine): Promise<LocalEngine> {
  const e = await newCopy();
  await copyOf(engine.db, e, deviceNow(), RECORDED_TABLES);
  await e.derive();
  return e;
}

async function sameScreens(engine: LocalEngine, month: string) {
  const ref = await freshCopy(engine);
  for (const path of SCREENS(month))
    expect(await phoneJson(engine, path), path).toEqual(await phoneJson(ref, path));
}

async function phoneJson(engine: LocalEngine, path: string) {
  const r = await engine.request('GET', path);
  expect(r.status, `phone ${path}`).toBe(200);
  return r.json();
}

/** An edit on the device, as the app makes it. */
async function edit(engine: LocalEngine, path: string, body: unknown, method = 'POST') {
  const r = await engine.request(method, path, body);
  expect(r.status, `${method} ${path}`).toBeLessThan(300);
  return r.json();
}

describe('a device works out the same screens as a fresh copy', () => {
  let engine: LocalEngine;
  let month: string;
  let budgetId: string;
  /** Rows written into the copy directly, as a bank entry's would be: then everything is worked out again. */
  const direct = async (sql: string, ...values: unknown[]) => {
    await engine.db
      .prepare(sql)
      .bind(...values)
      .run();
    await everythingAgain(engine);
  };
  // The purchase the next test splits, and the category the test after it puts it back in.
  let split: { key: string; categoryId: string };

  beforeAll(async () => {
    engine = await seed(await newCopy());
    const session = (await phoneJson(engine, '/api/session')) as {
      budget: { id: string; currentMonth: string };
    };
    month = session.budget.currentMonth;
    budgetId = session.budget.id;
  });

  it('after it is worked out in full', async () => {
    await sameScreens(engine, month);
  });

  it('after edits, rebuilding only what changed', async () => {
    const cats = (await phoneJson(engine, '/api/settings/categories')) as {
      groups: { categories: { id: string; kind: string }[] }[];
    };
    const spending = cats.groups.flatMap((g) => g.categories).filter((c) => c.kind === 'spending');
    await edit(engine, '/api/budget/assign', {
      month,
      items: [{ categoryId: spending[0]!.id, amount: 1234 }],
    });
    const act = (await phoneJson(engine, '/api/activity')) as { posted: { key: string; amount: number }[] };
    const out = act.posted.find((r) => r.amount < 0)!;
    await edit(
      engine,
      `/api/transactions/${encodeURIComponent(out.key)}`,
      { categoryId: spending[1]!.id, memo: 'phone test' },
      'PATCH',
    );
    expect(await engine.needsDerive()).toBe(false);
    await sameScreens(engine, month);
  });

  it('after splits, a new pending row and moved money, rebuilding only what changed', async () => {
    const cats = (await phoneJson(engine, '/api/settings/categories')) as {
      groups: { categories: { id: string; kind: string }[] }[];
    };
    const spending = cats.groups.flatMap((g) => g.categories).filter((c) => c.kind === 'spending');
    const act = (await phoneJson(engine, '/api/activity')) as {
      posted: { key: string; amount: number; accountId: string }[];
    };
    const out = act.posted.filter((r) => r.amount < -200)[1]!;
    const half = Math.trunc(out.amount / 2);
    await edit(
      engine,
      `/api/transactions/${encodeURIComponent(out.key)}`,
      {
        split: [
          { categoryId: spending[2]!.id, amount: half, memo: null, absorbsRemainder: false },
          { categoryId: spending[3]!.id, amount: out.amount - half, memo: null, absorbsRemainder: true },
        ],
      },
      'PATCH',
    );
    await edit(engine, '/api/transactions', {
      kind: 'pending',
      accountId: out.accountId,
      date: '2026-11-13',
      amount: -4567,
      payee: 'Corner store',
      categoryId: spending[0]!.id,
      repeats: 'never',
    });
    await edit(engine, '/api/budget/move', {
      month,
      from: spending[0]!.id,
      to: spending[4]!.id,
      amount: 1000,
    });
    await sameScreens(engine, month);
    split = { key: out.key, categoryId: spending[1]!.id };
  });

  // Its own test: each check builds a fresh reference copy, and two in one test came near the 5 s limit under load.
  it('after a split is undone, rebuilding only what changed', async () => {
    await edit(
      engine,
      `/api/transactions/${encodeURIComponent(split.key)}`,
      { categoryId: split.categoryId },
      'PATCH',
    );
    await sameScreens(engine, month);
  });

  it('each edit is worked out at once, and answers with the new Ready to Assign', async () => {
    const cats = (await phoneJson(engine, '/api/settings/categories')) as {
      groups: { categories: { id: string; kind: string }[] }[];
    };
    const spending = cats.groups.flatMap((g) => g.categories).filter((c) => c.kind === 'spending');
    const act = (await phoneJson(engine, '/api/activity')) as { posted: { key: string; amount: number }[] };
    const [a, b] = act.posted.filter((r) => r.amount < 0);
    const edits: [string, string, unknown][] = [
      ['POST', '/api/budget/assign', { month, items: [{ categoryId: spending[5]!.id, amount: 777 }] }],
      ['POST', '/api/budget/move', { month, from: spending[5]!.id, to: 'rta', amount: 300 }],
      ['PATCH', `/api/transactions/${encodeURIComponent(a!.key)}`, { categoryId: spending[6]!.id }],
      ['POST', '/api/transactions/categorize', { keys: [b!.key], categoryId: spending[7]!.id }],
    ];
    for (const [method, path, body] of edits) {
      const r = await engine.request(method, path, body);
      expect(r.status, path).toBe(200);
      // The engine works out the change at once and answers with the new Ready to Assign.
      expect(((await r.json()) as { rta: number }).rta).toBe((await engine.rta()).rta);
      expect(await engine.needsDerive()).toBe(false);
    }
    await sameScreens(engine, month);
  });

  it('rename and join give the payee the key of its name', async () => {
    const list = (await phoneJson(engine, '/api/settings/payees')) as { payees: { id: string }[] };
    const [p0, p1, p2] = list.payees;
    const alias = (d: { prepare: typeof engine.db.prepare }, pattern: string) =>
      d
        .prepare(
          `SELECT a.id, a.payee_id, p.named_by FROM payee_alias a JOIN payee p ON p.id = a.payee_id WHERE a.pattern = ?1`,
        )
        .bind(pattern)
        .all<{ id: string; payee_id: string; named_by: string }>();
    // Renamed on the device: the copy has the key at once.
    const r = await engine.request('POST', `/api/settings/payees/${p0!.id}`, { name: 'Phone named' });
    expect(r.status).toBe(200);
    const local = (await alias(engine.db, 'n:phone named')).results;
    expect(local).toEqual([{ id: 'n:phone named', payee_id: p0!.id, named_by: 'user' }]);
    await edit(engine, '/api/settings/payees/merge', {
      keep: p1!.id,
      ids: [p1!.id, p2!.id],
      name: 'Joined name',
    });
    expect((await alias(engine.db, 'n:phone named')).results).toEqual(local);
    expect((await alias(engine.db, 'n:joined name')).results).toEqual([
      { id: 'n:joined name', payee_id: p1!.id, named_by: 'user' },
    ]);
    await sameScreens(engine, month);
  });

  it('an entry covering a bank pending row, "Same purchase?" and Not the same show the same on the phone', async () => {
    // Your entry for the card's pending Shell charge; the sync covers the bank row with it (docs/payee-names.md 9.2).
    const shell = await engine.db
      .prepare(`SELECT account_id FROM v_transaction WHERE key = 'n-shell'`)
      .first<{ account_id: string }>();
    await edit(engine, '/api/transactions', {
      kind: 'pending',
      accountId: shell!.account_id,
      date: '2026-11-14',
      amount: -4500,
      payee: 'Shell',
      categoryId: null,
      repeats: 'never',
    });
    const entry = (await engine.db
      .prepare(`SELECT txn_key FROM manual_pending WHERE payee_name = 'Shell' AND deleted_at IS NULL`)
      .first<{ txn_key: string }>())!.txn_key;
    await direct(`UPDATE manual_pending SET covers_provider_txn_id = 'n-shell' WHERE txn_key = ?1`, entry);
    // And a question about another pending row.
    await direct(
      `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at)
       VALUES ('al-same', ?1, 'same_purchase', 'n-uber', ?2, 0)`,
      budgetId,
      JSON.stringify({ candidates: [entry] }),
    );
    const pending = (await phoneJson(engine, '/api/activity?filter=pending')) as ActivityView;
    expect(pending.pending.map((r) => r.key)).toContain(entry);
    expect(pending.pending.map((r) => r.key)).not.toContain('n-shell');
    // The entry covers a row, so it's no candidate for another one.
    expect(((await phoneJson(engine, '/api/activity')) as ActivityView).samePurchase).toEqual([]);
    await sameScreens(engine, month);
    await edit(engine, `/api/transactions/${encodeURIComponent(entry)}/not-same`, {});
    const after = (await phoneJson(engine, '/api/activity')) as ActivityView;
    expect(after.pending.map((r) => r.key)).toContain('n-shell');
    expect(after.samePurchase.map((c) => [c.row.key, c.candidates.map((x) => x.key)])).toEqual([
      ['n-uber', [entry]],
    ]);
    await sameScreens(engine, month);
  });

  it('a posted row paired with a bank pending row, and Not the same, show the same on the phone', async () => {
    // A posted charge on the same card took the pending Shell row's key, paired by the app (D-65).
    const posted = (await engine.db
      .prepare(
        `SELECT b.provider_txn_id FROM bank_txn b JOIN bank_txn s ON s.provider_txn_id = 'n-shell'
         WHERE b.provider_account_id = s.provider_account_id AND b.pending = 0 AND b.removed_at IS NULL
           AND b.txn_key = b.provider_txn_id AND NOT EXISTS (SELECT 1 FROM txn_split t WHERE t.txn_key = b.txn_key)
         ORDER BY b.date DESC LIMIT 1`,
      )
      .first<{ provider_txn_id: string }>())!.provider_txn_id;
    await engine.db.batch([
      engine.db.prepare(`UPDATE bank_txn SET txn_key = 'n-shell' WHERE provider_txn_id = ?1`).bind(posted),
      engine.db
        .prepare(
          `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, created_by, created_at)
           VALUES ('lk-shell', ?1, 'pending_match', ?2, 'n-shell', 'auto', 0)`,
        )
        .bind(budgetId, `p:${posted}`),
    ]);
    await everythingAgain(engine);
    const before = (await phoneJson(engine, '/api/activity?filter=pending')) as ActivityView;
    expect(before.pending.map((r) => r.key)).not.toContain('n-shell');
    const sheet = (await phoneJson(engine, '/api/transactions/n-shell')) as { pairedWith: { label: string } };
    expect(sheet.pairedWith.label).toMatch(/^Bank pending: /);
    await sameScreens(engine, month);
    await edit(engine, '/api/transactions/n-shell/not-same', {});
    const after = (await phoneJson(engine, '/api/activity')) as ActivityView;
    expect(after.pending.map((r) => r.key)).toContain('n-shell');
    expect(after.posted.map((r) => r.key)).toContain(`p:${posted}`);
    await sameScreens(engine, month);
  });
});
