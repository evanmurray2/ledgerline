// The phone's local engine (D-45, src/local/engine.ts): a copy kept up to date from the change log, rebuilding only
// what changed, shows exactly the screens a fresh copy shows after downloading everything and working it all out.
// Offline edits made on the copy show what the server's copy shows once they're sent.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import type { SyncPage } from '../src/routes/sync.js';
import type { ActivityView } from '@ledgerline/contracts';
import { ownerDb, storeDb } from './store-db.js';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const api = async (path: string, init?: RequestInit) => SELF.fetch(`https://ledgerline.test${path}`, init);
const json = async (path: string) => {
  const r = await api(path);
  expect(r.status, path).toBe(200);
  return r.json();
};
const post = async (path: string, body: unknown, method = 'POST') => {
  const r = await api(path, { method, headers: H, body: JSON.stringify(body) });
  expect(r.status, `${method} ${path}`).toBeLessThan(300);
  return r.json();
};

async function syncAll(engine: LocalEngine): Promise<number> {
  let pages = 0;
  for (;;) {
    const { since, cursor } = await engine.nextRequest();
    const q = new URLSearchParams({ since: String(since), limit: '50' });
    if (cursor) q.set('cursor', cursor);
    const page = (await json(`/api/sync?${q}`)) as SyncPage;
    const r = await engine.apply(page);
    pages++;
    if (r.caughtUp) return pages;
    if (pages > 500) throw new Error('sync did not finish');
  }
}

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

let copies = 0;
/** A new phone: downloads everything and works it all out from scratch (the reference). */
async function freshCopy(budgetId: string): Promise<LocalEngine> {
  const db = storeDb(`fresh-copy-${++copies}`);
  await migrateLocal(db, Date.now());
  const e = new LocalEngine(db, { budgetId, userId: 'phone', email: 'owner@example.com' });
  await syncAll(e);
  await e.derive();
  return e;
}

async function sameScreens(engine: LocalEngine, month: string, budgetId: string) {
  const ref = await freshCopy(budgetId);
  for (const path of SCREENS(month))
    expect(await phoneJson(engine, path), path).toEqual(await phoneJson(ref, path));
}

async function phoneJson(engine: LocalEngine, path: string) {
  const r = await engine.request('GET', path);
  expect(r.status, `phone ${path}`).toBe(200);
  return r.json();
}

