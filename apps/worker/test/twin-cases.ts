// The edits twin.test.ts runs as twins, in order, on one budget. Split from twin.test.ts.
import type { LocalEngine } from '../src/local/engine.js';
import { twinBranchCases } from './twin-branches.js';

export type Case = [string, string, unknown];

/** Name, the route it covers (as Hono names it), the request, and set-up data it needs. */
export type TwinCase = [string, string, () => Case | Promise<Case>, (() => Promise<void>)?];

/** What the cases read, set before the first one runs (twin.test.ts beforeAll). */
export interface TwinEnv {
  readonly a: LocalEngine;
  readonly spending: string[];
  readonly txn: string;
  readonly payee: string;
  readonly budget: string;
  readonly month: string;
  /** Set-up data a case needs: written on every copy, as a bank entry would, then worked out again. */
  onServer: (sql: string, ...values: unknown[]) => () => Promise<void>;
  ids: (table: string) => Promise<string[]>;
  named: (table: string, name: string) => Promise<string>;
}

/** Name, the route it covers (as Hono names it), and the request. They run in this order on one budget. */
export function twinCases(e: TwinEnv): TwinCase[] {
  return [
    [
      'assign',
      'POST /budget/assign',
      () => [
        'POST',
        '/api/budget/assign',
        { month: e.month, items: [{ categoryId: e.spending[0], amount: 1234 }] },
      ],
    ],
    // An add sent with what the device saw assigned (the Assign sheet): checked on both sides.
    [
      'assign against what the device saw',
      'POST /budget/assign',
      async () => {
        const was = await e.a.db
          .prepare(
            `SELECT coalesce(sum(amount), 0) AS n FROM assignment WHERE category_id = ?1 AND month = ?2`,
          )
          .bind(e.spending[0], e.month)
          .first<{ n: number }>();
        return [
          'POST',
          '/api/budget/assign',
          { month: e.month, items: [{ categoryId: e.spending[0], amount: 55, was: was!.n }] },
        ];
      },
    ],
    [
      'set',
      'POST /budget/set',
      () => ['POST', '/api/budget/set', { month: e.month, categoryId: e.spending[1], assigned: 4321 }],
    ],
    [
      'move',
      'POST /budget/move',
      () => [
        'POST',
        '/api/budget/move',
        { month: e.month, from: e.spending[0], to: e.spending[2], amount: 200 },
      ],
    ],
    [
      'a new target',
      'PUT /categories/:id/target',
      () => [
        'PUT',
        `/api/categories/${e.spending[3]}/target`,
        { categoryId: e.spending[3], month: '2027-02', target: { type: 'set_aside', amount: 999 } },
      ],
    ],
    [
      'pin',
      'POST /settings/categories/:id/pin',
      () => ['POST', `/api/settings/categories/${e.spending[4]}/pin`, { pinned: true }],
    ],
    [
      'rename a payee',
      'POST /settings/payees/:id',
      () => ['POST', `/api/settings/payees/${e.payee}`, { name: 'Twin named' }],
    ],
    [
      'categorize',
      'POST /transactions/categorize',
      () => ['POST', '/api/transactions/categorize', { keys: [e.txn], categoryId: e.spending[5] }],
    ],
    [
      'a note on a transaction',
      'PATCH /transactions/:key',
      () => ['PATCH', `/api/transactions/${e.txn}`, { note: 'twin' }],
    ],
    // An edit that depends on a balance: the phone sends what it showed and the change number its copy held
    // (http/through.ts). The copy checks its own number, the server its change log.
    [
      'archive a category that holds money',
      'POST /settings/categories/:id/archive',
      async () => [
        'POST',
        `/api/settings/categories/${e.spending[7]}/archive`,
        { archived: true, available: 500, through: (await e.a.state()).through },
      ],
    ],
    // Undo of that archive: the money it moved to Ready to Assign goes back.
    [
      'restore it with its money back',
      'POST /settings/categories/:id/archive',
      () => [
        'POST',
        `/api/settings/categories/${e.spending[7]}/archive`,
        { archived: false, giveBack: [{ month: e.month, amount: 500 }] },
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
      async () => [
        'POST',
        '/api/settings/groups/reorder',
        { ids: (await e.ids('category_group')).reverse() },
      ],
    ],
    [
      'categories in another order',
      'POST /settings/categories/reorder',
      () => [
        'POST',
        '/api/settings/categories/reorder',
        { ids: [e.spending[2], e.spending[1], e.spending[0]] },
      ],
    ],
    [
      'remove the new category',
      'POST /settings/categories/:id/remove',
      async () => [
        'POST',
        `/api/settings/categories/${await e.named('category', 'Twin category')}/remove`,
        {},
      ],
    ],
    [
      'remove the new group',
      'POST /settings/groups/:id/remove',
      async () => [
        'POST',
        `/api/settings/groups/${await e.named('category_group', 'Twin group')}/remove`,
        {},
      ],
    ],
    [
      'rename an account',
      'POST /accounts/:id/name',
      async () => ['POST', `/api/accounts/${(await e.ids('account'))[0]}/name`, { name: 'Twin account' }],
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
          accountId: (await e.ids('account'))[0],
          date: '2026-11-10',
          amount: -1234,
          payee: 'Twin cafe',
          categoryId: e.spending[0],
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
          (await e.a.db
            .prepare(
              `SELECT txn_key FROM manual_pending WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
            )
            .first<{ txn_key: string }>())!.txn_key
        }`,
        undefined,
      ],
    ],
    [
      'add a transfer, which adds its other side',
      'POST /transactions',
      async () => {
        const [from, to] = await e.ids('account');
        return [
          'POST',
          '/api/transactions',
          {
            kind: 'pending',
            accountId: from,
            date: '2026-11-10',
            amount: -4321,
            payee: 'Twin transfer',
            categoryId: null,
            repeats: 'never',
            transferAccountId: to,
          },
        ];
      },
    ],
    [
      'add a purchase that is half owed to you',
      'POST /transactions',
      async () => [
        'POST',
        '/api/transactions',
        {
          kind: 'pending',
          accountId: (await e.ids('account'))[0],
          date: '2026-11-10',
          amount: -2468,
          payee: 'Twin dinner',
          categoryId: e.spending[0],
          repeats: 'never',
          owed: { mode: 'half', expectBy: '2026-11-30' },
        },
      ],
    ],
    [
      'add money in that pays back what you are owed',
      'POST /transactions',
      async () => {
        const owed = (await (await e.a.request('GET', '/api/owed')).json()) as {
          items: { id: string; status: string }[];
        };
        const item = owed.items.find((i) => i.status === 'open' || i.status === 'late')!;
        return [
          'POST',
          '/api/transactions',
          {
            kind: 'pending',
            accountId: (await e.ids('account'))[0],
            date: '2026-11-10',
            amount: 500,
            payee: 'Twin payback',
            categoryId: null,
            repeats: 'never',
            paysBack: [{ itemId: item.id, amount: 500 }],
          },
        ];
      },
    ],
    // Edits on what the seeded budget already holds.
    [
      'mark a row reviewed',
      'POST /transactions/:key/review',
      () => ['POST', `/api/transactions/${e.txn}/review`, {}],
    ],
    // Accept on a row that cleared at another amount than your estimate, then Undo: it asks again.
    [
      'accept a changed amount',
      'POST /transactions/:key/review',
      () => ['POST', '/api/transactions/n-shakeshack/review', {}],
    ],
    [
      'undo that accept',
      'POST /transactions/:key/review/undo',
      () => ['POST', '/api/transactions/n-shakeshack/review/undo', {}],
    ],
    ['close out an owed item', 'POST /owed/:id', () => ['POST', '/api/owed/nopa', { action: 'close' }]],
    ['reopen it', 'POST /owed/:id', () => ['POST', '/api/owed/nopa', { action: 'reopen' }]],
    ['remove the mark from it', 'POST /owed/:id', () => ['POST', '/api/owed/nopa', { action: 'cancel' }]],
    [
      'keep waiting for a pending check',
      'POST /transactions/:key/pending',
      () => ['POST', '/api/transactions/n-check-1043/pending', { action: 'keep_waiting' }],
    ],
    // Check not cleared: the check was written on another day, for another amount.
    [
      'fix the amount and date of a check you added',
      'PATCH /transactions/:key',
      () => ['PATCH', '/api/transactions/n-check-1043', { amount: -12500, date: '2026-11-03' }],
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
        e.onServer(
          `UPDATE txn_overlay SET transfer_state = 'unsorted' WHERE budget_id = ?1 AND txn_key = 'n-to-marcus'`,
          e.budget,
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
        const view = (await (await e.a.request('GET', '/api/match/n-venmo')).json()) as {
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
      'match it again',
      'POST /match',
      async () => {
        const view = (await (await e.a.request('GET', '/api/match/n-venmo')).json()) as {
          open: { id: string }[];
        };
        return [
          'POST',
          '/api/match',
          { inflowKey: 'n-venmo', items: [{ itemId: view.open[0]!.id, amount: 100 }] },
        ];
      },
    ],
    // "It's income" on matched money: the links it had are undone.
    [
      'call that money income',
      'POST /match',
      () => ['POST', '/api/match', { inflowKey: 'n-venmo', items: [] }],
    ],
    [
      'split a purchase with a line owed to you',
      'PATCH /transactions/:key',
      () => [
        'PATCH',
        '/api/transactions/n-personal',
        {
          split: [
            { categoryId: 'personal', amount: -5000, memo: null, absorbsRemainder: false },
            { categoryId: null, amount: -3500, memo: null, absorbsRemainder: true, owed: true },
          ],
        },
      ],
    ],
    // A card refund (Money rule 3): Not this purchase, then a purchase picked for it.
    [
      'say a card refund is not that purchase',
      'POST /transactions/:key/refund-of',
      () => ['POST', '/api/transactions/n-rei-refund/refund-of', { purchaseKey: null }],
    ],
    [
      'link a card refund to a purchase on the card',
      'POST /transactions/:key/refund-of',
      () => ['POST', '/api/transactions/n-rei-refund/refund-of', { purchaseKey: 'o-wholefoods' }],
    ],
    [
      'dismiss an alert',
      'POST /alerts/:id/dismiss',
      () => ['POST', '/api/alerts/twin-alert/dismiss', {}],
      () =>
        e.onServer(
          `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at) VALUES ('twin-alert', ?1, 'low_balance', 'checking', NULL, ?2)`,
          e.budget,
          Date.now(),
        )(),
    ],
    [
      'answer No to Same purchase?',
      'POST /same-purchase/:id',
      () => ['POST', '/api/same-purchase/twin-ask', { answer: 'no', key: 'n-shell' }],
      () =>
        e.onServer(
          `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at) VALUES ('twin-ask', ?1, 'same_purchase', 'n-marriott', ?2, ?3)`,
          e.budget,
          JSON.stringify({ candidates: ['n-shell'] }),
          Date.now(),
        )(),
    ],
    [
      'undo that No',
      'POST /same-purchase/:id/undo',
      () => ['POST', '/api/same-purchase/twin-ask/undo', { key: 'n-shell' }],
    ],
    [
      'undo OK on a row removed by the bank',
      'POST /alerts/:id/undo',
      () => ['POST', '/api/alerts/twin-vanished/undo', {}],
      () =>
        e.onServer(
          `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at, acked_at) VALUES ('twin-vanished', ?1, 'vanished_pending', 'n-shell', NULL, ?2, ?2)`,
          e.budget,
          Date.now(),
        )(),
    ],
    [
      'close an account at $0',
      'POST /accounts/:id/close',
      async () => [
        'POST',
        '/api/accounts/twin-acct/close',
        { working: 0, available: 0, through: (await e.a.state()).through },
      ],
      () =>
        e.onServer(
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
        e.onServer(
          `UPDATE manual_pending SET covers_provider_txn_id =
             (SELECT provider_txn_id FROM bank_txn WHERE txn_key = 'n-marriott' AND pending = 1 AND removed_at IS NULL)
           WHERE budget_id = ?1 AND txn_key = 'n-check-1043'`,
          e.budget,
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
          await e.onServer(
            `UPDATE ${table} SET txn_key = 'p:' || (SELECT provider_txn_id FROM bank_txn WHERE txn_key = 'n-bluebottle')
             WHERE budget_id = ?1 AND txn_key = 'n-bluebottle'`,
            e.budget,
          )();
        await e.onServer(
          `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at)
           SELECT 'twin-ask-yes', ?1, 'same_purchase', txn_key, ?2, ?3
           FROM bank_txn WHERE raw_name = 'BLUE BOTTLE COFFEE' AND pending = 0 AND removed_at IS NULL`,
          e.budget,
          JSON.stringify({ candidates: ['n-comcast'] }),
          Date.now(),
        )();
      },
    ],
    // A bank removed at the bank (D-87): the budget marks it removed, and its account stays. The server's own copy
    // of a link that still has its token refuses it (the bank must go first); this one has none.
    [
      'mark a removed bank',
      'POST /settings/connections/:id/mark-removed',
      () => ['POST', '/api/settings/connections/con_twin/mark-removed', {}],
      async () => {
        await e.onServer(
          `INSERT INTO connection (id, budget_id, provider, provider_item_id, institution_name, setup_done, linked_at, created_at, updated_at)
           VALUES ('con_twin', ?1, 'plaid', 'item-twin', 'Twin Bank', 1, 5, 5, 5)`,
          e.budget,
        )();
        await e.onServer(
          `INSERT INTO provider_account (id, budget_id, connection_id, provider_account_id, name, type, subtype, current_balance, created_at, updated_at)
           VALUES ('pa-twin', ?1, 'con_twin', 'pa-twin', 'Twin Checking', 'depository', 'checking', 1000, 5, 5)`,
          e.budget,
        )();
      },
    ],
    // Branches of the edits above that those cases don't take (twin-branches.ts).
    ...twinBranchCases(e),
    // Last: it sets the budget's start again, after the set-up statement took it away.
    [
      'pick the month the budget starts',
      'POST /setup/start',
      () => ['POST', '/api/setup/start', { startMonth: '2026-11' }],
      () => e.onServer(`UPDATE budget SET budget_start_month = NULL WHERE id = ?1`, e.budget)(),
    ],
  ];
}
