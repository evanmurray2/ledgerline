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
    ['Move $40.00 for Gifts', '$663.65'],
  ];
  for (const [name, after] of fixes) {
    await page.getByRole('button', { name }).click();
    await expect(rta(page)).toHaveText(after);
  }
  // Low has its own filter.
  await expect(page.getByRole('button', { name: 'Add $20.00 for Personal care' })).toHaveCount(0);
  await page.getByRole('button', { name: /^Low \d/ }).click();
  await page.getByRole('button', { name: 'Add $20.00 for Personal care' }).click();
  await expect(rta(page)).toHaveText('$643.65');
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

test('Activity: the filter chips row has no scroll bar', async ({ page }) => {
  await page.goto('/activity');
  const row = page.getByRole('group', { name: 'Filter' });
  await expect(row.getByRole('button', { name: 'Needs attention 8' })).toBeVisible();
  // The chips' 44 px touch targets used to overflow the row, which then scrolled up and down.
  const { scroll, client, bar } = await row.evaluate((el) => ({
    scroll: el.scrollHeight,
    client: el.clientHeight,
    bar: getComputedStyle(el).scrollbarWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);
  expect(bar).toBe('none');
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

test('Resting at 95%: a banner, and nothing but the session is asked for', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) asked.push(u.pathname);
  });
  await page.goto('/budget?mock=resting');
  await expect(page.getByTestId('resting-banner')).toContainText('Resting until 4:00 PM');
  await expect(page.getByRole('alert')).toContainText('daily limit resets');
  // After the first resting answer, moving around asks the server for nothing.
  const before = asked.filter((p) => p !== '/api/session').length;
  await page.getByRole('link', { name: 'Activity' }).first().click();
  await expect(page.getByRole('alert')).toContainText('daily limit resets');
  expect(asked.filter((p) => p !== '/api/session')).toHaveLength(before);
});

