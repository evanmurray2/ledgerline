// End-to-end flows against the SPA in mock mode, on phone (390 x 844) and desktop (1280 x 800).
import { expect, test, type Page } from '@playwright/test';

/** Ready to Assign: the bottom bar on a phone, the sidebar on desktop. */
function rta(page: Page) {
  return page.getByTestId(test.info().project.name === 'desktop' ? 'nav-rta' : 'rta');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

test('Budget shows Ready to Assign and the November groups', async ({ page }) => {
  await page.goto('/budget');
  await expect(rta(page)).toHaveText('$981.90');
  if (test.info().project.name === 'phone') {
    await expect(page.getByText('$1,121.85')).toBeVisible();
    await expect(page.getByText('$441.45')).toBeVisible();
  } else {
    const table = page.getByRole('table');
    await expect(table.getByRole('columnheader', { name: 'Assigned' })).toBeVisible();
    await expect(table.getByRole('cell', { name: '$387.60' })).toBeVisible();
  }
  await expect(page.getByText('Sapphire Preferred').first()).toBeVisible();
  await expect(page.getByText('$1,430.60 out').first()).toBeVisible();
});

test('Needs attention fixes move money and Ready to Assign reads $643.65', async ({ page }) => {
  await page.goto('/budget?view=attention');
  await expect(rta(page)).toHaveText('$981.90');
  const fixes: [string, string][] = [
    ['Cover $18.25 for Dining out', '$963.65'],
    ['Fund $90.00 for Car insurance', '$873.65'],
    ['Fund $250.00 for Vacation', '$623.65'],
    ['Add $20.00 for Personal care', '$603.65'],
    ['Move $40.00 for Gifts', '$643.65'],
  ];
  for (const [name, after] of fixes) {
    await page.getByRole('button', { name }).click();
    await expect(rta(page)).toHaveText(after);
  }
  await expect(page.getByText('Done just now')).toBeVisible();
  await expect(page.getByText('Added $18.25 from Ready to Assign')).toBeVisible();
  await expect(page.getByText('Moved $40.00 back to Ready to Assign')).toBeVisible();
  // Freedom's payment category is covered once Dining out is.
  await page.getByRole('button', { name: 'All' }).click();
  await expect(page.getByText('Freedom Unlimited').first()).toBeVisible();
  await expect(page.getByText('$18.25 of card spending not covered')).toHaveCount(0);
});

test('Fund all funds every underfunded category at once', async ({ page }) => {
  await page.goto('/budget?view=attention');
  await page.getByRole('button', { name: /Fund all · \$340\.00/ }).click();
  await expect(rta(page)).toHaveText('$641.90');
});

test('Undo on a fix puts the money back', async ({ page }) => {
  await page.goto('/budget?view=attention');
  await page.getByRole('button', { name: 'Cover $18.25 for Dining out' }).click();
  await expect(rta(page)).toHaveText('$963.65');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(rta(page)).toHaveText('$981.90');
});

test('Activity: categorize from the picker, undo, and accept the Always offer', async ({ page }) => {
  await page.goto('/activity');
  await expect(page.getByText(/Needs category/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Needs attention 8' })).toBeVisible();

  await page.getByRole('button', { name: /Choose category for Amazon −\$38\.10/ }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a category' });
  await expect(picker.getByText('You’ve used for Amazon')).toBeVisible();
  await picker.getByRole('button', { name: 'Shopping' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: 'Amazon → Shopping' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Change category for Amazon −\$38\.10/ })).toHaveText(
    'Shopping',
  );
  await expect(page.getByRole('button', { name: 'Needs attention 7' })).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Needs attention 8' })).toBeVisible();

  // Every past Blue Bottle Coffee was Dining out, so the toast offers a rule.
  await page.getByRole('button', { name: /Choose category for Blue Bottle Coffee/ }).click();
  await page
    .getByRole('dialog', { name: 'Choose a category' })
    .getByRole('button', { name: 'Dining out' })
    .first()
    .click();
  const toastBox = page.getByRole('status').filter({ hasText: 'Blue Bottle Coffee → Dining out' });
  await expect(toastBox.getByText('Put every Blue Bottle Coffee in Dining out from now on?')).toBeVisible();
  await toastBox.getByRole('button', { name: 'Always' }).click();
  await expect(toastBox).toContainText('rule made');
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

test('Offline: last data stays visible and every change is disabled', async ({ page, context }) => {
  await page.goto('/budget?view=attention');
  const cover = page.getByRole('button', { name: 'Cover $18.25 for Dining out' });
  await expect(cover).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await expect(cover).toBeDisabled();
  await expect(page.getByRole('button', { name: /Fund all/ })).toBeDisabled();
  await expect(rta(page)).toHaveText('$981.90');
  if (test.info().project.name === 'phone')
    await expect(page.getByText('Assign', { exact: true })).toHaveAttribute('aria-disabled', 'true');

  // Browsing still works; changing doesn't.
  await page
    .getByRole('link', { name: /Activity/ })
    .first()
    .click();
  await expect(page.getByText('Money to match')).toBeVisible();
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

test('Assigned more than you have offers to take it back', async ({ page }) => {
  await page.goto('/budget/assign');
  await expect(page.getByText('Suggested')).toBeVisible();
  const checked = page.getByRole('checkbox', { checked: true });
  while ((await checked.count()) > 0) await checked.first().uncheck();
  await page.getByLabel('Category').selectOption({ label: 'Vacation' });
  await page.getByLabel('Amount').fill('1000');
  await page.getByRole('button', { name: 'Assign anyway' }).click();
  await expect(rta(page)).toHaveText('−$18.10');
  await expect(page.getByText('You assigned $18.10 more than you have')).toBeVisible();
  await page.getByRole('button', { name: 'Take $18.10 from Vacation' }).click();
  await expect(rta(page)).toHaveText('$0.00');
});

test('Bank connections confirm before linking and update the meter', async ({ page }) => {
  await page.goto('/settings/connections');
  await expect(page.getByTestId('link-meter')).toHaveText('4 of 10 links used');
  await page.getByRole('button', { name: /Link another bank/ }).click();
  await expect(page.getByText('Use 1 of your 6 remaining links?')).toBeVisible();
  await page.getByRole('button', { name: 'Link a bank' }).click();
  await expect(page.getByTestId('link-meter')).toHaveText('5 of 10 links used');
});

test('Match money back returns it to Ready to Assign', async ({ page }) => {
  await page.goto('/activity/match/venmo');
  await page.getByRole('button', { name: 'Match $1,018.00' }).click();
  await expect(
    page.getByText('Matched $1,018.00. 2 items are paid back, and Ready to Assign is now $1,999.90.'),
  ).toBeVisible();
});
