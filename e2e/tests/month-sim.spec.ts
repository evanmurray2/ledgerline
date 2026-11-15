// A simulated month of messy bank use through the real Worker and the fake Plaid (playwright.bank.config.ts, hunt
// `month-sim` in docs/hunts.md): the owner links a checking account and a card, then each "day" the fake bank brings
// a pending row that posts with another amount, a refund, a card purchase, a card payment, a changed and a removed
// row, a spell when the bank stops syncing, and a paycheck. After each day the app's numbers must still balance:
// net worth is what the rows add up to, no account differs from its bank, and a second device that builds the budget
// from the log alone shows the same numbers. Ready to Assign is recorded, not checked: the e2e server's clock stands
// still, so every day's rows arrive in the link's first hour and count as in the balance at link (D-67,
// FIRST_SYNC_MS in packages/domain/src/budget/start.ts), which no real month does.
import { expect, test, type Page } from '@playwright/test';
import { call, comeBack, lockNewBudget, newDevice } from './lock-helpers';

const today = () => new Date().toISOString().slice(0, 10);

/** The fake Plaid of this project's Worker (playwright.bank.config.ts): its port is the Worker's plus 100. */
const plaid = async (path: string, body: unknown) => {
  const worker = new URL(test.info().project.use.baseURL!);
  const r = await fetch(`http://localhost:${Number(worker.port) + 100}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
};

type Acct = 'e2e-checking' | 'e2e-card';
/** A bank row as Plaid sends it: outflow positive. */
const row = (
  id: string,
  account: Acct,
  amount: number,
  name: string,
  extra: Record<string, unknown> = {},
) => ({
  transaction_id: id,
  account_id: account,
  amount,
  date: today(),
  authorized_date: today(),
  pending: false,
  pending_transaction_id: null,
  name,
  original_description: name,
  merchant_name: name,
  merchant_entity_id: null,
  payment_channel: 'in store',
  personal_finance_category: null,
  iso_currency_code: 'USD',
  ...extra,
});

/** The fake bank's two accounts at their balances (dollars): checking holds money, the card owes it. */
const accounts = (checking: number, card: number, checkingAvailable = checking) => [
  {
    account_id: 'e2e-checking',
    name: 'E2E Checking',
    official_name: null,
    type: 'depository',
    subtype: 'checking',
    mask: '0001',
    balances: { current: checking, available: checkingAvailable, limit: null, iso_currency_code: 'USD' },
  },
  {
    account_id: 'e2e-card',
    name: 'E2E Card',
    official_name: null,
    type: 'credit',
    subtype: 'credit card',
    mask: '0002',
    balances: { current: card, available: 5000 - card, limit: 5000, iso_currency_code: 'USD' },
  },
];

const money = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the app shows on Accounts: net worth and any "differs from bank" lines. */
async function accountsView(page: Page) {
  await page.goto('/accounts');
  await expect(page.getByTestId('net-worth')).toBeVisible({ timeout: 30_000 });
  return {
    netWorth: (await page.getByTestId('net-worth').textContent())?.trim() ?? '',
    drift: await page.getByTestId('bank-drift').allTextContents(),
    pending: await page.getByTestId('pending-in-bank').allTextContents(),
    // Recorded, not checked: what Ready to Assign should be is a Money rule (docs/sync-spec.md).
    rta: (
      await page.getByText('Ready to Assign', { exact: true }).locator('..').locator('.tnum').textContent()
    )?.trim(),
  };
}

/** Asks the Worker to fetch the bank, and comes back to the app until the device has filed a new run. */
async function fetchDay(page: Page, appended: string[]) {
  const before = appended.length;
  expect((await call(page, 'POST', '/api/settings/connections/refresh')).json).toEqual({
    ok: true,
    started: 1,
  });
  await expect
    .poll(
      async () => {
        if (appended.length > before) return true;
        await comeBack(page);
        return false;
      },
      { timeout: 90_000, intervals: [2_000] },
    )
    .toBe(true);
}

test('a month of messy bank use: after each day the numbers still balance', async ({ browser }) => {
  test.setTimeout(600_000);
  const page = await newDevice(browser, '198.51.100.51');
  const appended: string[] = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/log/append') appended.push(String(r.status()));
  });
  // The link's first run: checking at $1,250.50 (its two rows today are in that balance), the card owes $300.
  await plaid('/control/accounts', { accounts: accounts(1250.5, 300) });
  let key = '';

  await test.step('the owner locks a budget and links the fake bank', async () => {
    await page.goto('/budget');
    await page.getByLabel('Setup code').fill('e2e-setup-code-0123456789abcdefghijklmnop');
    await page.getByRole('button', { name: 'Create passkey' }).click();
    key = await lockNewBudget(page);
    await expect(page).toHaveURL(/\/welcome/, { timeout: 30_000 });
    await page.getByRole('link', { name: 'Get started' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Link a bank' }).click();
    const tokenAsked = page.waitForResponse((r) => r.url().endsWith('/api/settings/connections/link-token'));
    await page.getByRole('alertdialog').getByRole('button', { name: 'Link a bank' }).click();
    const confirm = page.getByRole('dialog').getByRole('button', { name: 'Use passkey' });
    await Promise.race([tokenAsked, confirm.waitFor({ timeout: 15_000 }).then(() => confirm.click())]).catch(
      () => undefined,
    );
    await page.waitForURL(/\/setup\/link/, { timeout: 30_000 });
    await expect
      .poll(
        async () => {
          if ((await page.getByText('E2E Bank').count()) > 0) return true;
          await comeBack(page);
          return false;
        },
        { timeout: 90_000, intervals: [2_000] },
      )
      .toBe(true);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Go to my budget' }).click();
    await expect(page).toHaveURL(/\/budget/, { timeout: 30_000 });
  });

  // Each day: what the bank sends, its balances after it, and the net worth the app must show.
  const days: {
    name: string;
    send?: { added?: unknown[]; modified?: unknown[]; removed?: unknown[] };
    checking: number;
    checkingAvailable?: number;
    card: number;
    netWorth: number;
    fail?: string;
  }[] = [
    { name: 'day 0: as linked', checking: 1250.5, card: 300, netWorth: 950.5 },
    {
      name: 'day 1: a pending coffee',
      send: { added: [row('p-coffee', 'e2e-checking', 5.25, 'E2E CAFE', { pending: true })] },
      checking: 1250.5,
      checkingAvailable: 1245.25,
      card: 300,
      netWorth: 945.25,
    },
    {
      name: 'day 2: the coffee posts with a tip',
      send: {
        removed: [{ transaction_id: 'p-coffee', account_id: 'e2e-checking' }],
        added: [row('t-coffee', 'e2e-checking', 6.25, 'E2E CAFE', { pending_transaction_id: 'p-coffee' })],
      },
      checking: 1244.25,
      card: 300,
      netWorth: 944.25,
    },
    {
      name: 'day 3: the bookshop refunds',
      send: { added: [row('t-refund', 'e2e-checking', -18, 'E2E BOOKSHOP')] },
      checking: 1262.25,
      card: 300,
      netWorth: 962.25,
    },
    {
      name: 'day 4: a card purchase',
      send: { added: [row('t-shoes', 'e2e-card', 120, 'E2E SHOES')] },
      checking: 1262.25,
      card: 420,
      netWorth: 842.25,
    },
    {
      name: 'day 5: a card payment from checking',
      send: {
        added: [
          row('t-pay-out', 'e2e-checking', 200, 'E2E CARD PAYMENT'),
          row('t-pay-in', 'e2e-card', -200, 'PAYMENT THANK YOU'),
        ],
      },
      checking: 1062.25,
      card: 220,
      netWorth: 842.25,
    },
    {
      name: 'day 6: the bank changes the shoes to $110',
      send: { modified: [row('t-shoes', 'e2e-card', 110, 'E2E SHOES')] },
      checking: 1062.25,
      card: 210,
      netWorth: 852.25,
    },
    {
      name: 'day 7: the bank takes the refund back out',
      send: { removed: [{ transaction_id: 't-refund', account_id: 'e2e-checking' }] },
      checking: 1044.25,
      card: 210,
      netWorth: 834.25,
    },
    {
      name: 'day 7b: a gift comes in',
      send: { added: [row('t-gift', 'e2e-checking', -50, 'E2E GIFT')] },
      checking: 1094.25,
      card: 210,
      netWorth: 884.25,
    },
    {
      name: 'day 8: the bank stops syncing',
      fail: 'ITEM_LOGIN_REQUIRED',
      checking: 1094.25,
      card: 210,
      netWorth: 884.25,
    },
    {
      name: 'day 9: the bank works again, and a paycheck comes',
      send: { added: [row('t-pay', 'e2e-checking', -2000, 'E2E PAYROLL')] },
      checking: 3094.25,
      card: 210,
      netWorth: 2884.25,
    },
  ];

  const found: string[] = [];
  for (const d of days) {
    await test.step(d.name, async () => {
      if (d.fail) {
        await plaid('/control/fail', { code: d.fail });
        await call(page, 'POST', '/api/settings/connections/refresh');
        // The server marks the link "needs repair"; Accounts must say so (it said nothing before Nov 15, 2026).
        const banner = page.getByText('E2E Bank needs you to sign in again');
        await expect
          .poll(
            async () => {
              await page.goto('/accounts');
              return banner
                .waitFor({ timeout: 15_000 })
                .then(() => true)
                .catch(() => false);
            },
            { timeout: 60_000, intervals: [2_000] },
          )
          .toBe(true);
        await page.screenshot({
          path: test.info().outputPath(`${d.name} (needs sign-in).png`),
          fullPage: true,
        });
        // The person signs in again on the (fake) hosted Link; the bank works again.
        await plaid('/control/fail', {});
        await banner.click();
        await page.getByRole('button', { name: 'Sign in to E2E Bank' }).click();
        const confirm = page.getByRole('dialog').getByRole('button', { name: 'Use passkey' });
        await confirm.click({ timeout: 10_000 }).catch(() => undefined);
        await expect
          .poll(
            async () =>
              (
                (await call(page, 'GET', '/api/settings/connections')).json as {
                  items: { status: string }[];
                }
              ).items[0]?.status,
            { timeout: 60_000 },
          )
          .toBe('ok');
      } else if (d.send) {
        await plaid('/control/day', {
          accounts: accounts(d.checking, d.card, d.checkingAvailable),
          ...d.send,
        });
        await fetchDay(page, appended);
      }
      let v = await accountsView(page);
      // Filing can land a moment after the append: give it a few tries before it counts as wrong.
      for (let i = 0; i < 5 && v.netWorth !== money(d.netWorth); i++) {
        await comeBack(page);
        await page.waitForTimeout(2_000);
        v = await accountsView(page);
      }
      await page.screenshot({ path: test.info().outputPath(`${d.name}.png`), fullPage: true });
      const line = `${d.name}: net worth ${v.netWorth} (want ${money(d.netWorth)}); drift ${JSON.stringify(v.drift)}; pending ${JSON.stringify(v.pending)}; ready to assign ${v.rta}`;
      console.log(line);
      if (v.netWorth !== money(d.netWorth) || v.drift.length) found.push(line);
    });
  }
  // A second device builds the budget from the log alone: it must show the same numbers.
  const other = await newDevice(browser, '198.51.100.52');
  await other.goto('/budget');
  await other.getByRole('button', { name: 'Use your recovery key' }).click();
  await other.getByTestId('recovery-key-typed').fill(key);
  await other.getByRole('button', { name: 'Continue' }).click();
  await expect(other.getByText('Groceries').first()).toBeVisible({ timeout: 60_000 });
  await page.goto('/budget');
  await other.goto('/budget');
  const rtaOf = async (p: Page) => {
    await expect(p.getByText('Ready to Assign', { exact: true })).toBeVisible({ timeout: 30_000 });
    return (
      await p.getByText('Ready to Assign', { exact: true }).locator('..').locator('.tnum').textContent()
    )?.trim();
  };
  expect(await rtaOf(other)).toBe(await rtaOf(page));
  await other.goto('/accounts');
  await expect(other.getByTestId('net-worth')).toHaveText(money(days.at(-1)!.netWorth), { timeout: 30_000 });
  await other.context().close();
  expect(found).toEqual([]);
  await page.context().close();
});
