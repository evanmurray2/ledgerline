// Local development and end-to-end tests only: loads the prototype's November 2026 (the canonical fixture in
// packages/domain/test/fixtures/november.ts) into the dev user's BudgetStore through the real tables and overlay; the
// phone works out the rest. Served inside the store (BudgetStore.dev) only when DEV_ROUTES=1 outside production and
// without a setup code.
import { Hono } from 'hono';
import type { AppEnv } from './http/context.js';
import { Scoped } from './db/scoped.js';
import { clock } from './http/clock.js';
import * as F from '../../../packages/domain/test/fixtures/november.js';

export const dev = new Hono<AppEnv>();

const ACCOUNTS: Record<
  string,
  { name: string; inst: string; mask: string; bank: number; type: string; subtype: string }
> = {
  checking: {
    name: 'Everyday Checking',
    inst: 'Chase',
    mask: '0912',
    bank: 421240,
    type: 'depository',
    subtype: 'checking',
  },
  ally: {
    name: 'Ally Savings',
    inst: 'Ally',
    mask: '3021',
    bank: 940000,
    type: 'depository',
    subtype: 'savings',
  },
  marcus: {
    name: 'Marcus Savings',
    inst: 'Marcus',
    mask: '7745',
    bank: 1000000,
    type: 'depository',
    subtype: 'savings',
  },
  sapphire: {
    name: 'Sapphire Preferred',
    inst: 'Chase',
    mask: '4417',
    bank: 84217,
    type: 'credit',
    subtype: 'credit card',
  },
  freedom: {
    name: 'Freedom Unlimited',
    inst: 'Chase',
    mask: '8820',
    bank: 21488,
    type: 'credit',
    subtype: 'credit card',
  },
};

const NAMES: Record<string, string> = {
  rent: 'Rent',
  electric: 'Electric',
  internet: 'Internet',
  subs: 'Subscriptions',
  groceries: 'Groceries',
  dining: 'Dining out',
  gas: 'Gas',
  shopping: 'Shopping',
  household: 'Household',
  health: 'Health',
  personal: 'Personal care',
  invest: 'Investments',
  car: 'Car insurance',
  vacation: 'Vacation',
  gifts: 'Gifts',
  emergency: 'Emergency fund',
  home: 'Home repairs',
};

const PAYEES: Record<string, string> = {
  'o-vanguard': 'Vanguard',
  'o-electric': 'PG&E',
  'o-subs': 'Netflix',
  'o-wholefoods': 'Whole Foods',
  'o-rei': 'REI',
  'o-safeway': 'Safeway',
  'o-to-marcus': 'Transfer to Marcus Savings',
  'o-from-checking-m': 'Transfer from Everyday Checking',
  'o-payroll-1': 'Acme Corp payroll',
  'o-to-ally': 'Transfer to Ally Savings',
  'o-from-checking-a': 'Transfer from Everyday Checking',
  'o-comcast': 'Comcast',
  'o-dining': 'Nopalito',
  'o-gas': 'Chevron',
  'o-united': 'United Airlines',
  'o-target': 'Target',
  'o-household': 'Home Depot',
  'o-health': 'Walgreens',
  'o-personal': 'Haircut',
  'o-gifts': 'Etsy',
  'o-freedom-pay': 'Chase card payment',
  'o-freedom-pay-in': 'Payment, thank you',
  'o-payroll-2': 'Acme Corp payroll',
  'o-rent': 'Rent',
  'n-vanguard': 'Vanguard',
  'n-subs': 'Spotify',
  'n-zelle': 'Zelle from Sam',
  'n-sapphire-pay': 'Chase card payment',
  'n-gas': 'Chevron',
  'n-check-1043': 'Check #1043',
  'n-groceries': 'Berkeley Bowl',
  'n-dining': 'Burma Superstar',
  'n-electric': 'PG&E',
  'n-shopping': 'Uniqlo',
  'n-safeway': 'Safeway',
  'n-personal': 'Haircut',
  'n-to-marcus': 'Transfer to Marcus Savings',
  'n-from-checking-m': 'Transfer from Everyday Checking',
  'n-payroll': 'Acme Corp payroll',
  'n-venmo': 'Venmo cashout',
  'n-comcast': 'Comcast',
  'n-rent': 'Rent',
  'n-ally-interest': 'Interest paid',
  'n-costco': 'Costco',
  'n-rei-refund': 'REI',
  'n-sapphire-pay-in': 'Payment, thank you',
  'n-nopa': 'Nopa',
  'n-points': 'Points back',
  'n-marriott': 'Marriott Downtown',
  'n-uber': 'Uber Eats',
  'n-amazon-s': 'Amazon',
  'n-tj': 'Trader Joe’s',
  'n-bluebottle': 'Blue Bottle Coffee',
  'n-shell': 'Shell',
  'n-ticketmaster': 'Ticketmaster',
  'n-target': 'Target',
  'n-amazon-f': 'Amazon',
  'n-cvs': 'CVS Pharmacy',
  'n-shakeshack': 'Shake Shack',
};

