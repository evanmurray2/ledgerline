// Edge cases on Accounts, account pages, Settings → Backup and export, and Reports, through the real stack (SPA →
// Worker → local store seeded with the November fixture; "today" is Nov 14, 2026).
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page, request }) => {
  const r = await request.post('/__dev/seed-november', {
    headers: { 'content-type': 'application/json', 'x-ledgerline': '1' },
    data: {},
  });
  expect(r.ok()).toBe(true);
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

test('Register: a filter that no longer matches anything can still go back to All', async ({ page }) => {
  await page.goto('/accounts/marcus?show=pending');
  await expect(page.getByText('No transactions match.')).toBeVisible();
  // The filter on screen keeps its chip, at 0.
  await expect(page.getByRole('button', { name: /^Pending/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page).toHaveURL(/\/accounts\/marcus$/);
  await expect(page.getByText('No transactions match.')).toHaveCount(0);
});

test('Reports: a month before the budget starts shows the first month', async ({ page }) => {
  await page.goto('/reports?month=2026-01');
  await expect(page.getByTestId('month-label')).toContainText('October 2026');
  await expect(page.getByRole('button', { name: 'Previous month' })).toBeDisabled();
  await expect(page.getByText('January 2026')).toHaveCount(0);
});

test('Setup: Back to a finished setup goes to the budget, so it can’t run twice', async ({ page }) => {
  for (const path of ['/setup/categories', '/setup/link', '/setup/start', '/welcome']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/budget$/);
  }
  await expect(page.getByRole('button', { name: 'Go to my budget' })).toHaveCount(0);
});

/** No part of the screen is wider than the window (a long word would push the page sideways on a phone). */
async function noSideScroll(page: Page) {
  const wide = await page.evaluate(() =>
    Array.from(document.querySelectorAll('body *'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > window.innerWidth + 1;
      })
      .map((el) => `${el.tagName}.${el.className}`.slice(0, 80)),
  );
  expect(wide).toEqual([]);
}

test('Accounts: a long name with no spaces, and emoji, fit on the screen', async ({ page, request }) => {
  const name = 'Ünïcödé🏦Savings' + 'X'.repeat(44);
  const r = await request.post('/api/accounts/marcus/name', {
    headers: { 'content-type': 'application/json', 'x-ledgerline': '1' },
    data: { name },
  });
  expect(r.ok()).toBe(true);
  await page.goto('/accounts');
  await expect(page.getByText(name).first()).toBeVisible();
  await noSideScroll(page);
  await page.goto('/accounts/marcus');
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await noSideScroll(page);
});

test('Accounts: a name of only spaces is refused, and the old name stays', async ({ page }) => {
  await page.goto('/accounts/marcus');
  await page.getByRole('button', { name: 'More for this account' }).click();
  await page.getByRole('button', { name: 'Rename account' }).click();
  const sheet = page.getByRole('dialog', { name: 'Rename account' });
  await sheet.getByLabel('Name').fill('   ');
  await expect(sheet.getByRole('button', { name: 'Save' })).toBeDisabled();
  await sheet.getByLabel('Name').fill('  Rainy day  ');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Rainy day', exact: true })).toBeVisible();
});

test('Backup and export: only the full backup and the usage export are offered (D-81)', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('link', { name: /Backup and export/ }).click();
  await expect(page).toHaveURL(/\/settings\/data$/);
  await expect(page.getByRole('heading', { name: 'Backup and export' })).toBeVisible();
  await expect(page.getByText('Full backup', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download Usage and notes (JSON)' })).toBeVisible();
  for (const gone of ['Import past transactions', 'Choose file', 'Transactions (CSV)', 'Everything (JSON)'])
    await expect(page.getByText(gone)).toHaveCount(0);
});

test('Full backup: the file ends with its end line, and Download works twice', async ({ page }) => {
  await page.goto('/settings/data');
  for (let i = 0; i < 2; i++) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).last().click();
    const d = await download;
    const text = await (await import('node:fs/promises')).readFile((await d.path())!, 'utf8');
    const lines = text.trim().split('\n');
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ end: true });
  }
});

test('Register: each filter chip’s count is the number of rows it shows', async ({ page }) => {
  for (const id of ['sapphire', 'freedom', 'checking', 'ally', 'marcus']) {
    await page.goto(`/accounts/${id}`);
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Account');
    const chips = page.getByRole('group', { name: 'Show' }).getByRole('button');
    const names = (await chips.allTextContents()).filter((t) => !/^All/.test(t));
    for (const name of names) {
      const n = Number(/\d+$/.exec(name)![0]);
      const label = name.replace(/\d+$/, '');
      await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: label }).click();
      await expect(page.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('main a[href*="/txn/"]'), `${id} ${label}`).toHaveCount(n);
      await page
        .getByRole('group', { name: 'Show' })
        .getByRole('button', { name: 'All', exact: true })
        .click();
    }
  }
});

test('Reports: a month with more refunds than spending reads as a negative amount', async ({ page }) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  await add.getByPlaceholder('0.00').fill('20000');
  await add.getByRole('button', { name: 'In', exact: true }).click();
  await add.getByLabel('Payee').fill('Big refund');
  await add.getByLabel('Category').click();
  await page
    .getByRole('dialog', { name: 'Choose a category' })
    .getByRole('button', { name: 'Groceries' })
    .first()
    .click();
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add).toHaveCount(0);
  await page.goto('/reports');
  if (test.info().project.name === 'phone') await page.getByRole('button', { name: 'Trends' }).click();
  const chart = page.getByRole('img', { name: /^Spending by month/ });
  await expect(chart).toHaveAttribute('aria-label', /Nov −\$[\d.,]+k? so far/);
  await expect(chart).not.toHaveAttribute('aria-label', /\$-/);
});