describe('the phone works out the same screens as the server', () => {
  let engine: LocalEngine;
  let month: string;
  let budgetId: string;
  // The purchase the next test splits, and the category the test after it puts it back in.
  let split: { key: string; categoryId: string };

  beforeAll(async () => {
    const seed = await api('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' });
    expect(seed.status).toBe(200);
    const session = (await json('/api/session')) as { budget: { id: string; currentMonth: string } };
    month = session.budget.currentMonth;
    budgetId = session.budget.id;
    const db = storeDb('phone-copy');
    await migrateLocal(db, Date.now());
    engine = new LocalEngine(db, {
      budgetId: session.budget.id,
      userId: 'phone',
      email: 'owner@example.com',
    });
  });

  it('after a full download', async () => {
    const pages = await syncAll(engine);
    expect(pages).toBeGreaterThan(1);
    await engine.derive();
    await sameScreens(engine, month, budgetId);
  });

  it('after changes on the server, from the change log alone', async () => {
    const cats = (await phoneJson(engine, '/api/settings/categories')) as {
      groups: { categories: { id: string; kind: string }[] }[];
    };
    const spending = cats.groups.flatMap((g) => g.categories).filter((c) => c.kind === 'spending');
    await post('/api/budget/assign', { month, items: [{ categoryId: spending[0]!.id, amount: 1234 }] });
    const act = (await phoneJson(engine, '/api/activity')) as { posted: { key: string; amount: number }[] };
    const out = act.posted.find((r) => r.amount < 0)!;
    await post(
      `/api/transactions/${encodeURIComponent(out.key)}`,
      { categoryId: spending[1]!.id, memo: 'phone test' },
      'PATCH',
    );
    const before = (await engine.state()).through;
    await syncAll(engine);
    expect((await engine.state()).through).toBeGreaterThan(before);
    await engine.derive();
    await sameScreens(engine, month, budgetId);
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
    await post(
      `/api/transactions/${encodeURIComponent(out.key)}`,
      {
        split: [
          { categoryId: spending[2]!.id, amount: half, memo: null, absorbsRemainder: false },
          { categoryId: spending[3]!.id, amount: out.amount - half, memo: null, absorbsRemainder: true },
        ],
      },
      'PATCH',
    );
    await post('/api/transactions', {
      kind: 'pending',
      accountId: out.accountId,
      date: '2026-11-13',
      amount: -4567,
      payee: 'Corner store',
      categoryId: spending[0]!.id,
      repeats: 'never',
    });
    await post('/api/budget/move', { month, from: spending[0]!.id, to: spending[4]!.id, amount: 1000 });
    await syncAll(engine);
    await engine.derive();
    await sameScreens(engine, month, budgetId);
    split = { key: out.key, categoryId: spending[1]!.id };
  });

  // Its own test: each check builds a fresh reference copy, and two in one test came near the 5 s limit under load.
  it('after a split is undone, rebuilding only what changed', async () => {
    await post(
      `/api/transactions/${encodeURIComponent(split.key)}`,
      { categoryId: split.categoryId },
      'PATCH',
    );
    await syncAll(engine);
    await engine.derive();
    await sameScreens(engine, month, budgetId);
  });

  it('offline edits on the copy show what a fresh copy shows once they are sent', async () => {
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
    // Sent to the server, a fresh copy shows the same screens (the edits are in both copies now).
    for (const [method, path, body] of edits) await post(path, body, method);
    await sameScreens(engine, month, budgetId);
  });

  it('rename and join give the payee the key of its name, on the phone as on the server', async () => {
    const list = (await phoneJson(engine, '/api/settings/payees')) as { payees: { id: string }[] };
    const [p0, p1, p2] = list.payees;
    const alias = (d: { prepare: typeof engine.db.prepare }, pattern: string) =>
      d
        .prepare(
          `SELECT a.id, a.payee_id, p.named_by FROM payee_alias a JOIN payee p ON p.id = a.payee_id WHERE a.pattern = ?1`,
        )
        .bind(pattern)
        .all<{ id: string; payee_id: string; named_by: string }>();
    // Renamed offline on the phone: the copy has the key at once, under the id the server will give it.
    const r = await engine.request('POST', `/api/settings/payees/${p0!.id}`, { name: 'Phone named' });
    expect(r.status).toBe(200);
    const local = (await alias(engine.db, 'n:phone named')).results;
    expect(local).toEqual([{ id: 'n:phone named', payee_id: p0!.id, named_by: 'user' }]);
    await post(`/api/settings/payees/${p0!.id}`, { name: 'Phone named' });
    expect((await alias(ownerDb(), 'n:phone named')).results).toEqual(local);
    await post('/api/settings/payees/merge', { keep: p1!.id, ids: [p1!.id, p2!.id], name: 'Joined name' });
    await syncAll(engine);
    expect((await alias(engine.db, 'n:phone named')).results).toEqual(local);
    expect((await alias(engine.db, 'n:joined name')).results).toEqual([
      { id: 'n:joined name', payee_id: p1!.id, named_by: 'user' },
    ]);
    await engine.derive();
    await sameScreens(engine, month, budgetId);
  });

  it('an entry covering a bank pending row, "Same purchase?" and Not the same show the same on the phone', async () => {
    // Your entry for the card's pending Shell charge; the sync covers the bank row with it (docs/payee-names.md 9.2).
    const shell = await ownerDb()
      .prepare(`SELECT account_id FROM v_transaction WHERE key = 'n-shell'`)
      .first<{ account_id: string }>();
    await post('/api/transactions', {
      kind: 'pending',
      accountId: shell!.account_id,
      date: '2026-11-14',
      amount: -4500,
      payee: 'Shell',
      categoryId: null,
      repeats: 'never',
    });
    const entry = (await ownerDb()
      .prepare(`SELECT txn_key FROM manual_pending WHERE payee_name = 'Shell' AND deleted_at IS NULL`)
      .first<{ txn_key: string }>())!.txn_key;
    await ownerDb()
      .prepare(`UPDATE manual_pending SET covers_provider_txn_id = 'n-shell' WHERE txn_key = ?1`)
      .bind(entry)
      .run();
    // And a question about another pending row.
    await ownerDb()
      .prepare(
        `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at)
         VALUES ('al-same', ?1, 'same_purchase', 'n-uber', ?2, 0)`,
      )
      .bind(budgetId, JSON.stringify({ candidates: [entry] }))
      .run();
    await syncAll(engine);
    await engine.derive();
    const pending = (await phoneJson(engine, '/api/activity?filter=pending')) as ActivityView;
    expect(pending.pending.map((r) => r.key)).toContain(entry);
    expect(pending.pending.map((r) => r.key)).not.toContain('n-shell');
    // The entry covers a row, so it's no candidate for another one.
    expect(((await phoneJson(engine, '/api/activity')) as ActivityView).samePurchase).toEqual([]);
    await sameScreens(engine, month, budgetId);
    await post(`/api/transactions/${encodeURIComponent(entry)}/not-same`, {});
    await syncAll(engine);
    await engine.derive();
    const after = (await phoneJson(engine, '/api/activity')) as ActivityView;
    expect(after.pending.map((r) => r.key)).toContain('n-shell');
    expect(after.samePurchase.map((c) => [c.row.key, c.candidates.map((x) => x.key)])).toEqual([
      ['n-uber', [entry]],
    ]);
    await sameScreens(engine, month, budgetId);
  });

  it('a posted row paired with a bank pending row, and Not the same, show the same on the phone', async () => {
    // A posted charge on the same card took the pending Shell row's key, paired by the app (D-65).
    const posted = (await ownerDb()
      .prepare(
        `SELECT b.provider_txn_id FROM bank_txn b JOIN bank_txn s ON s.provider_txn_id = 'n-shell'
         WHERE b.provider_account_id = s.provider_account_id AND b.pending = 0 AND b.removed_at IS NULL
           AND b.txn_key = b.provider_txn_id AND NOT EXISTS (SELECT 1 FROM txn_split t WHERE t.txn_key = b.txn_key)
         ORDER BY b.date DESC LIMIT 1`,
      )
      .first<{ provider_txn_id: string }>())!.provider_txn_id;
    await ownerDb().batch([
      ownerDb()
        .prepare(`UPDATE bank_txn SET txn_key = 'n-shell' WHERE provider_txn_id = ?1`)
        .bind(posted),
      ownerDb()
        .prepare(
          `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, created_by, created_at)
           VALUES ('lk-shell', ?1, 'pending_match', ?2, 'n-shell', 'auto', 0)`,
        )
        .bind(budgetId, `p:${posted}`),
    ]);
    await syncAll(engine);
    await engine.derive();
    const before = (await phoneJson(engine, '/api/activity?filter=pending')) as ActivityView;
    expect(before.pending.map((r) => r.key)).not.toContain('n-shell');
    const sheet = (await phoneJson(engine, '/api/transactions/n-shell')) as { pairedWith: { label: string } };
    expect(sheet.pairedWith.label).toMatch(/^Bank pending: /);
    await sameScreens(engine, month, budgetId);
    await post('/api/transactions/n-shell/not-same', {});
    await syncAll(engine);
    await engine.derive();
    const after = (await phoneJson(engine, '/api/activity')) as ActivityView;
    expect(after.pending.map((r) => r.key)).toContain('n-shell');
    expect(after.posted.map((r) => r.key)).toContain(`p:${posted}`);
    await sameScreens(engine, month, budgetId);
  });

  it('a new epoch throws the copy away', async () => {
    const st = await engine.state();
    const r = await engine.apply({
      format: st.format,
      epoch: 'e-restored',
      serverTime: Date.now(),
      through: 1,
      more: false,
      cursor: null,
      rows: [],
    });
    expect(r.reset).toBe(true);
    expect(await engine.nextRequest()).toEqual({ since: 0, cursor: null });
  });
});

