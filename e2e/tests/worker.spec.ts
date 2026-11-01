// The prototype's November through the real stack: SPA → Worker → local D1 (seeded fixture) → Money rules.
import { expect, test, type Page } from '@playwright/test';

const rta = (page: Page) => page.getByTestId(test.info().project.name === 'desktop' ? 'nav-rta' : 'rta');

test.beforeEach(async ({ page, request }) => {
  const r = await request.post('/__dev/seed-november', {
    headers: { 'content-type': 'application/json', 'x-ledgerline': '1' },
    data: {},
  });
  expect(r.ok()).toBe(true);
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

test('Budget shows the November numbers from the Worker', async ({ page }) => {
  await page.goto('/budget');
  await expect(rta(page)).toHaveText('$981.90');
  if (test.info().project.name === 'phone') {
    // Group totals appear on the phone layout; the desktop table shows group names only, as in the prototype.
    await expect(page.getByText('$1,121.85').first()).toBeVisible();
    await expect(page.getByText('$441.45').first()).toBeVisible();
    await expect(page.getByText('$18,877.63').first()).toBeVisible();
  } else {
    await expect(page.getByRole('cell', { name: '$212.40' })).toBeVisible();
  }
  await expect(page.getByText('$878.32').first()).toBeVisible();
  await expect(page.getByText('$1,430.60 out').first()).toBeVisible();
});

test('Needs attention fixes reach $643.65 through the API', async ({ page }) => {
  await page.goto('/budget?view=attention');
  await expect(rta(page)).toHaveText('$981.90');
  for (const [name, after] of [
    ['Cover $18.25 for Dining out', '$963.65'],
    ['Fund $90.00 for Car insurance', '$873.65'],
    ['Fund $250.00 for Vacation', '$623.65'],
    ['Add $20.00 for Personal care', '$603.65'],
    ['Move $40.00 for Gifts', '$643.65'],
  ] as const) {
    await page.getByRole('button', { name }).click();
    await expect(rta(page)).toHaveText(after);
  }
  await page.reload();
  await expect(rta(page)).toHaveText('$643.65');
});

test('Activity: categorizing an uncategorized purchase persists', async ({ page }) => {
  await page.goto('/activity');
  await page.getByRole('button', { name: /Choose category for Amazon −\$38\.10/ }).click();
  await page
    .getByRole('dialog', { name: 'Choose a category' })
    .getByRole('button', { name: 'Shopping' })
    .first()
    .click();
  await expect(page.getByRole('button', { name: /Change category for Amazon −\$38\.10/ })).toHaveText(
    'Shopping',
  );
  await page.reload();
  await expect(page.getByRole('button', { name: /Choose category for Amazon −\$38\.10/ })).toHaveCount(0);
});

test('Accounts: net worth and the Ally repair prompt', async ({ page }) => {
  await page.goto('/accounts');
  await expect(page.getByText('$22,555.35').first()).toBeVisible();
  await expect(page.getByText(/Ally/).first()).toBeVisible();
});

test('Settings → Categories: rename a group, reorder, and remove a category', async ({ page }) => {
  await page.goto('/settings/categories');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const groups = page.locator('section').getByRole('heading', { level: 2 });
  // Card payments come first and are made by the app; your groups follow.
  await expect(groups.nth(1)).toHaveText('Bills');
  await expect(groups.nth(2)).toHaveText('Everyday');
  await page.getByRole('button', { name: 'Move group Bills down' }).click();
  await expect(groups.nth(1)).toHaveText('Everyday');
  await expect(groups.nth(2)).toHaveText('Bills');

  await page.getByRole('link', { name: 'Rename group Everyday' }).click();
  const sheet = page.getByRole('dialog', { name: 'Rename group' });
  await sheet.getByLabel('Name').fill('Day to day');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(groups.nth(1)).toHaveText('Day to day');

  await page.getByRole('button', { name: 'Remove Dining out' }).click();
  await expect(page.getByText('Dining out archived: it has history, so reports keep it')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Dining out' })).toHaveCount(0);
});
