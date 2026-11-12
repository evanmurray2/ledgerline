// Coming back from another tab (apps/web/src/lib/back.ts): a screen opened from another tab returns there on Back,
// and a sheet opened from another tab closes back there, instead of to its own tab's list.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

test('Back: a transaction opened from a category closes back to the category', async ({ page }) => {
  await page.goto('/budget/category/groceries?month=2026-10');
  const recent = page.locator('a[href^="/activity/txn/"]').first();
  await recent.click();
  await expect(page).toHaveURL(/\/activity\/txn\/.*close=/);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/budget\/category\/groceries\?month=2026-10$/);
});

test('Back: See all on a category opens its list, and Back returns to the category', async ({ page }) => {
  await page.goto('/budget/category/groceries');
  await page.locator('[data-track="category.see_all"]').click();
  await expect(page).toHaveURL(/\/activity\?.*category=groceries/);
  await expect(page.getByText('All months')).toBeVisible();
  await page.getByRole('button', { name: 'Back to category' }).click();
  await expect(page).toHaveURL(/\/budget\/category\/groceries$/);
});

test('Back: a card opened from Budget goes back to Budget, also after opening one of its rows', async ({
  page,
}) => {
  await page.goto('/budget?month=2026-10');
  await page.locator('[data-track="budget.card"]').first().click();
  await expect(page).toHaveURL(/\/accounts\/[^/?]+\?back=/);
  // A row's sheet keeps the way back.
  await page.locator('[data-track="activity.row"]').first().click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/accounts\/[^/?]+\?back=/);
  await page.getByRole('button', { name: 'Back to budget' }).click();
  await expect(page).toHaveURL(/\/budget\?month=2026-10$/);
});

test('Back: Owed to you opened from Budget goes back to the same month', async ({ page }) => {
  await page.goto('/budget?month=2026-10');
  await page.locator('[data-track="budget.owed"]').first().click();
  await expect(page).toHaveURL(/\/owed\?back=/);
  await page.getByRole('button', { name: 'Back to budget' }).click();
  await expect(page).toHaveURL(/\/budget\?month=2026-10$/);
});

test('Back: a transaction opened from Owed to you closes back to it', async ({ page }) => {
  await page.goto('/owed');
  await page.locator('a[href^="/activity/txn/"]').first().click();
  await expect(page).toHaveURL(/\/activity\/txn\/.*close=/);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/owed$/);
});

test('Back: Sign in again from Bank connections closes back to it', async ({ page }) => {
  await page.goto('/settings/connections');
  const repair = page.locator('[data-track="connections.repair"]').first();
  test.skip((await repair.count()) === 0, 'No bank needs a sign-in in this fixture');
  await repair.click();
  await expect(page).toHaveURL(/\/accounts\/repair\/.*close=/);
  await page.getByRole('button', { name: 'Back to bank connections' }).click();
  await expect(page).toHaveURL(/\/settings\/connections$/);
});

test('Back: Assign from the sidebar closes back to the screen it opened on', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'The sidebar is on desktop only');
  await page.goto('/reports');
  await page.locator('[data-track="nav.assign"]').click();
  await expect(page).toHaveURL(/\/budget\/assign\?close=/);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/reports$/);
});
