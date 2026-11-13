// Budget on a computer: the sidebar's Assign button and the table's Assigned cells. Mock mode, desktop only.
import { expect, test, type Locator } from '@playwright/test';

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the sidebar and the table are desktop only');
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

/** True when the text box shows all of its text. */
const fits = (box: Locator) => box.evaluate((el) => el.scrollWidth <= el.clientWidth);

test('Desktop: the grayed-out Assign button says why, offline and view only', async ({ page, context }) => {
  await page.goto('/budget?mock=readonly');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const assign = nav.getByTestId('blocked-action');
  await expect(assign).toHaveAttribute('aria-disabled', 'true');
  await expect(nav.getByTestId('blocked-why')).toHaveText('View only until 4:00 PM');
  await expect(assign).toHaveAccessibleDescription('View only until 4:00 PM');
  await assign.dispatchEvent('click');
  await expect(page.getByText('View only until 4:00 PM. Nothing is lost.')).toBeVisible();

  await page.goto('/budget');
  await expect(page.getByTestId('nav-rta')).toHaveText('$1,999.90');
  await expect(nav.getByTestId('blocked-why')).toHaveCount(0);
  await context.setOffline(true);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await expect(nav.getByTestId('blocked-why')).toHaveText('You’re offline');
  await context.setOffline(false);
  await expect(nav.getByTestId('blocked-why')).toHaveCount(0);
});

test('Desktop: Assigned shows $99,999,999.99 whole, also with the side panel open', async ({ page }) => {
  await page.goto('/budget');
  const groceries = page.getByLabel('Assigned to Groceries');
  const dining = page.getByLabel('Assigned to Dining out');
  await dining.click();
  await dining.fill('-99999999.99');
  await page.keyboard.press('Enter');
  await groceries.click();
  await groceries.fill('99999999.99');
  await page.keyboard.press('Enter');
  await expect(groceries).toHaveValue('$99,999,999.99');
  await expect(dining).toHaveValue('−$99,999,999.99');
  expect(await fits(groceries)).toBe(true);
  expect(await fits(dining)).toBe(true);
  // A category's side panel narrows the table: Spent drops out, and Assigned still fits.
  await page.getByRole('row', { name: /Gas/ }).getByRole('cell').nth(2).click();
  await expect(page).toHaveURL(/\/budget\/category\/gas/);
  expect(await fits(groceries)).toBe(true);
  expect(await fits(dining)).toBe(true);
});