test('Assigned more than you have offers to take it back', async ({ page }) => {
  await page.goto('/budget/assign');
  await expect(page.getByText('Suggested')).toBeVisible();
  const checked = page.getByRole('checkbox', { checked: true });
  while ((await checked.count()) > 0) await checked.first().uncheck();
  await page.getByLabel('Category').click();
  await page
    .getByRole('dialog', { name: 'Choose a category' })
    .getByRole('button', { name: /^Vacation/ })
    .click();
  await page.getByLabel('Amount').fill('1000');
  await page.getByRole('button', { name: 'Assign anyway' }).click();
  await expect(rta(page)).toHaveText('−$18.10');
  await expect(page.getByText('You assigned $18.10 more than you have')).toBeVisible();
  await page.getByRole('button', { name: 'Take $18.10 from Vacation' }).click();
  await expect(rta(page)).toHaveText('$0.00');
  // Nothing left to assign: a quiet line, no Assign button.
  await expect(page.getByText('All money assigned').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Assign', exact: true })).toHaveCount(0);
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

test('Budget lists your groups first, then card payments, then Owed to you', async ({ page }) => {
  await page.goto('/budget');
  const y = async (text: string) => (await page.getByText(text, { exact: true }).first().boundingBox())!.y;
  await expect(page.getByText('Credit card payments', { exact: true }).first()).toBeVisible();
  const owed = test.info().project.name === 'desktop' ? 'Owed to you · not a category' : 'Owed to you';
  const [bills, cards, owedY] = [await y('Bills'), await y('Credit card payments'), await y(owed)];
  expect(bills).toBeLessThan(cards);
  expect(cards).toBeLessThan(owedY);
});

test('Set targets: a list of every category, and saving a target comes back to it', async ({ page }) => {
  await page.goto('/budget/targets');
  const list = page.getByRole('dialog', { name: 'Set targets' });
  await list.getByRole('link', { name: /^Home repairs/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Target' });
  await sheet.getByLabel('Have this much available').fill('50');
  await sheet.getByRole('button', { name: 'Save target' }).click();
  await expect(page.getByRole('dialog', { name: 'Set targets' })).toBeVisible();
  await expect(page).toHaveURL(/\/budget\/targets/);
});

test('Target: saving from a category goes back to the Budget, not the category', async ({ page }) => {
  await page.goto('/budget/category/groceries/target');
  await page.getByRole('button', { name: 'Save target' }).click();
  await expect(page).toHaveURL(/\/budget(\?.*)?$/);
});

test('Target: a new kind starts empty instead of reusing the old amount', async ({ page }) => {
  await page.goto('/budget/category/vacation/target');
  const sheet = page.getByRole('dialog', { name: 'Target' });
  await expect(sheet.getByLabel('Reach a balance of')).toHaveValue('3000.00');
  await sheet.getByRole('button', { name: /Set aside/ }).click();
  await expect(sheet.getByLabel('Set aside every month')).toHaveValue('');
  await sheet.getByRole('button', { name: /Balance by a date/ }).click();
  await expect(sheet.getByLabel('Reach a balance of')).toHaveValue('3000.00');
});

test('Categories: add one to a group, then set its target', async ({ page }) => {
  await page.goto('/categories');
  await page.getByRole('link', { name: 'Add category' }).nth(1).click();
  const sheet = page.getByRole('dialog', { name: 'New category' });
  await expect(sheet.getByLabel('Group')).toHaveValue('g-everyday');
  await sheet.getByLabel('Name').fill('Climbing');
  await sheet.getByRole('button', { name: 'Add and set a target' }).click();
  const target = page.getByRole('dialog', { name: 'Target' });
  await expect(target.getByText('Climbing')).toBeVisible();
  await target.getByLabel('Have this much available').fill('40');
  await target.getByRole('button', { name: 'Save target' }).click();
  await expect(page).toHaveURL(/\/categories$/);
  await expect(page.getByText('Climbing')).toBeVisible();
});

test('Assign: Clear all and Select all', async ({ page }) => {
  await page.goto('/budget/assign');
  const sheet = page.getByRole('dialog', { name: 'Assign money' });
  await sheet.getByRole('button', { name: 'Clear all' }).click();
  await expect(sheet.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Nothing selected' })).toBeDisabled();
  await sheet.getByRole('button', { name: 'Select all' }).click();
  await expect(sheet.getByRole('checkbox', { checked: false })).toHaveCount(0);
});

test('Categories open from Budget, Back returns there, and old Settings links still work', async ({
  page,
}, info) => {
  await page.goto('/budget');
  // On a phone, Edit categories and Set targets sit in the menu at the top of the Budget.
  if (info.project.name === 'phone') await page.getByRole('button', { name: 'More budget actions' }).click();
  await expect(page.getByRole('link', { name: 'Set targets' }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Edit categories' }).first().click();
  await expect(page).toHaveURL(/\/categories$/);
  if (info.project.name === 'phone') {
    await page.getByRole('button', { name: 'Back to budget' }).click();
    await expect(page).toHaveURL(/\/budget/);
  }
  await page.goto('/settings/categories');
  await expect(page).toHaveURL(/\/categories$/);
  // Settings no longer lists categories; Set targets lives on Budget only.
  await expect(page.getByRole('link', { name: 'Set targets' })).toHaveCount(0);
});

test('Categories: reorder a category with the keyboard on its handle', async ({ page }) => {
  await page.goto('/categories');
  const rows = page.getByRole('link', { name: /^(Rent|Electric)/ });
  await expect(rows.first()).toContainText('Rent');
  await page.getByRole('button', { name: 'Reorder Rent' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.first()).toContainText('Electric');
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

test('Accounts: Refresh syncs every bank; on a phone, so does pulling down', async ({ page }) => {
  await page.goto('/accounts');
  if (test.info().project.name === 'desktop') {
    await page.getByRole('button', { name: 'Refresh' }).click();
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
  // The sync button next to the gear does the same.
  await expect(page.getByRole('button', { name: 'Sync banks now' })).toBeEnabled();
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
  await expect(rta(page)).toHaveText('$931.90');
  await expect(groceries).toHaveValue('$650.00');
  await page.keyboard.type('999');
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Assigned to Dining out')).toHaveValue('$200.00');
  await expect(rta(page)).toHaveText('$931.90');
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
