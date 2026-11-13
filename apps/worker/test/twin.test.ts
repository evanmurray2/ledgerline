// Every edit the phone may make offline, run as a twin (test/twin.ts): the phone's rows equal the server's.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LocalEngine } from '../src/local/engine.js';
import { budgetApi } from '../src/routes/api.js';
import { syncPhone } from './phone.js';
import { storeDb } from './store-db.js';
import { differences, newPhone, rowsOf, twin } from './twin.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };

describe('the same edit on the phone and on the server', () => {
  let a: LocalEngine;
  let b: LocalEngine;
  /** Takes only the rows the first phone records for each edit (twin.ts). */
  let c: LocalEngine;
  let spending: string[];
  let txn: string;
  let payee: string;
  let budget: string;
  /** Set-up data a case needs: written on the server, as a bank update would, then synced to both phones. */
  const onServer =
    (sql: string, ...values: unknown[]) =>
    async () => {
      await storeDb(budget)
        .prepare(sql)
        .bind(...values)
        .run();
    };
  const month = '2026-11';

  beforeAll(async () => {
    const r = await SELF.fetch(`${ORIGIN}/__dev/seed-november`, { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(200);
    const session = (await (await SELF.fetch(`${ORIGIN}/api/session`)).json()) as { budget: { id: string } };
    budget = session.budget.id;
    a = await syncPhone(await newPhone());
    b = await syncPhone(await newPhone());
    c = await syncPhone(await newPhone());
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
  const cases: [string, string, () => Case | Promise<Case>, (() => Promise<void>)?][] = [
    [
      'assign',
      'POST /budget/assign',
      () => ['POST', '/api/budget/assign', { month, items: [{ categoryId: spending[0], amount: 1234 }] }],
    ],
    // An add sent with what the device saw assigned (the Assign sheet): checked on both sides.
    [
      'assign against what the device saw',
      'POST /budget/assign',
      async () => {
        const was = await a.db
          .prepare(
            `SELECT coalesce(sum(amount), 0) AS n FROM assignment WHERE category_id = ?1 AND month = ?2`,
          )
          .bind(spending[0], month)
          .first<{ n: number }>();
        return [
          'POST',
          '/api/budget/assign',
          { month, items: [{ categoryId: spending[0], amount: 55, was: was!.n }] },
        ];
      },
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
    // Undo of that archive: the money it moved to Ready to Assign goes back.
    [
      'restore it with its money back',
      'POST /settings/categories/:id/archive',
      () => [
        'POST',
        `/api/settings/categories/${spending[7]}/archive`,
        { archived: false, giveBack: [{ month, amount: 500 }] },
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
    // Edits on what the seeded budget already holds.
    [
      'mark a row reviewed',
      'POST /transactions/:key/review',
      () => ['POST', `/api/transactions/${txn}/review`, {}],
    ],
    ['close out an owed item', 'POST /owed/:id', () => ['POST', '/api/owed/nopa', { action: 'close' }]],
    ['reopen it', 'POST /owed/:id', () => ['POST', '/api/owed/nopa', { action: 'reopen' }]],
    ['remove the mark from it', 'POST /owed/:id', () => ['POST', '/api/owed/nopa', { action: 'cancel' }]],
    [
      'keep waiting for a pending check',
      'POST /transactions/:key/pending',
      () => ['POST', '/api/transactions/n-check-1043/pending', { action: 'keep_waiting' }],
    ],
    [
      'unpair a transfer',
      'POST /transfers/:key/unpair',
      () => ['POST', '/api/transfers/n-to-marcus/unpair', {}],
    ],
    // Edits that need set-up data. A bank update would make it; here one statement on the server does.
    [
      'say a transfer went to an account that is not linked',
      'POST /transfers/:key/pick',
      () => ['POST', '/api/transfers/n-to-marcus/pick', { otherKey: null, unlinked: true }],
      () =>
        onServer(
          `UPDATE txn_overlay SET transfer_state = 'unsorted' WHERE budget_id = ?1 AND txn_key = 'n-to-marcus'`,
          budget,
        )(),
    ],
    [
      'call a deposit that did not ask a transfer, to an account whose side has not arrived',
      'POST /transfers/:key/pick',
      () => ['POST', '/api/transfers/n-payroll/pick', { otherKey: null, accountId: 'marcus' }],
    ],
    [
      'match money in to what you are owed',
      'POST /match',
      async () => {
        const view = (await (await a.request('GET', '/api/match/n-venmo')).json()) as {
          open: { id: string }[];
        };
        return [
          'POST',
          '/api/match',
          { inflowKey: 'n-venmo', items: [{ itemId: view.open[0]!.id, amount: 100 }], rest: 'income' },
        ];
      },
    ],
    ['undo that match', 'POST /match/:key/unlink', () => ['POST', '/api/match/n-venmo/unlink', {}]],
    [
      'dismiss an alert',
      'POST /alerts/:id/dismiss',
      () => ['POST', '/api/alerts/twin-alert/dismiss', {}],
      () =>
        onServer(
          `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at) VALUES ('twin-alert', ?1, 'low_balance', 'checking', NULL, ?2)`,
          budget,
          Date.now(),
        )(),
    ],
    [
      'answer No to Same purchase?',
      'POST /same-purchase/:id',
      () => ['POST', '/api/same-purchase/twin-ask', { answer: 'no', key: 'n-shell' }],
      () =>
        onServer(
          `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at) VALUES ('twin-ask', ?1, 'same_purchase', 'n-marriott', ?2, ?3)`,
          budget,
          JSON.stringify({ candidates: ['n-shell'] }),
          Date.now(),
        )(),
    ],
    [
      'close an account at $0',
      'POST /accounts/:id/close',
      async () => [
        'POST',
        '/api/accounts/twin-acct/close',
        { working: 0, available: 0, through: (await a.state()).through },
      ],
      () =>
        onServer(
          `INSERT INTO account (id, budget_id, name, kind, budget_from, created_at, updated_at)
           SELECT 'twin-acct', budget_id, 'Twin closed', kind, budget_from, created_at, updated_at FROM account WHERE id = 'ally'`,
        )(),
    ],
    ['reopen it', 'POST /accounts/:id/reopen', () => ['POST', '/api/accounts/twin-acct/reopen', {}]],
    [
      'confirm a starting balance',
      'POST /setup/starting-balances',
      () => [
        'POST',
        '/api/setup/starting-balances',
        { accounts: [{ accountId: 'twin-acct', startingBalance: 0 }] },
      ],
    ],
    [
      'say an entry is not the same as a bank row',
      'POST /transactions/:key/not-same',
      () => ['POST', '/api/transactions/n-check-1043/not-same', {}],
      () =>
        onServer(
          `UPDATE manual_pending SET covers_provider_txn_id =
             (SELECT provider_txn_id FROM bank_txn WHERE txn_key = 'n-marriott' AND pending = 1 AND removed_at IS NULL)
           WHERE budget_id = ?1 AND txn_key = 'n-check-1043'`,
          budget,
        )(),
    ],
    // Undo reads the record Not the same wrote (audit_log, never synced): each side wrote its own.
    [
      'undo Not the same',
      'POST /transactions/:key/not-same/undo',
      () => ['POST', '/api/transactions/n-check-1043/not-same/undo', {}],
    ],
    // Yes: a posted bank row takes your entry's key, which writes `txn_key_move` (recorded, never synced).
    [
      'answer Yes to Same purchase?',
      'POST /same-purchase/:id',
      () => ['POST', '/api/same-purchase/twin-ask-yes', { answer: 'yes', key: 'n-comcast' }],
      async () => {
        // The question is about a bank row filed under its own key (`p:` and the bank's id), as sync files them.
        for (const table of ['txn_overlay', 'bank_txn'])
          await onServer(
            `UPDATE ${table} SET txn_key = 'p:' || (SELECT provider_txn_id FROM bank_txn WHERE txn_key = 'n-bluebottle')
             WHERE budget_id = ?1 AND txn_key = 'n-bluebottle'`,
            budget,
          )();
        await onServer(
          `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at)
           SELECT 'twin-ask-yes', ?1, 'same_purchase', txn_key, ?2, ?3
           FROM bank_txn WHERE raw_name = 'BLUE BOTTLE COFFEE' AND pending = 0 AND removed_at IS NULL`,
          budget,
          JSON.stringify({ candidates: ['n-comcast'] }),
          Date.now(),
        )();
      },
    ],
    // Last: it sets the budget's start again, after the set-up statement took it away.
    [
      'pick the month the budget starts',
      'POST /setup/start',
      () => ['POST', '/api/setup/start', { startMonth: '2026-11' }],
      () => onServer(`UPDATE budget SET budget_start_month = NULL WHERE id = ?1`, budget)(),
    ],
  ];

  const ids = async (table: string) =>
    (await a.db.prepare(`SELECT id FROM ${table} ORDER BY id`).all<{ id: string }>()).results.map(
      (r) => r.id,
    );
  const named = async (table: string, name: string) =>
    (await a.db.prepare(`SELECT id FROM ${table} WHERE name = ?1`).bind(name).first<{ id: string }>())!.id;

  for (const [name, , make, prepare] of cases)
    it(name, async () => {
      if (prepare) {
        await prepare();
        await syncPhone(a);
        await syncPhone(b);
        await syncPhone(c);
        expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
      }
      const [method, path, body] = await make();
      const t = await twin(a, b, method, path, body, c);
      expect(t.phone.status, await t.phone.clone().text()).toBeLessThan(300);
      expect(t.recorded).toBeGreaterThan(0);
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
    const joined = await twin(a, b, 'POST', '/api/settings/payees/merge', { ids: two, keep: two[0] }, c);
    expect(joined.phone.status, await joined.phone.clone().text()).toBe(200);
    expect(joined.differences).toEqual([]);
    const onPhone = (await joined.phone.json()) as { undoId: string };
    const onServer = (await joined.server.json()) as { undoId: string };
    expect(onPhone.undoId).toBe(onServer.undoId);
    // The phone takes the server's rows before the undo: they carry the join's own time, so the undo still finds
    // the payees as the join left them.
    await syncPhone(a);
    const undone = await twin(a, b, 'POST', `/api/settings/payees/merge/${onPhone.undoId}/undo`, {}, c);
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
    expect(t.recorded).toBe(0);
    expect(t.differences).toEqual([]);
  });

  it('the Yes answer moved a key, on the phone and on the copy that took its rows', async () => {
    for (const e of [a, c]) {
      const moved = await e.db.prepare(`SELECT count(*) AS n FROM txn_key_move`).first<{ n: number }>();
      expect(moved!.n).toBeGreaterThan(0);
    }
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
  'POST /sync/shadow': 'a phone tells the server what its shadow run found',
};

/** Not checked as a twin yet (docs/build-plan.md). This list only gets shorter. */
const NOT_YET: Record<string, string> = {};
