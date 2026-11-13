// Settings: dark mode, sign-in and devices, and bank connections.
// Against the SPA in mock mode (the real engine over the November fixture, apps/web/src/mock), on phone
// (390 x 844) and desktop (1280 x 800). Split from app.spec.ts.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

test('Settings: the dark mode toggle switches data-theme', async ({ page }) => {
  await page.goto('/settings');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await page.getByRole('radio', { name: /^Dark/ }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => window.localStorage.getItem('ledgerline-theme'))).toBe('dark');
  await page.getByRole('radio', { name: /^Light/ }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
});

test('Match device follows the system color scheme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /^Match device/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('Sign-in and devices: Sign out under this device, sign out another, add one, rename a passkey', async ({
  page,
}) => {
  await page.goto('/settings');
  await page.getByRole('link', { name: /^Sign-in and devices/ }).click();
  await expect(page).toHaveURL(/\/settings\/sign-in$/);
  await expect(page.getByText('iPhone · Home Screen app')).toBeVisible();
  // This device's Sign out sits right under it; it asks first, and says the budget saved here is deleted.
  await page.getByRole('button', { name: 'Sign out…', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: 'Sign out of this device' })).toContainText(
    'delete the budget saved on this device',
  );
  await page.getByRole('button', { name: 'Keep it' }).click();
  // Another device: its own Sign out, which also deletes the budget saved on it. No "all other devices".
  await expect(page.getByRole('button', { name: /all other devices/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out Mac · Safari…' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('It also deletes the budget saved on it.');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Mac · Safari is signed out')).toBeVisible();
  await expect(
    page.getByText('No other devices. Add one to use Ledgerline on a computer or iPad.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add a device' }).click();
  await expect(page.getByLabel('Device link')).toHaveValue(/\/add-device#/);
  // Rename the passkey after where it's saved.
  await page.getByRole('button', { name: 'Rename passkey iPhone' }).click();
  await page.getByLabel('Passkey name').fill('Apple Passwords');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Apple Passwords', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Passkey name')).toHaveCount(0);
});

test('Bank connections confirm before linking and update the meter', async ({ page }) => {
  await page.goto('/settings/connections');
  await expect(page.getByTestId('link-meter')).toHaveText('4 of 10 bank links used');
  await page.getByRole('button', { name: /Link another bank/ }).click();
  await expect(page.getByText('Use 1 of your 6 bank links?')).toBeVisible();
  await page.getByRole('button', { name: 'Link a bank' }).click();
  await expect(page.getByTestId('link-meter')).toHaveText('5 of 10 bank links used');
});