describe('the server keeps nothing derived (D-45)', () => {
  it('answers changes without Ready to Assign, refuses screens, and logs every change', async () => {
    const session = (await json('/api/session')) as { budget: { id: string; currentMonth: string } };
    const m = session.budget.currentMonth;
    const cats = (await phoneJson(await freshCopy(session.budget.id), '/api/settings/categories')) as {
      groups: { categories: { id: string; kind: string }[] }[];
    };
    const cat = cats.groups.flatMap((g) => g.categories).find((c) => c.kind === 'spending')!;
    const through = ((await json('/api/sync?since=0&limit=500')) as SyncPage).through;
    const ack = await post('/api/budget/set', { month: m, categoryId: cat.id, assigned: 4321 });
    expect(ack).toEqual({ ok: true });
    const screen = await api(`/api/budget/${m}`);
    expect(screen.status).toBe(404);
    expect(((await screen.json()) as { error: string }).error).toBe('on_device');
    const page = (await json(`/api/sync?since=${through}`)) as SyncPage;
    const a = page.rows.find((r) => r.t === 'assignment' && r.k[2] === cat.id && r.k[1] === m);
    expect(a?.d).toMatchObject({ amount: 4321 });
  });

  it('every synced table has its change-log triggers', async () => {
    const { SYNC_TABLES, triggerNames } = await import('../src/sync-tables.js');
    const db = storeDb('trigger-check');
    const have = new Set(
      (
        await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all<{ name: string }>()
      ).results.map((r) => r.name),
    );
    for (const t of SYNC_TABLES) for (const n of triggerNames(t.name)) expect(have.has(n), n).toBe(true);
  });
});
