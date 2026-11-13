// When changes are off: offline, view only for the day, and resting at 95%.
// Against the SPA in mock mode (the real engine over the November fixture, apps/web/src/mock), on phone
// (390 x 844) and desktop (1280 x 800). Split from app.spec.ts.
import { expect, test } from '@playwright/test';
import { rta } from './mock-helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

test('Offline: last data stays visible and every change is disabled', async ({ page, context }) => {
  await page.goto('/budget?view=attention');
  const cover = page.getByRole('button', { name: 'Cover $18.25 for Dining out' });
  await expect(cover).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await expect(cover).toBeDisabled();
  await expect(page.getByRole('button', { name: /Fund all/ })).toBeDisabled();
  await expect(rta(page)).toHaveText('$1,999.90');
  if (test.info().project.name === 'phone')
    await expect(page.getByText('Assign', { exact: true })).toHaveAttribute('aria-disabled', 'true');

  // Browsing still works; changing doesn't.
  await page
    .getByRole('link', { name: /Activity/ })
    .first()
    .click();
  // Activity opens on Not posted yet (D-97); the categories are under All.
  await expect(page.getByRole('button', { name: 'Not posted yet' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByText('Needs category')).toBeVisible();
  await expect(page.getByRole('button', { name: /Choose category for Amazon −\$38\.10/ })).toBeDisabled();

  await context.setOffline(false);
  await expect(page.getByTestId('offline-banner')).toBeHidden();
  await expect(page.getByRole('button', { name: /Choose category for Amazon −\$38\.10/ })).toBeEnabled();
});

test('Daily limit: read-only banner with the reset time in Pacific', async ({ page }) => {
  await page.goto('/budget?mock=readonly&view=attention');
  await expect(page.getByTestId('readonly-banner')).toContainText('View only until 4:00 PM');
  await expect(page.getByRole('button', { name: 'Cover $18.25 for Dining out' })).toBeDisabled();
});

test('Resting at 95%: a banner, and the screens worked out on the device still show', async ({ page }) => {
  await page.goto('/budget?mock=resting');
  await expect(page.getByTestId('resting-banner')).toContainText('Paused until 4:00 PM');
  // The mock stands in for the copy on the phone: Budget and Activity come from it, not from the server.
  await expect(rta(page)).toHaveText('$1,999.90');
  await page.getByRole('link', { name: 'Activity' }).first().click();
  await expect(page.getByText('Uber Eats').first()).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
