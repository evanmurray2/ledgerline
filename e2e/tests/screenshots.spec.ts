// Screenshots of the main screens in both themes, for comparing against the prototype by eye. Written to
// e2e/screenshots/ (gitignored). Runs against the mock API. CI keeps nothing, so it takes every screen in light and
// only the Budget in dark (the theme switch is the same code on every screen); local runs take both themes.
import { test, type Page } from '@playwright/test';

const PHONE_ONLY = new Set(['welcome', 'setup-start', 'setup-link', 'setup-categories']);

const SCREENS: { name: string; path: string; ready?: string; prepare?: (page: Page) => Promise<void> }[] = [
  { name: 'budget', path: '/budget', ready: 'Groceries' },
  { name: 'budget-attention', path: '/budget?view=attention', ready: 'Fund all' },
  { name: 'category', path: '/budget/category/groceries', ready: 'Target' },
  { name: 'target', path: '/budget/category/groceries/target', ready: 'What kind of target?' },
  { name: 'assign', path: '/budget/assign', ready: 'Suggested' },
  { name: 'owed', path: '/owed', ready: 'Still owed' },
  { name: 'close', path: '/owed/close/rent', ready: 'They won’t pay it' },
  { name: 'activity', path: '/activity', ready: 'Money to match' },
  { name: 'activity-pending', path: '/activity?filter=pending', ready: 'Upcoming' },
  {
    name: 'activity-picker',
    path: '/activity',
    ready: 'Needs category',
    prepare: async (p) => {
      await p.getByRole('button', { name: /Choose category for Blue Bottle Coffee/ }).click();
      await p.getByRole('dialog', { name: 'Choose a category' }).waitFor();
    },
  },
  { name: 'txn-pending', path: '/activity/txn/uber', ready: 'Bank amount' },
  { name: 'txn-posted', path: '/activity/txn/tj', ready: 'Set by rule 3' },
  { name: 'txn-income', path: '/activity/txn/payroll', ready: 'Goes to' },
  { name: 'txn-refund', path: '/accounts/sapphire/txn/rei', ready: 'Refund of' },
  { name: 'txn-paid', path: '/activity/txn/zelle', ready: 'Pays back' },
  { name: 'txn-transfer', path: '/activity/txn/auto', ready: 'Paired automatically' },
  { name: 'split', path: '/accounts/sapphire/txn/costco/split', ready: 'Takes any difference' },
  { name: 'match', path: '/activity/match/venmo', ready: 'What is this money?' },
  { name: 'transfer-pick', path: '/activity/transfer/xfer', ready: 'Marcus Savings' },
  { name: 'check-pending', path: '/activity/check/check', ready: 'Keep waiting' },
  { name: 'add', path: '/activity/add', ready: 'Already happened' },
  { name: 'accounts', path: '/accounts', ready: 'Net worth' },
  { name: 'register-sapphire', path: '/accounts/sapphire', ready: 'You owe the bank' },
  { name: 'register-freedom', path: '/accounts/freedom', ready: 'You owe the bank' },
  { name: 'register-checking', path: '/accounts/chk', ready: 'Balance at bank' },
  { name: 'repair', path: '/accounts/repair/c-ally', ready: 'Sign in to Ally' },
  { name: 'reports', path: '/reports', ready: 'Groceries' },
  { name: 'settings', path: '/settings', ready: 'Record how I use the app' },
  { name: 'categories', path: '/settings/categories', ready: 'Groceries' },
  { name: 'category-edit', path: '/settings/categories/groceries', ready: 'Edit category' },
  { name: 'rules', path: '/settings/rules', ready: 'Trader Joe’s' },
  { name: 'rule', path: '/settings/rules/r1', ready: 'When all of these match' },
  { name: 'payees', path: '/settings/payees', ready: 'Looks like the same payee' },
  { name: 'payee-rename', path: '/settings/payees/p-uber', ready: 'Show as' },
  { name: 'connections', path: '/settings/connections', ready: '4 of 10 links used' },
  { name: 'data', path: '/settings/data', ready: 'Import past transactions' },
  { name: 'state-empty', path: '/budget?mock=empty', ready: 'a job' },
  { name: 'state-readonly', path: '/budget?mock=readonly', ready: 'View only until' },
  { name: 'state-sync', path: '/accounts?mock=syncfail', ready: 'Try now' },
  { name: 'state-newmonth', path: '/budget?mock=newmonth', ready: 'has started' },
  {
    name: 'state-overassigned',
    path: '/budget/assign',
    ready: 'Suggested',
    prepare: async (p) => {
      const checked = p.getByRole('checkbox', { checked: true });
      while ((await checked.count()) > 0) await checked.first().uncheck();
      await p.getByLabel('Category').selectOption({ label: 'Vacation' });
      await p.getByLabel('Amount').fill('1000');
      await p.getByRole('button', { name: 'Assign anyway' }).click();
      await p.getByText('more than you have').first().waitFor();
    },
  },
  { name: 'welcome', path: '/welcome?mock=firstrun', ready: 'Get started' },
  { name: 'setup-start', path: '/setup/start?mock=firstrun', ready: 'When does your budget start?' },
  { name: 'setup-link', path: '/setup/link?mock=firstrun', ready: 'Link your banks and cards' },
  { name: 'setup-categories', path: '/setup/categories?mock=firstrun', ready: 'Make your categories' },
];

for (const theme of ['light', 'dark'] as const) {
  for (const s of SCREENS) {
    if (process.env.CI && theme === 'dark' && s.name !== 'budget') continue;
    test(`${theme} ${s.name}`, async ({ page }, info) => {
      test.skip(info.project.name === 'desktop' && PHONE_ONLY.has(s.name), 'phone only');
      await page.addInitScript((t) => window.localStorage.setItem('ledgerline-theme', t), theme);
      await page.goto(s.path);
      if (s.ready) await page.getByText(s.ready).first().waitFor();
      if (s.prepare) await s.prepare(page);
      await page.waitForTimeout(350);
      await page.screenshot({ path: `screenshots/${info.project.name}-${theme}-${s.name}.png` });
    });
  }
}
