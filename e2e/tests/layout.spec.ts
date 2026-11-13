// Page layout and motion: no page scroll on a phone, pages that slide in, Reduce Motion.
// Against the SPA in mock mode (the real engine over the November fixture, apps/web/src/mock), on phone
// (390 x 844) and desktop (1280 x 800). Split from app.spec.ts.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

test('No screen is taller than the phone: the page itself never scrolls, only its lists', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'phone', 'phone layout');
  for (const path of [
    '/budget',
    '/budget?view=attention',
    '/activity',
    '/accounts',
    '/accounts/sapphire',
    '/reports',
    '/categories',
    '/settings',
    '/activity/txn/uber',
  ]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const r = await page.evaluate(() => ({
      page: document.documentElement.scrollHeight,
      screen: window.innerHeight,
      bounce: getComputedStyle(document.documentElement).overscrollBehaviorY,
    }));
    expect(r.page, path).toBeLessThanOrEqual(r.screen);
    expect(r.bounce, path).toBe('none');
  }
});

test('Pages slide in when opened and back when Back returns to them; tabs and the first screen do not', async ({
  page,
}, info) => {
  const anim = (sel: string) =>
    page
      .locator(sel)
      .first()
      .evaluate((el) => getComputedStyle(el).animationName);
  // The first screen of the app doesn't slide.
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true }).first()).toBeVisible();
  await page.waitForTimeout(1600);
  if (info.project.name === 'phone') {
    await page.getByRole('link', { name: /^Payees/ }).click();
    await expect(page.locator('.ll-page-in')).toHaveCount(1);
    expect(await anim('.ll-page-in')).toBe('ll-page-in');
    await page.getByRole('button', { name: 'Back to settings' }).click();
    await expect(page.locator('.ll-page-back')).toHaveCount(1);
  }
  // From Budget, Edit categories opens a page that slides in.
  await page.goto('/budget');
  await page.waitForTimeout(1600);
  if (info.project.name === 'phone') await page.getByRole('button', { name: 'More budget actions' }).click();
  await page.getByRole('link', { name: 'Edit categories' }).first().click();
  await expect(page).toHaveURL(/\/categories$/);
  await expect(page.locator('.ll-page-in')).toHaveCount(1);
  // Back to Budget, a tab's own screen: nothing slides.
  await page.getByRole('button', { name: 'Back to budget' }).click();
  await expect(page).toHaveURL(/\/budget/);
  await expect(page.locator('.ll-page-in, .ll-page-back')).toHaveCount(0);
});

test('Pages do not slide with Reduce Motion', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/accounts');
  await page.waitForTimeout(1600);
  // On a computer an account opens in the side panel, not as a page: Owed to you is a page there.
  const link =
    info.project.name === 'desktop'
      ? page.getByRole('link', { name: /Owed to you · not in this total/ })
      : page.getByRole('link', { name: /Everyday Checking/ }).first();
  await link.click();
  const frame = page.locator('.ll-page-in').first();
  await expect(frame).toHaveCount(1);
  expect(await frame.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});
