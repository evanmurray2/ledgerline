// Payees: rename, search and join.
// Against the SPA in mock mode (the real engine over the November fixture, apps/web/src/mock), on phone
// (390 x 844) and desktop (1280 x 800). Split from app.spec.ts.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

test('Rename payee: the same sheet from a transaction and from Settings', async ({ page }) => {
  await page.goto('/activity/txn/n-uber');
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('link', { name: 'Rename payee' }).click();
  let sheet = page.getByRole('dialog', { name: 'Rename payee' });
  await expect(sheet.getByRole('heading', { name: 'Rename payee' })).toBeVisible();
  await expect(sheet.getByText('Bank names')).toBeVisible();
  await sheet.getByLabel('Show as').fill('Uber rides');
  await sheet.getByRole('button', { name: 'Save name' }).click();
  await expect(sheet).toBeHidden();

  await page.goto('/settings/payees');
  await page.getByRole('link', { name: 'Rename Uber Eats' }).click();
  sheet = page.getByRole('dialog', { name: 'Rename payee' });
  await expect(sheet.getByRole('heading', { name: 'Rename payee' })).toBeVisible();
  await expect(sheet.getByText('UBER EATS')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Save name' })).toBeVisible();
});

test('Payees: search by bank text, and renaming to another payee’s name joins them, with Undo', async ({
  page,
}) => {
  await page.goto('/settings/payees');
  await expect(page.getByText('Looks like the same payee')).toHaveCount(0);
  await page.getByLabel('Search payees').fill('BLUEBOTTLECOFFEE');
  await expect(page.getByRole('link', { name: 'Rename Bluebottle Coffee' })).toBeVisible();
  await page.getByRole('link', { name: 'Rename Bluebottle Coffee' }).click();
  const sheet = page.getByRole('dialog', { name: 'Rename payee' });
  await sheet.getByLabel('Show as').fill('Blue');
  // Payees starting with what you typed are offered as chips.
  await sheet.getByRole('button', { name: 'Blue Bottle Coffee' }).click();
  await expect(
    sheet.getByText('You have a payee named Blue Bottle Coffee. Saving joins them.'),
  ).toBeVisible();
  await sheet.getByRole('button', { name: 'Join payees' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Joined into Blue Bottle Coffee' })).toBeVisible();
  await page.getByLabel('Search payees').fill('');
  await expect(page.getByRole('link', { name: 'Rename Bluebottle Coffee' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Rename Blue Bottle Coffee' })).toContainText('4 transactions');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('link', { name: 'Rename Bluebottle Coffee' })).toBeVisible();
});
