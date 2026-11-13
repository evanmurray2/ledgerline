// The month bar, the tabs and Reports.
// Against the SPA in mock mode (the real engine over the November fixture, apps/web/src/mock), on phone
// (390 x 844) and desktop (1280 x 800). Split from app.spec.ts.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

test('Month bar: the same place on every tab, and one month across Budget, Activity and Reports', async ({
  page,
}) => {
  const phone = test.info().project.name === 'phone';
  const nav = page.getByRole('navigation', { name: 'Main' });
  const label = page.getByTestId('month-label');
  await page.goto('/budget');
  await expect(label).toHaveAccessibleName('November 2026');
  const at = (await label.boundingBox())!;
  await page.getByRole('button', { name: 'Previous month' }).click();
  await expect(page).toHaveURL(/\/budget\?month=2026-10/);
  // Off this month, the way back sits under (phone) or beside (desktop) the label, which doesn't move.
  await expect(label).toContainText('October 2026');
  expect((await label.boundingBox())!.x).toBe(at.x);
  for (const tab of ['Activity', 'Reports'] as const) {
    await nav.getByRole('link', { name: tab }).click();
    await expect(page).toHaveURL(new RegExp(`/${tab.toLowerCase()}\\?month=2026-10`));
    await expect(label).toContainText('October 2026');
    // Polled: while a page slides in, the label can be swapped for a moment and have no box.
    await expect
      .poll(async () => {
        const box = await label.boundingBox();
        return box && [box.x, box.y, box.width];
      })
      .toEqual([at.x, at.y, at.width]);
  }
  // Activity on a past month: that month's posted rows, to-dos still shown, no Not posted yet.
  await nav.getByRole('link', { name: 'Activity' }).click();
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Not posted yet/ })).toHaveCount(0);
  // Accounts has no month: its name is where the month is.
  await nav.getByRole('link', { name: /^Accounts/ }).click();
  await expect(label).toHaveCount(0);
  const title = page.getByRole('heading', { name: 'Accounts', level: 1 });
  if (phone) {
    const t = (await title.boundingBox())!;
    expect(Math.abs(t.x + t.width / 2 - (at.x + at.width / 2))).toBeLessThan(1);
  }
  // From a screen without a month, the tabs keep the last one.
  await nav.getByRole('link', { name: 'Budget' }).click();
  await expect(page).toHaveURL(/\/budget\?month=2026-10/);
  await label.click();
  await expect(page).toHaveURL(/\/budget$/);
  await expect(label).toHaveAccessibleName('November 2026');
});

test('Month bar: tabs go Budget, Activity, Reports, Accounts', async ({ page }) => {
  await page.goto('/budget');
  const links = page.getByRole('navigation', { name: 'Main' }).getByRole('link');
  await expect(links.first()).toBeVisible();
  const names: string[] = [];
  for (const l of await links.all())
    names.push(
      ((await l.getAttribute('aria-label')) ?? (await l.innerText()))
        .split(',')[0]!
        .replace(/\d+/g, '')
        .trim(),
    );
  expect(names.slice(0, 4)).toEqual(['Budget', 'Activity', 'Reports', 'Accounts']);
});

test('Tabs: a red "!" on each tab that needs you', async ({ page }) => {
  await page.goto('/reports');
  const nav = page.getByRole('navigation', { name: 'Main' });
  // The sample budget has an overspent category, Activity to-dos and a bank to repair.
  for (const [tab, why] of [
    ['Budget', 'needs attention'],
    ['Activity', 'needs attention'],
    ['Accounts', 'a bank needs repair'],
  ] as const) {
    const link = nav.getByRole('link', { name: `${tab}, ${why}` });
    await expect(link).toBeVisible();
    await expect(link.getByTestId('alert-badge')).toHaveText('!');
  }
  await expect(nav.getByRole('link', { name: /^Reports/ }).getByTestId('alert-badge')).toHaveCount(0);
  // No counts on the tabs (the desktop sidebar's Ready to Assign amount isn't a tab).
  for (const link of await nav.getByRole('link').all()) await expect(link).not.toContainText(/\d/);
});

test('Reports: a category opens only its transactions, and Back to Reports returns to the month', async ({
  page,
}) => {
  await page.goto('/reports?month=2026-10');
  await page.locator('[data-track="reports.category"]').first().click();
  await expect(page).toHaveURL(/\/activity\?.*category=/);
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('');
  await expect(page.getByText('All months')).toBeVisible();
  await expect(page.getByLabel('Search transactions')).toHaveValue('');
  await page.getByRole('button', { name: 'Back to Reports' }).click();
  await expect(page).toHaveURL(/\/reports\?month=2026-10$/);
});
