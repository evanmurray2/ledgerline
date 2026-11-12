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
  { name: 'activity', path: '/activity?filter=all', ready: 'Needs category' },
  { name: 'activity-pending', path: '/activity?filter=pending', ready: 'Upcoming' },
  {
    name: 'activity-picker',
    path: '/activity?filter=all',
    ready: 'Needs category',
    prepare: async (p) => {
      await p.getByRole('button', { name: /Choose category for Blue Bottle Coffee/ }).click();
      await p.getByRole('dialog', { name: 'Choose a category' }).waitFor();
    },
  },
  { name: 'txn-pending', path: '/activity/txn/n-uber', ready: 'Bank amount' },
  { name: 'txn-posted', path: '/activity/txn/n-tj', ready: 'Set by' },
  { name: 'txn-income', path: '/activity/txn/n-payroll', ready: 'Goes to' },
  { name: 'txn-refund', path: '/accounts/sapphire/txn/n-rei-refund', ready: 'Refund of' },
  { name: 'txn-paid', path: '/activity/txn/n-zelle', ready: 'Pays back' },
  { name: 'txn-transfer', path: '/activity/txn/n-to-marcus', ready: 'Transfer' },
  { name: 'split', path: '/accounts/sapphire/txn/n-costco/split', ready: 'Takes any difference' },
  { name: 'match', path: '/activity/match/n-venmo', ready: 'What does this money pay back?' },
  { name: 'check-pending', path: '/activity/check/n-check-1043', ready: 'Keep waiting' },
  { name: 'add', path: '/activity/add', ready: 'Add a transaction' },
  { name: 'accounts', path: '/accounts', ready: 'Net worth' },
  { name: 'register-sapphire', path: '/accounts/sapphire', ready: 'You owe the bank' },
  { name: 'register-freedom', path: '/accounts/freedom', ready: 'You owe the bank' },
  { name: 'register-checking', path: '/accounts/checking', ready: 'Balance at bank' },
  { name: 'repair', path: '/accounts/repair/con_ally', ready: 'Sign in to Ally' },
  { name: 'reports', path: '/reports', ready: 'Groceries' },
  { name: 'settings', path: '/settings', ready: 'Record how I use the app' },
  { name: 'categories', path: '/categories', ready: 'Groceries' },
  { name: 'category-edit', path: '/categories/groceries', ready: 'Edit category' },
  { name: 'payees', path: '/settings/payees', ready: 'Trader Joe’s' },
  {
    name: 'payee-rename',
    path: '/settings/payees',
    ready: 'Uber Eats',
    prepare: async (p) => {
      await p.getByRole('link', { name: 'Rename Uber Eats' }).click();
      await p.getByText('Show as').first().waitFor();
    },
  },
  { name: 'connections', path: '/settings/connections', ready: '4 of 10 bank links used' },
  { name: 'data', path: '/settings/data', ready: 'Full backup' },
  { name: 'sign-in', path: '/settings/sign-in', ready: 'Other devices' },
  { name: 'state-empty', path: '/budget?mock=empty', ready: 'a job' },
  { name: 'state-readonly', path: '/budget?mock=readonly', ready: 'View only until' },
  {
    name: 'state-sync',
    path: '/accounts?mock=syncfail',
    ready: '2 banks need you',
    // Several problems fold into one banner: open it to show each.
    prepare: async (p) => {
      await p.getByRole('button', { name: '2 banks need you' }).click();
      await p.getByText('Sync now').waitFor();
    },
  },
  { name: 'state-newmonth', path: '/budget?mock=newmonth', ready: 'has started' },
  {
    name: 'state-overassigned',
    path: '/budget/assign',
    ready: 'Suggested',
    prepare: async (p) => {
      const checked = p.getByRole('checkbox', { checked: true });
      while ((await checked.count()) > 0) await checked.first().uncheck();
      await p.getByLabel('Category').click();
      await p
        .getByRole('dialog', { name: 'Choose a category' })
        .getByRole('button', { name: /^Vacation/ })
        .click();
      await p.getByLabel('Amount').fill('1000');
      await p.getByRole('button', { name: 'Assign anyway' }).click();
      await p.getByText('more than you have').first().waitFor();
    },
  },
  { name: 'welcome', path: '/welcome?mock=firstrun', ready: 'Get started' },
  { name: 'setup-start', path: '/setup/start?mock=firstrun', ready: 'Your budget starts' },
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
      // Sheets and banners finish moving in (looping animations, such as a spinner, are left running).
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)),
        ),
      );
      await page.screenshot({ path: `screenshots/${info.project.name}-${theme}-${s.name}.png` });
    });
  }
}
