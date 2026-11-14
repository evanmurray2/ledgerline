// Activity: filters, categorizing, suggestions, Select, matching money back and months.
// Against the SPA in mock mode (the real engine over the November fixture, apps/web/src/mock), on phone
// (390 x 844) and desktop (1280 x 800). Split from app.spec.ts.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

test('Activity: the filter chips row has no scroll bar', async ({ page }) => {
  await page.goto('/activity');
  const row = page.getByRole('group', { name: 'Filter' });
  await expect(row.getByRole('button', { name: 'Needs attention 6' })).toBeVisible();
  // The chips' 44 px touch targets used to overflow the row, which then scrolled up and down.
  const { scroll, client, bar } = await row.evaluate((el) => ({
    scroll: el.scrollHeight,
    client: el.clientHeight,
    bar: getComputedStyle(el).scrollbarWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);
  expect(bar).toBe('none');
});

test('Activity: categorize from the picker, undo, and OK a suggestion', async ({ page }) => {
  await page.goto('/activity?filter=all');
  await expect(page.getByText(/Needs category/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Needs attention 6' })).toBeVisible();

  await page.getByRole('button', { name: /Choose category for Amazon −\$38\.10/ }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a category' });
  await expect(picker.getByText('Past categories for Amazon')).toBeVisible();
  // The search field has focus at once, so the keyboard is up and you can type.
  await expect(picker.getByRole('searchbox', { name: 'Search categories' })).toBeFocused();
  await picker.getByRole('button', { name: 'Shopping' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: 'Amazon → Shopping' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Change category for Amazon −\$38\.10/ })).toHaveText(
    'Shopping',
  );
  await expect(page.getByRole('button', { name: 'Needs attention 5' })).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Needs attention 6' })).toBeVisible();

  // Blue Bottle Coffee has always been Dining out, so it comes suggested: OK takes it, with no rule offer.
  await page.getByRole('button', { name: /^Use Dining out for Blue Bottle Coffee/ }).click();
  const toastBox = page.getByRole('status').filter({ hasText: 'Blue Bottle Coffee → Dining out' });
  await expect(toastBox).toBeVisible();
  await expect(toastBox.getByRole('button', { name: 'Always' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Change category for Blue Bottle Coffee/ })).toHaveText(
    'Dining out',
  );
});

test('Activity: OK all takes every strong suggestion, with one Undo', async ({ page }) => {
  await page.goto('/activity?filter=attention');
  await expect(page.getByRole('button', { name: 'Needs attention 6' })).toBeVisible();
  // The second Amazon is a new payee offered as "Same as your Amazon?", so OK all leaves it for you.
  await page.getByRole('button', { name: 'Use 2 suggestions' }).click();
  await expect(page.getByRole('status').filter({ hasText: '2 transactions categorized' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Needs attention 4' })).toBeVisible();
  // CVS Pharmacy has no suggestion, so it still waits.
  await expect(page.getByRole('button', { name: /Choose category for CVS Pharmacy/ })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Needs attention 6' })).toBeVisible();
});

test('Activity: a new payee shows its bank text, and Same as your… joins it into yours, with Undo', async ({
  page,
}) => {
  await page.goto('/activity?filter=attention');
  await expect(page.getByText('CVS/PHARMACY #0812')).toBeVisible();
  await expect(page.getByText('Same as your Amazon?')).toBeVisible();
  await page.getByRole('button', { name: 'Join Amazon into your Amazon' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Joined into Amazon' })).toBeVisible();
  await expect(page.getByText('Same as your Amazon?')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Same as your Amazon?')).toBeVisible();
});

test('Activity: Select several gives many transactions one category', async ({ page }) => {
  await page.goto('/activity?filter=attention');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('checkbox', { name: /Select Amazon −\$38\.10/ }).check();
  await page.getByRole('checkbox', { name: /Select Amazon −\$23\.20/ }).check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Choose category' }).click();
  await page
    .getByRole('dialog', { name: 'Choose a category' })
    .getByRole('button', { name: 'Household' })
    .click();
  await expect(page.getByRole('status').filter({ hasText: '2 transactions → Household' })).toBeVisible();
});

test('Desktop: a posted row’s category menu changes its category, with Undo', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'a phone opens the row’s sheet instead');
  await page.goto('/activity?filter=all');
  const menu = page.getByRole('button', { name: /^Category for Trader Joe/ }).first();
  await expect(menu).toBeVisible();
  const before = (await menu.textContent()) ?? '';
  await menu.click();
  const picker = page.getByRole('dialog', { name: 'Choose a category' });
  await picker.getByRole('button', { name: 'Household' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '→ Household' })).toBeVisible();
  await expect(menu).toHaveText('Household');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(menu).toHaveText(before);
  // The menu sits in the tag line, so the amount keeps its place at the row's right edge; the rest of the row
  // still opens the row's sheet.
  const row = page.getByRole('link', { name: /^Trader Joe/ }).first();
  await row
    .locator('xpath=ancestor::div[contains(@class,"relative")][1]')
    .click({ position: { x: 600, y: 10 } });
  await expect(page).toHaveURL(/\/activity\/txn\//);
});

test('Match money back returns it to Ready to Assign', async ({ page }) => {
  await page.goto('/activity/match/n-venmo');
  await page.getByRole('button', { name: 'Match $1,018.00' }).click();
  await expect(
    page.getByText('Matched $1,018.00. 2 items are paid back. Ready to Assign is now $1,999.90.'),
  ).toBeVisible();
});

test('A card credit can pay back what is owed to you', async ({ page }) => {
  await page.goto('/activity/txn/n-points');
  await page.getByRole('link', { name: /Money back for something owed to you/ }).click();
  await expect(page).toHaveURL(/\/activity\/match\/n-points$/);
  await expect(page.getByRole('button', { name: 'Match $24.10' })).toBeVisible();
});

test('Activity: a transaction opened on October closes back to October; a search covers every month', async ({
  page,
}) => {
  await page.goto('/activity?month=2026-10');
  const label = page.getByTestId('month-label');
  await expect(label).toContainText('October 2026');
  await page.locator('[data-track="activity.row"]').first().click();
  await expect(page).toHaveURL(/\/activity\/\w+\/[^?]+\?month=2026-10/);
  await expect(label).toContainText('October 2026');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/activity\?month=2026-10$/);
  await expect(label).toContainText('October 2026');
  await page.getByLabel('Search transactions').fill('Safeway');
  await expect(page.getByTestId('all-months')).toHaveText('Searching all months');
});
