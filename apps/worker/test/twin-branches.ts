// Twin cases for the branches of each edit route that twin-cases.ts doesn't take: one case per branch
// (docs/architecture.md, "The engine on the log"). They run after the cases of twin-cases.ts, in this order, on
// the same budget.
import type { TwinCase, TwinEnv } from './twin-cases.js';

export function twinBranchCases(e: TwinEnv): TwinCase[] {
  return [
    [
      'take money back out of a category',
      'POST /budget/assign',
      () => [
        'POST',
        '/api/budget/assign',
        { month: e.month, items: [{ categoryId: e.spending[0], amount: -100 }] },
      ],
    ],
    [
      'move money to Ready to Assign',
      'POST /budget/move',
      () => ['POST', '/api/budget/move', { month: e.month, from: e.spending[1], to: 'rta', amount: 100 }],
    ],
    [
      'move money from Ready to Assign',
      'POST /budget/move',
      () => ['POST', '/api/budget/move', { month: e.month, from: 'rta', to: e.spending[2], amount: 50 }],
    ],
    [
      'clear a target',
      'PUT /categories/:id/target',
      () => [
        'PUT',
        `/api/categories/${e.spending[3]}/target`,
        { categoryId: e.spending[3], month: '2027-02', target: { type: 'none' } },
      ],
    ],
    [
      'a target that refills every 3 months',
      'PUT /categories/:id/target',
      () => [
        'PUT',
        `/api/categories/${e.spending[3]}/target`,
        {
          categoryId: e.spending[3],
          month: '2027-03',
          target: { type: 'refill', amount: 3000, periodMonths: 3, anchor: '2027-03' },
        },
      ],
    ],
    [
      'unpin',
      'POST /settings/categories/:id/pin',
      () => ['POST', `/api/settings/categories/${e.spending[4]}/pin`, { pinned: false }],
    ],
    [
      'edit a category: a new name, a due day and a low balance',
      'POST /settings/categories',
      async () => {
        const g = await e.a.db
          .prepare(`SELECT group_id FROM category WHERE id = ?1`)
          .bind(e.spending[9])
          .first<{ group_id: string | null }>();
        return [
          'POST',
          '/api/settings/categories',
          {
            id: e.spending[9],
            name: 'Twin edited',
            groupId: g!.group_id,
            kind: 'spending',
            dueDay: 15,
            lowThreshold: 2500,
          },
        ];
      },
    ],
    [
      'rename a group and make it bills',
      'POST /settings/groups',
      async () => [
        'POST',
        '/api/settings/groups',
        {
          id: (await e.a.db
            .prepare(`SELECT id FROM category_group WHERE archived_at IS NULL ORDER BY id LIMIT 1`)
            .first<{ id: string }>())!.id,
          name: 'Twin bills',
          isBills: true,
        },
      ],
    ],
    [
      'a new saving category',
      'POST /settings/categories',
      () => ['POST', '/api/settings/categories', { name: 'Twin empty', groupId: null, kind: 'saving' }],
    ],
    // Nothing in it: archived with no money to move.
    [
      'archive a category with nothing in it',
      'POST /settings/categories/:id/archive',
      async () => [
        'POST',
        `/api/settings/categories/${await e.named('category', 'Twin empty')}/archive`,
        { archived: true, available: 0, through: (await e.a.state()).through },
      ],
    ],
    [
      'restore it',
      'POST /settings/categories/:id/archive',
      async () => [
        'POST',
        `/api/settings/categories/${await e.named('category', 'Twin empty')}/archive`,
        { archived: false },
      ],
    ],
    [
      'send money in to Ready to Assign',
      'POST /transactions/categorize',
      () => ['POST', '/api/transactions/categorize', { keys: ['n-points'], categoryId: null, toRta: true }],
    ],
    [
      'take the category off two rows',
      'POST /transactions/categorize',
      () => ['POST', '/api/transactions/categorize', { keys: ['n-tj', 'n-target'], categoryId: null }],
    ],
    [
      'a pending charge: your estimate',
      'PATCH /transactions/:key',
      () => ['PATCH', '/api/transactions/n-shell', { estimatedAmount: -4800 }],
    ],
    [
      'a pending charge that won’t clear',
      'PATCH /transactions/:key',
      () => ['PATCH', '/api/transactions/n-shell', { wontClear: true }],
    ],
    [
      'it clears after all',
      'PATCH /transactions/:key',
      () => ['PATCH', '/api/transactions/n-shell', { wontClear: false }],
    ],
    [
      'count money in toward next month',
      'PATCH /transactions/:key',
      () => ['PATCH', '/api/transactions/n-ally-interest', { budgetMonth: '2026-12' }],
    ],
    [
      'a payee name typed on a bank row',
      'PATCH /transactions/:key',
      () => ['PATCH', '/api/transactions/n-groceries', { payeeName: 'Twin grocer' }],
    ],
    [
      'mark a purchase owed to you',
      'PATCH /transactions/:key',
      () => ['PATCH', '/api/transactions/n-dining', { markOwed: { mode: 'half', expectBy: '2026-12-01' } }],
    ],
    [
      'take the mark off it',
      'PATCH /transactions/:key',
      () => ['PATCH', '/api/transactions/n-dining', { markOwed: null }],
    ],
    // The split purchase above, one category again: its lines and the line owed to you go.
    [
      'a split purchase back to one category',
      'PATCH /transactions/:key',
      () => ['PATCH', '/api/transactions/n-personal', { categoryId: e.spending[0] }],
    ],
    [
      'money in to Ready to Assign from its sheet, with a memo',
      'PATCH /transactions/:key',
      () => ['PATCH', '/api/transactions/n-points', { categoryId: null, toRta: true, memo: 'Twin memo' }],
    ],
    [
      'an upcoming entry that repeats every month',
      'POST /transactions',
      async () => [
        'POST',
        '/api/transactions',
        {
          kind: 'upcoming',
          accountId: (await e.ids('account'))[0],
          date: '2026-11-28',
          amount: -1599,
          payee: 'Twin gym',
          categoryId: e.spending[0],
          repeats: 'monthly',
        },
      ],
    ],
    [
      'an entry to turn around',
      'POST /transactions',
      async () => [
        'POST',
        '/api/transactions',
        {
          kind: 'pending',
          accountId: (await e.ids('account'))[0],
          date: '2026-11-10',
          amount: -700,
          payee: 'Twin flip',
          categoryId: e.spending[0],
          repeats: 'never',
        },
      ],
    ],
    // Out to in: what only fits money out (its category) goes with it.
    [
      'turn an entry you added from money out to money in',
      'PATCH /transactions/:key',
      async () => [
        'PATCH',
        `/api/transactions/${await twinEntry(e, 'Twin flip')}`,
        { amount: 700, categoryId: null, toRta: true },
      ],
    ],
    [
      'delete a pending entry from Check these',
      'POST /transactions/:key/pending',
      async () => [
        'POST',
        `/api/transactions/${await twinEntry(e, 'Twin flip')}/pending`,
        { action: 'delete' },
      ],
    ],
    [
      'move an owed item’s date',
      'POST /owed/:id',
      () => ['POST', '/api/owed/united', { action: 'snooze', expectBy: '2026-12-20' }],
    ],
    [
      'turn the tracking setting off',
      'PATCH /settings',
      () => ['PATCH', '/api/settings', { tracking: false }],
    ],
  ];
}

/** The key of the newest entry you added with this payee. */
async function twinEntry(e: TwinEnv, payee: string): Promise<string> {
  return (await e.a.db
    .prepare(
      `SELECT txn_key FROM manual_pending WHERE payee_name = ?1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(payee)
    .first<{ txn_key: string }>())!.txn_key;
}
