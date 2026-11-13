// Categories: add, open from Budget, and reorder.
// Against the SPA in mock mode (the real engine over the November fixture, apps/web/src/mock), on phone
// (390 x 844) and desktop (1280 x 800). Split from app.spec.ts.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

test('Categories: add one to a group, then set its target', async ({ page }) => {
  await page.goto('/categories');
  await page.getByRole('link', { name: 'Add category' }).nth(1).click();
  const sheet = page.getByRole('dialog', { name: 'New category' });
  await expect(sheet.getByLabel('Group')).toHaveValue('g_everyday');
  await sheet.getByLabel('Name').fill('Climbing');
  await sheet.getByRole('button', { name: 'Add and set a target' }).click();
  const target = page.getByRole('dialog', { name: 'Target' });
  await expect(target.getByText('Climbing')).toBeVisible();
  await target.getByLabel('Have this much available').fill('40');
  await target.getByRole('button', { name: 'Save target' }).click();
  await expect(page).toHaveURL(/\/categories$/);
  await expect(page.getByText('Climbing')).toBeVisible();
});

test('Categories open from Budget, Back returns there, and old Settings links still work', async ({
  page,
}, info) => {
  await page.goto('/budget');
  // On a phone, Edit categories and Set targets sit in the menu at the top of the Budget.
  if (info.project.name === 'phone') await page.getByRole('button', { name: 'More budget actions' }).click();
  await expect(page.getByRole('link', { name: 'Set targets' }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Edit categories' }).first().click();
  await expect(page).toHaveURL(/\/categories$/);
  if (info.project.name === 'phone') {
    await page.getByRole('button', { name: 'Back to budget' }).click();
    await expect(page).toHaveURL(/\/budget/);
  }
  await page.goto('/settings/categories');
  await expect(page).toHaveURL(/\/categories$/);
  // Settings no longer lists categories; Set targets lives on Budget only.
  await expect(page.getByRole('link', { name: 'Set targets' })).toHaveCount(0);
});

test('Categories: reorder a category with the keyboard on its handle', async ({ page }) => {
  await page.goto('/categories');
  const rows = page.getByRole('link', { name: /^(Rent|Electric)/ });
  await expect(rows.first()).toContainText('Rent');
  await page.getByRole('button', { name: 'Reorder Rent' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.first()).toContainText('Electric');
});