dev.post('/seed-november', async (c) => {
  const env = c.env;
  const now = clock(env);
  const m = { budgetId: c.get('budgetId'), userId: c.get('userId') };
  // Keep the budget's data_version climbing, so a browser's old ETags never match the new data.
  const version = Number(
    (await env.DB.prepare(`SELECT data_version AS v FROM budget WHERE id = ?1`)
      .bind(m.budgetId)
      .first('v')) ?? 0,
  );
  await env.DB.batch(
    [
      'budget_line',
      'month_snapshot',
      'txn_link',
      'expected_reimbursement',
      'txn_split',
      'manual_pending',
      'txn_overlay',
      'bank_txn',
      'assignment',
      'target',
      'category',
      'category_group',
      'account',
      'provider_account',
      'connection',
      'rule',
      'payee_alias',
      'payee',
      'liability_snapshot',
      'account_month_total',
      'month_total_done',
      'alert',
      'setting',
      'budget',
    ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await env.DB.prepare(
    `INSERT INTO budget (id, name, data_version, created_at, updated_at) VALUES (?1, 'My budget', ?2, ?3, ?3)`,
  )
    .bind(m.budgetId, version + 1, now)
    .run();
  const s = new Scoped(env.DB, m.budgetId, m.userId);
  const w: D1PreparedStatement[] = [
    s.q(
      `UPDATE budget SET budget_start_month = ?2, time_zone = 'America/Los_Angeles', updated_at = ?3 WHERE id = ?1`,
      F.START,
      now,
    ),
    s.q(`INSERT INTO setting (budget_id, key, value, updated_at) VALUES (?1, 'tracking', 'true', ?2)`, now),
  ];
  const conns: Record<string, string> = { Chase: 'con_chase', Ally: 'con_ally', Marcus: 'con_marcus' };
  const day = 86_400_000;
  w.push(
    s.q(
      `INSERT INTO connection (id, budget_id, provider, provider_item_id, institution_name, status, last_synced_at, linked_at, created_at, updated_at) VALUES ('con_chase', ?1, 'plaid', 'item_chase', 'Chase', 'ok', ?2, ?3, ?3, ?3)`,
      now - 3_600_000,
      Date.parse('2026-10-01'),
    ),
    s.q(
      `INSERT INTO connection (id, budget_id, provider, provider_item_id, institution_name, status, last_synced_at, linked_at, created_at, updated_at) VALUES ('con_ally', ?1, 'plaid', 'item_ally', 'Ally', 'login_required', ?2, ?3, ?3, ?3)`,
      Date.parse('2026-11-12T17:00:00Z'),
      Date.parse('2026-10-01'),
    ),
    s.q(
      `INSERT INTO connection (id, budget_id, provider, provider_item_id, institution_name, status, last_synced_at, linked_at, created_at, updated_at) VALUES ('con_marcus', ?1, 'plaid', 'item_marcus', 'Marcus', 'ok', ?2, ?3, ?3, ?3)`,
      now - 3_600_000,
      Date.parse('2026-10-03'),
    ),
    s.q(
      `INSERT INTO connection (id, budget_id, provider, provider_item_id, institution_name, status, linked_at, removed_at, created_at, updated_at) VALUES ('con_dup', ?1, 'plaid', 'item_dup', 'Chase', 'removed', ?2, ?2, ?2, ?2)`,
      Date.parse('2026-10-01'),
    ),
  );
  for (const a of F.accounts) {
    const x = ACCOUNTS[a.id]!;
    w.push(
      s.q(
        `INSERT INTO provider_account (id, budget_id, connection_id, provider_account_id, name, type, subtype, mask, current_balance, balance_as_of, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10)`,
        `pa_${a.id}`,
        conns[x.inst],
        `pa_${a.id}`,
        x.name,
        x.type,
        x.subtype,
        x.mask,
        x.bank,
        now - day,
      ),
      s.q(
        `INSERT INTO account (id, budget_id, provider_account_id, name, kind, budget_from, starting_balance, starting_balance_confirmed_at, sort, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?8, ?8)`,
        a.id,
        `pa_${a.id}`,
        x.name,
        a.kind,
        a.budgetFrom,
        a.startingBalance,
        now,
        Object.keys(ACCOUNTS).indexOf(a.id),
      ),
    );
  }
  w.push(
    s.q(
      `INSERT INTO liability_snapshot (id, budget_id, provider_account_id, as_of, statement_balance, due_date, data, created_at) VALUES ('l1', ?1, 'pa_sapphire', '2026-11-14', 61140, '2026-11-25', '{}', ?2)`,
      now,
    ),
    s.q(
      `INSERT INTO liability_snapshot (id, budget_id, provider_account_id, as_of, statement_balance, due_date, data, created_at) VALUES ('l2', ?1, 'pa_freedom', '2026-11-14', 14515, '2026-12-02', '{}', ?2)`,
      now,
    ),
  );
  const groups = Object.keys(F.groups);
  groups.forEach((g, i) =>
    w.push(
      s.q(
        `INSERT INTO category_group (id, budget_id, name, is_bills, sort, created_at, updated_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?6)`,
        `g_${g.toLowerCase()}`,
        g,
        g === 'Bills' ? 1 : 0,
        i,
        now,
      ),
    ),
  );
  let sort = 0;
  for (const [g, ids] of Object.entries(F.groups)) {
    for (const id of ids) {
      w.push(
        s.q(
          `INSERT INTO category (id, budget_id, group_id, name, kind, sort, created_at, updated_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?7)`,
          id,
          `g_${g.toLowerCase()}`,
          NAMES[id],
          id === 'invest' ? 'saving' : 'spending',
          sort++,
          now,
        ),
      );
    }
  }
  w.push(
    s.q(
      `INSERT INTO category (id, budget_id, name, kind, card_account_id, created_at, updated_at) VALUES ('pay_sapphire', ?1, 'Sapphire Preferred', 'cc_payment', 'sapphire', ?2, ?2)`,
      now,
    ),
    s.q(
      `INSERT INTO category (id, budget_id, name, kind, card_account_id, created_at, updated_at) VALUES ('pay_freedom', ?1, 'Freedom Unlimited', 'cc_payment', 'freedom', ?2, ?2)`,
      now,
    ),
  );
  const targets: [string, string, number, number, string | null, number | null][] = [
    ['rent', 'refill', 100000, 1, null, null],
    ['electric', 'refill', 9500, 1, null, null],
    ['internet', 'refill', 8000, 1, null, null],
    ['subs', 'refill', 6500, 1, null, null],
    ['groceries', 'refill', 60000, 1, null, null],
    ['dining', 'refill', 20000, 1, null, null],
    ['gas', 'refill', 12000, 1, null, null],
    ['shopping', 'refill', 20000, 1, null, null],
    ['household', 'refill', 10000, 1, null, null],
    ['health', 'refill', 7500, 1, null, null],
    ['personal', 'refill', 10000, 1, null, null],
    ['invest', 'set_aside', 150000, 1, null, null],
    ['car', 'by_date', 54000, 1, '2027-01', null],
    ['vacation', 'by_date', 300000, 1, '2027-06', null],
    ['gifts', 'refill', 17000, 1, null, null],
    ['emergency', 'by_date', 1500000, 1, '2026-12', null],
  ];
  for (const [cat, type, amount, period, tm] of targets) {
    w.push(
      s.q(
        `INSERT INTO target (id, budget_id, category_id, type, amount, period_months, period_anchor, target_month, effective_from, created_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?7, ?9)`,
        `t_${cat}`,
        cat,
        type,
        amount,
        period,
        F.START,
        tm,
        now,
      ),
    );
  }
  for (const a of F.assignments) {
    w.push(
      s.q(
        `INSERT INTO assignment (budget_id, category_id, month, amount, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
        a.categoryId,
        a.month,
        a.amount,
        now,
      ),
    );
  }
  // Rules the prototype shows: rent (2/3 owed, counts in the previous month in the first 5 days) and Trader Joe's.
  w.push(
    s.q(
      `INSERT INTO rule (id, budget_id, sort, name, conditions, actions, created_at, updated_at) VALUES ('r_rent', ?1, 1, 'Rent', ?2, ?3, ?4, ?4)`,
      JSON.stringify({
        all: [
          { field: 'payee', op: 'is', value: 'Rent' },
          { field: 'direction', op: 'is', value: 'out' },
        ],
      }),
      JSON.stringify([
        { type: 'set_category', categoryId: 'rent' },
        { type: 'previous_month_if_within_days', days: 5 },
        { type: 'mark_owed', num: 2, den: 3, minAmount: 250000, expectByDay: 15 },
      ]),
      now,
    ),
    s.q(
      `INSERT INTO rule (id, budget_id, sort, name, conditions, actions, created_at, updated_at) VALUES ('r_tj', ?1, 2, 'Trader Joe’s', ?2, ?3, ?4, ?4)`,
      JSON.stringify({ all: [{ field: 'payee', op: 'contains', value: 'Trader Joe' }] }),
      JSON.stringify([{ type: 'set_category', categoryId: 'groceries' }]),
      now,
    ),
  );
  // Transactions: bank rows for everything the bank has; manual rows for the check and the upcoming bills.
  const PAYEE_IDS = new Map<string, string>();
  for (const t of F.txns) {
    const name = PAYEES[t.key] ?? t.key;
    let pid = PAYEE_IDS.get(name);
    if (!pid) {
      pid = `py_${PAYEE_IDS.size}`;
      PAYEE_IDS.set(name, pid);
      w.push(
        s.q(
          `INSERT INTO payee (id, budget_id, name, created_at, updated_at) VALUES (?2, ?1, ?3, ?4, ?4)`,
          pid,
          name,
          now,
        ),
      );
    }
    const manual = t.key === 'n-check-1043' || t.status === 'upcoming';
    const seq = Date.parse(`${t.date}T12:00:00Z`) + (t.seq % 1000);
    if (manual) {
      w.push(
        s.q(
          `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, repeats, created_at, updated_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
          `mp_${t.key}`,
          t.key,
          t.accountId,
          t.status === 'upcoming' ? 'upcoming' : 'pending',
          t.date,
          t.amount,
          name,
          t.status === 'upcoming' ? 'monthly' : 'never',
          seq,
        ),
      );
    } else {
      const bankAmount = t.key === 'n-uber' ? -3140 : t.amount;
      w.push(
        s.q(
          `INSERT INTO bank_txn (provider_txn_id, budget_id, connection_id, provider_account_id, amount, date, pending, raw_name, merchant_name, payment_channel, txn_key, first_apply_seq, last_apply_seq, created_at, updated_at)
           VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?2, 0, 0, ?11, ?11)`,
          t.key,
          conns[ACCOUNTS[t.accountId]!.inst],
          `pa_${t.accountId}`,
          bankAmount,
          t.date,
          t.status === 'pending' ? 1 : 0,
          name.toUpperCase(),
          name,
          ACCOUNTS[t.accountId]!.type === 'credit' ? 'in store' : 'online',
          seq,
        ),
      );
    }
    const u = t.use;
    const est = t.key === 'n-uber' ? t.amount : null;
    const alertJson = t.key === 'n-shakeshack' ? JSON.stringify(['amount_changed:-2400:-2810']) : null;
    const by = t.key === 'n-tj' ? 'rule' : u.type === 'uncategorized' ? null : 'user';
    w.push(
      s.q(
        `INSERT INTO txn_overlay (txn_key, budget_id, payee_id, category_id, to_rta, income_tag, budget_month, estimated_amount, wont_clear, transfer_state, transfer_account_id, wtm_state, categorized_by, rule_id, alert, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)`,
        t.key,
        pid,
        u.type === 'category' ? u.categoryId : null,
        u.type === 'rta' ? 1 : 0,
        t.key === 'n-points' ? 'rewards' : null,
        t.budgetMonth ?? null,
        est,
        t.wontClear ? 1 : 0,
        u.type === 'transfer' ? 'paired' : u.type === 'unsorted' ? 'unsorted' : null,
        u.type === 'transfer' ? u.otherAccountId : null,
        u.type === 'waiting' ? 'waiting' : null,
        by,
        t.key === 'n-tj' ? 'r_tj' : null,
        alertJson,
        now,
      ),
    );
    if (u.type === 'split') {
      u.lines.forEach((l, i) =>
        w.push(
          s.q(
            `INSERT INTO txn_split (id, budget_id, txn_key, category_id, amount, absorbs_remainder, sort, created_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8)`,
            l.id,
            t.key,
            l.categoryId,
            l.amount,
            i === 0 ? 1 : 0,
            i,
            now,
          ),
        ),
      );
    }
    if (t.refundOf)
      w.push(
        s.q(
          `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, created_by, created_at) VALUES (?2, ?1, 'refund_of', ?3, ?4, 'user', ?5)`,
          `lk_${t.key}`,
          t.key,
          t.refundOf,
          now,
        ),
      );
    for (const o of t.owed ?? []) {
      const item = F.owedItems.find((x) => x.id === o.itemId);
      const frac = o.itemId === 'nopa' ? [1, 2] : o.itemId.startsWith('rent') ? [2, 3] : [1, 1];
      w.push(
        s.q(
          `INSERT INTO expected_reimbursement (id, budget_id, txn_key, amount, fraction_num, fraction_den, expect_by, created_at, updated_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
          o.itemId,
          t.key,
          o.amount,
          frac[0],
          frac[1],
          item?.expectBy ?? '2026-12-15',
          now,
        ),
      );
    }
  }
  for (const p of F.paybacks) {
    w.push(
      s.q(
        `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, amount, created_by, created_at) VALUES (?2, ?1, 'reimbursement_of', ?3, ?4, ?5, 'user', ?6)`,
        `pb_${p.itemId}`,
        p.inflowKey,
        p.itemId,
        p.amount,
        now,
      ),
    );
  }
  w.push(s.q(`UPDATE txn_overlay SET wtm_state = 'matched' WHERE budget_id = ?1 AND txn_key = 'n-zelle'`));
  for (let i = 0; i < w.length; i += 80) await env.DB.batch(w.slice(i, i + 80));
  // Lines, month snapshots and Ready to Assign are worked out on the phone (D-45).
  return c.json({ ok: true, budgetId: m.budgetId });
});
