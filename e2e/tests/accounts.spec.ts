// End-to-end flows on Accounts and an account's page, against the SPA in mock mode (the real engine over the November
// fixture, apps/web/src/mock), on phone (390 x 844) and desktop (1280 x 800). Split from app.spec.ts.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

test('An account’s starting balance opens a sheet with each step (D-67)', async ({ page }) => {
  await page.goto('/accounts/sapphire');
  await page.getByRole('button', { name: /^Starting debt/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Starting debt' });
  await expect(sheet.getByText('Owed when you linked')).toBeVisible();
  await expect(sheet.getByText('Final.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toHaveCount(0);
});
test('Accounts: Sync in the header syncs every bank; on a phone, so does pulling down', async ({ page }) => {
  await page.goto('/accounts');
  if (test.info().project.name === 'desktop') {
    await page.getByRole('button', { name: 'Sync', exact: true }).click();
    await expect(page.getByText('Up to date')).toBeVisible();
    return;
  }
  await page.getByTestId('net-worth').waitFor();
  // A touch dragged down from the top of the list: the indicator says to release.
  const drag = (phase: 'pull' | 'release') =>
    page.evaluate(async (phase) => {
      const el = document.querySelector('[data-testid="net-worth"]')!.closest('.overflow-y-auto')!;
      const touch = (y: number) => new Touch({ identifier: 1, target: el, clientX: 100, clientY: y });
      const fire = (type: string, y: number) =>
        el.dispatchEvent(
          new TouchEvent(type, {
            touches: type === 'touchend' ? [] : [touch(y)],
            changedTouches: [touch(y)],
            bubbles: true,
            cancelable: true,
          }),
        );
      if (phase === 'release') return void fire('touchend', 300);
      fire('touchstart', 100);
      for (let y = 110; y <= 300; y += 20) {
        fire('touchmove', y);
        await new Promise((r) => requestAnimationFrame(r));
      }
    }, phase);
  await drag('pull');
  await expect(page.getByTestId('pull-refresh')).toContainText('Release to sync');
  // Letting go keeps the indicator up while the banks sync, then says they're done.
  await drag('release');
  await expect(page.getByTestId('pull-refresh')).toContainText('Syncing banks…');
  await expect(page.getByTestId('pull-refresh')).toContainText('Up to date');
  // The Sync button next to the gear does the same.
  await expect(page.getByRole('button', { name: 'Sync', exact: true })).toBeEnabled();
});

test('A row from before the budget is never listed, and its sheet is read-only', async ({ page }) => {
  await page.goto('/accounts/checking');
  await expect(page.getByText('Everyday Checking').first()).toBeVisible();
  await expect(page.getByText('Old Bakery')).toHaveCount(0);
  await page.goto('/activity?q=old%20bakery');
  await expect(page.getByText('Old Bakery')).toHaveCount(0);
  // A saved link still opens it, read-only.
  await page.goto(`/accounts/checking/txn/${encodeURIComponent('p:csv_checking_2026-09-28_0')}`);
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('Not counted')).toBeVisible();
  await expect(sheet.getByText('Before your budget')).toBeVisible();
  await expect(sheet.getByText('OLD BAKERY SF', { exact: true })).toBeVisible();
  // Nothing to change: no note box, no Rename payee.
  await expect(sheet.getByPlaceholder('Add a note')).toHaveCount(0);
  await expect(sheet.getByText('Rename payee')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(/\/accounts\/checking$/);
});
