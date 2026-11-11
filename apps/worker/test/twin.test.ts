// Every edit the phone may make offline, run as a twin (test/twin.ts): the phone's rows equal the server's.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LocalEngine } from '../src/local/engine.js';
import { budgetApi } from '../src/routes/api.js';
import { syncPhone } from './phone.js';
import { differences, newPhone, rowsOf, twin } from './twin.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };

describe('the same edit on the phone and on the server', () => {
  let a: LocalEngine;
  let b: LocalEngine;
  let spending: string[];
  let txn: string;
  let payee: string;
  const month = '2026-11';

  beforeAll(async () => {
    const r = await SELF.fetch(`${ORIGIN}/__dev/seed-november`, { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(200);
    a = await syncPhone(await newPhone());
    b = await syncPhone(await newPhone());
    const cats = (await (await a.request('GET', '/api/settings/categories')).json()) as {
      groups: { categories: { id: string; kind: string }[] }[];
    };
    spending = cats.groups
      .flatMap((g) => g.categories)
      .filter((c) => c.kind === 'spending')
      .map((c) => c.id);
    txn = (await a.db
      .prepare(
        `SELECT txn_key FROM bank_txn WHERE removed_at IS NULL AND pending = 0 ORDER BY txn_key LIMIT 1`,
      )
      .first<{ txn_key: string }>())!.txn_key;
    payee = (await a.db.prepare(`SELECT id FROM payee ORDER BY id LIMIT 1`).first<{ id: string }>())!.id;
  });

  it('two synced copies start equal', async () => {
    expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
  });

  type Case = [string, string, unknown];
  /** Name, the route it covers (as Hono names it), and the request. They run in this order on one budget. */
  const cases: [string, string, () => Case | Promise<Case>][] = [
    [
      'assign',
      'POST /budget/assign',
      () => ['POST', '/api/budget/assign', { month, items: [{ categoryId: spending[0], amount: 1234 }] }],
    ],
    [
      'set',
      'POST /budget/set',
      () => ['POST', '/api/budget/set', { month, categoryId: spending[1], assigned: 4321 }],
    ],
    [
      'move',
      'POST /budget/move',
      () => ['POST', '/api/budget/move', { month, from: spending[0], to: spending[2], amount: 200 }],
    ],
    [
      'a new target',
      'PUT /categories/:id/target',
      () => [
        'PUT',
        `/api/categories/${spending[3]}/target`,
        { categoryId: spending[3], month: '2027-02', target: { type: 'set_aside', amount: 999 } },
      ],
    ],
    [
      'pin',
      'POST /settings/categories/:id/pin',
      () => ['POST', `/api/settings/categories/${spending[4]}/pin`, { pinned: true }],
    ],
    [
      'rename a payee',
      'POST /settings/payees/:id',
      () => ['POST', `/api/settings/payees/${payee}`, { name: 'Twin named' }],
    ],
    [
      'categorize',
      'POST /transactions/categorize',
      () => ['POST', '/api/transactions/categorize', { keys: [txn], categoryId: spending[5] }],
    ],
    [
      'a note on a transaction',
      'PATCH /transactions/:key',
      () => ['PATCH', `/api/transactions/${txn}`, { note: 'twin' }],
    ],
    // An edit that depends on a balance: the phone sends what it showed and the change number its copy held
    // (http/through.ts). The copy checks its own number, the server its change log.
    [
      'archive a category that holds money',
      'POST /settings/categories/:id/archive',
      async () => [
        'POST',
        `/api/settings/categories/${spending[7]}/archive`,
        { archived: true, available: 500, through: (await a.state()).through },
      ],
    ],
    // Edits that make rows: the ids come from the edit's own id (http/ids.ts).
    [
      'a new category',
      'POST /settings/categories',
      () => ['POST', '/api/settings/categories', { name: 'Twin category', groupId: null, kind: 'spending' }],
    ],
    [
      'a new group',
      'POST /settings/groups',
      () => ['POST', '/api/settings/groups', { name: 'Twin group', isBills: false }],
    ],
    [
      'groups in another order',
      'POST /settings/groups/reorder',
      async () => ['POST', '/api/settings/groups/reorder', { ids: (await ids('category_group')).reverse() }],
    ],
    [
      'categories in another order',
      'POST /settings/categories/reorder',
      () => ['POST', '/api/settings/categories/reorder', { ids: [spending[2], spending[1], spending[0]] }],
    ],
    [
      'remove the new category',
      'POST /settings/categories/:id/remove',
      async () => ['POST', `/api/settings/categories/${await named('category', 'Twin category')}/remove`, {}],
    ],
    [
      'remove the new group',
      'POST /settings/groups/:id/remove',
      async () => ['POST', `/api/settings/groups/${await named('category_group', 'Twin group')}/remove`, {}],
    ],
    [
      'rename an account',
      'POST /accounts/:id/name',
      async () => ['POST', `/api/accounts/${(await ids('account'))[0]}/name`, { name: 'Twin account' }],
    ],
    ['a setting', 'PATCH /settings', () => ['PATCH', '/api/settings', { noteButton: true }]],
    [
      'an entry added by hand',
      'POST /transactions',
      async () => [
        'POST',
        '/api/transactions',
        {
          kind: 'pending',
          accountId: (await ids('account'))[0],
          date: '2026-11-10',
          amount: -1234,
          payee: 'Twin cafe',
          categoryId: spending[0],
          repeats: 'never',
        },
      ],
    ],
    [
      'delete that entry',
      'DELETE /transactions/:key',
      async () => [
        'DELETE',
        `/api/transactions/${
          (await a.db
            .prepare(
              `SELECT txn_key FROM manual_pending WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
            )
            .first<{ txn_key: string }>())!.txn_key
        }`,
        undefined,
      ],
    ],
  ];

  const ids = async (table: string) =>
    (await a.db.prepare(`SELECT id FROM ${table} ORDER BY id`).all<{ id: string }>()).results.map(
      (r) => r.id,
    );
  const named = async (table: string, name: string) =>
    (await a.db.prepare(`SELECT id FROM ${table} WHERE name = ?1`).bind(name).first<{ id: string }>())!.id;

  for (const [name, , make] of cases)
    it(name, async () => {
      const [method, path, body] = await make();
      const t = await twin(a, b, method, path, body);
      expect(t.phone.status, await t.phone.clone().text()).toBeLessThan(300);
      expect(t.differences).toEqual([]);
      // The phone that made the edit takes the server's rows next: nothing changes for it.
      await syncPhone(a);
      expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
    });

  // Undo reads the record of the join (audit_log), which is not synced: each side wrote its own when it ran the
  // join, under the same id (the edit's), so the undo finds it on both.
  it('join two payees, then undo', async () => {
    const two = (
      await a.db
        .prepare(`SELECT id FROM payee WHERE merged_into IS NULL AND id != ?1 ORDER BY id LIMIT 2`)
        .bind(payee)
        .all<{ id: string }>()
    ).results.map((r) => r.id);
    const joined = await twin(a, b, 'POST', '/api/settings/payees/merge', { ids: two, keep: two[0] });
    expect(joined.phone.status, await joined.phone.clone().text()).toBe(200);
    expect(joined.differences).toEqual([]);
    const onPhone = (await joined.phone.json()) as { undoId: string };
    const onServer = (await joined.server.json()) as { undoId: string };
    expect(onPhone.undoId).toBe(onServer.undoId);
    // No sync in between yet: the undo checks that the payees' times are the join's, and the server's rows carry
    // the server's time until an edit's own time is used on both sides (docs/build-plan.md, "edit time").
    const undone = await twin(a, b, 'POST', `/api/settings/payees/merge/${onPhone.undoId}/undo`, {});
    expect(undone.phone.status, await undone.phone.clone().text()).toBe(200);
    expect(undone.differences).toEqual([]);
    const back = await a.db
      .prepare(`SELECT count(*) AS n FROM payee WHERE id IN (?1, ?2) AND merged_into IS NULL`)
      .bind(two[0], two[1])
      .first<{ n: number }>();
    expect(back!.n).toBe(2);
    await syncPhone(a);
  });

  it('both sides refuse a balance edit worked out before the newest change', async () => {
    const stale = (await a.state()).through - 1;
    const t = await twin(a, b, 'POST', `/api/settings/categories/${spending[8]}/archive`, {
      archived: true,
      available: 500,
      through: stale,
    });
    expect(t.phone.status).toBe(409);
    expect(t.differences).toEqual([]);
  });

  it('the check sees an edit that only one side has', async () => {
    const r = await a.request('POST', '/api/budget/set', { month, categoryId: spending[6], assigned: 77 });
    expect(r.status).toBe(200);
    const d = differences(await rowsOf(a), await rowsOf(b));
    expect(d.length).toBeGreaterThan(0);
    expect(d.join('\n')).toContain('assignment');
  });

  // Every edit the API has is in one list: checked as a twin here, never run on a phone, or not checked yet.
  it('no edit route is missing from the lists', () => {
    const routes = new Set<string>();
    for (const r of budgetApi.routes)
      if (!['GET', 'HEAD', 'ALL'].includes(r.method)) routes.add(`${r.method} ${r.path}`);
    const listed = new Set([
      ...cases.map(([, route]) => route),
      ...OTHER_TWINS,
      ...Object.keys(SERVER_ONLY),
      ...Object.keys(NOT_YET),
    ]);
    expect([...routes].filter((r) => !listed.has(r)).sort()).toEqual([]);
    expect([...listed].filter((r) => !routes.has(r)).sort()).toEqual([]);
    const twinned = new Set([...cases.map(([, route]) => route), ...OTHER_TWINS]);
    expect([...Object.keys(SERVER_ONLY), ...Object.keys(NOT_YET)].filter((r) => twinned.has(r))).toEqual([]);
  });
});

/** Twins with their own test above (more than one request). */
const OTHER_TWINS = ['POST /settings/payees/merge', 'POST /settings/payees/merge/:undoId/undo'];

/** Never run on a phone's copy: they need the server (the bank, sign-in, the server's own records). */
const SERVER_ONLY: Record<string, string> = {
  'POST /settings/connections/link-token': 'the bank link (Plaid)',
  'POST /settings/connections/link-finish': 'the bank link (Plaid)',
  'POST /settings/connections/exchange': 'the bank link (Plaid)',
  'POST /settings/connections/refresh': 'asks the server to fetch from the banks',
  'POST /settings/connections/:id/refresh': 'asks the server to fetch from the banks',
  'POST /webhooks/plaid': 'Plaid calls the server',
  'POST /settings/security/device-link': 'sign-in',
  'POST /settings/security/devices': 'sign-in',
  'POST /settings/security/devices/:id/share': 'sign-in',
  'POST /settings/security/passkeys/:id/remove': 'sign-in',
  'POST /settings/security/passkeys/:id/rename': 'sign-in',
  'POST /settings/security/sign-out': 'sign-in',
  'POST /settings/security/sign-out-others': 'sign-in',
  'POST /settings/security/sign-out-session': 'sign-in',
  'POST /settings/restore': 'point-in-time recovery of the server’s database',
  'POST /usage': 'the usage record, kept on the server only',
  'DELETE /usage': 'the usage record, kept on the server only',
  'POST /notes': 'notes to the owner, kept on the server only',
  'POST /identity-alert': 'a phone tells the server what it worked out',
};

/** Not checked as a twin yet (docs/build-plan.md). This list only gets shorter. */
const NOT_YET: Record<string, string> = {
  'POST /accounts/:id/close': 'needs an account at $0',
  'POST /accounts/:id/reopen': 'needs a closed account',
  'POST /alerts/:id/dismiss': 'needs an alert',
  'POST /match': 'needs a hand entry and its bank row',
  'POST /match/:key/unlink': 'needs a match',
  'POST /owed/:id': 'needs an owed item',
  'POST /same-purchase/:id': 'needs a same-purchase question',
  'POST /transactions/:key/not-same': 'needs a claimed pair',
  'POST /transactions/:key/pending': 'needs a pending check',
  'POST /transactions/:key/review': 'needs a row to review',
  'POST /transfers/:key/pick': 'needs an unclear transfer',
  'POST /transfers/:key/unpair': 'needs a paired transfer',
  'POST /setup/start': 'setup',
  'POST /setup/starting-balances': 'setup',
};
