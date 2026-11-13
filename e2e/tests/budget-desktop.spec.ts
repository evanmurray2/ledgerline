// Budget on a computer: the sidebar's Assign button and the table's Assigned cells. Mock mode, desktop only.
import { expect, test, type Locator } from '@playwright/test';
import { rta } from './mock-helpers';

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

test('Desktop: type into Assigned, Tab saves and moves on, Escape puts it back', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the table is desktop only');
  await page.goto('/budget');
  const groceries = page.getByLabel('Assigned to Groceries');
  await groceries.click();
  await expect(groceries).toHaveValue('600.00');
  await groceries.fill('650');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Assigned to Dining out')).toBeFocused();
  await expect(rta(page)).toHaveText('$1,949.90');
  await expect(groceries).toHaveValue('$650.00');
  await page.keyboard.type('999');
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Assigned to Dining out')).toHaveValue('$200.00');
  await expect(rta(page)).toHaveText('$1,949.90');
});

test('Desktop: the category panel steps to the next category with the arrow keys', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the side panel is desktop only');
  await page.goto('/budget');
  await page
    .getByRole('row', { name: /Groceries/ })
    .getByRole('cell')
    .nth(1)
    .click();
  await expect(page).toHaveURL(/\/budget\/category\/groceries/);
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('dialog', { name: 'Dining out' })).toBeVisible();
  await page.getByRole('button', { name: 'Previous category' }).click();
  await expect(page.getByRole('dialog', { name: 'Groceries' })).toBeVisible();
});
