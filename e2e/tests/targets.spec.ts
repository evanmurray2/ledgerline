// Set targets and a category’s target.
// Against the SPA in mock mode (the real engine over the November fixture, apps/web/src/mock), on phone
// (390 x 844) and desktop (1280 x 800). Split from app.spec.ts.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

test('Set targets: a page like Categories, and saving a target comes back to it', async ({ page }, info) => {
  await page.goto('/budget?month=2026-10');
  if (info.project.name === 'phone') await page.getByRole('button', { name: 'More budget actions' }).click();
  await page.getByRole('link', { name: 'Set targets' }).first().click();
  await expect(page).toHaveURL(/\/targets\?month=2026-10/);
  await expect(page.getByRole('heading', { name: 'Set targets' })).toBeVisible();
  await page.getByRole('link', { name: /^Home repairs/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Target' });
  await sheet.getByLabel('Have this much available').fill('50');
  await sheet.getByRole('button', { name: 'Save target' }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/\/targets\?month=2026-10/);
  // Back returns to the Budget month it came from.
  await page.getByRole('button', { name: 'Back to budget' }).click();
  await expect(page).toHaveURL(/\/budget\?month=2026-10/);
});

test('Set targets: old links to the sheet open the page', async ({ page }) => {
  await page.goto('/budget/targets');
  await expect(page).toHaveURL(/\/targets$/);
  await expect(page.getByRole('heading', { name: 'Set targets' })).toBeVisible();
});

test('Target: saving from a category goes back to the Budget, not the category', async ({ page }) => {
  await page.goto('/budget/category/groceries/target');
  await page.getByRole('button', { name: 'Save target' }).click();
  await expect(page).toHaveURL(/\/budget(\?.*)?$/);
});

test('Target: a new kind starts empty instead of reusing the old amount', async ({ page }) => {
  await page.goto('/budget/category/vacation/target');
  const sheet = page.getByRole('dialog', { name: 'Target' });
  await expect(sheet.getByLabel('Reach a balance of')).toHaveValue('3000.00');
  await sheet.getByRole('button', { name: /Set aside/ }).click();
  await expect(sheet.getByLabel('Set aside every month')).toHaveValue('');
  await sheet.getByRole('button', { name: /Balance by a date/ }).click();
  await expect(sheet.getByLabel('Reach a balance of')).toHaveValue('3000.00');
});
