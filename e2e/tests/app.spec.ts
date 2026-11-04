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

test('Needs attention: a Short card shows under Card payments, and Fund covers it', async ({ page }) => {
  // Freedom is short only by Dining out's overspending: covering Dining out covers the card too.
  await page.goto('/budget?view=attention');
  await expect(page.getByText('Cover Dining out to cover this card')).toBeVisible();
  await expect(page.getByRole('button', { name: /for Freedom Unlimited/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cover $18.25 for Dining out' }).click();
  await expect(page.getByText('Cover Dining out to cover this card')).toHaveCount(0);

  // A new budget: card debt from before the start has no money set aside yet.
  await page.goto('/budget?mock=empty&view=attention');
  await expect(page.getByRole('heading', { name: 'Card payments' })).toBeVisible();
  await page.getByRole('button', { name: 'Fund $1,042.60 for Sapphire Preferred' }).click();
  await expect(page.getByText('Added $1,042.60 from Ready to Assign')).toBeVisible();
  await expect(page.getByRole('button', { name: /for Sapphire Preferred/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Fund $170.80 for Freedom Unlimited' })).toBeVisible();
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

test('Activity: categorize from the picker, undo, and OK a suggestion', async ({ page }) => {
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

  // Blue Bottle Coffee has always been Dining out, so it comes suggested: OK takes it, with no rule offer.
  await page.getByRole('button', { name: /^OK Dining out for Blue Bottle Coffee/ }).click();
  const toastBox = page.getByRole('status').filter({ hasText: 'Blue Bottle Coffee → Dining out' });
  await expect(toastBox).toBeVisible();
  await expect(toastBox.getByRole('button', { name: 'Always' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Change category for Blue Bottle Coffee/ })).toHaveText(
    'Dining out',
  );
});

test('Activity: OK all takes every strong suggestion, with one Undo', async ({ page }) => {
  await page.goto('/activity?filter=attention');
  await expect(page.getByRole('button', { name: 'Needs attention 8' })).toBeVisible();
  await page.getByRole('button', { name: 'OK 3 suggestions' }).click();
  await expect(page.getByRole('status').filter({ hasText: '3 transactions categorized' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Needs attention 5' })).toBeVisible();
  // CVS Pharmacy has no suggestion, so it still waits.
  await expect(page.getByRole('button', { name: /Choose category for CVS Pharmacy/ })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Needs attention 8' })).toBeVisible();
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

test('Set targets: a page like Categories, and saving a target comes back to it', async ({ page }, info) => {
  await page.goto('/budget?month=2026-10');
  if (info.project.name === 'phone') await page.getByRole('button', { name: 'More budget actions' }).click();
  await page.getByRole('link', { name: 'Set targets' }).first().click();
  await expect(page).toHaveURL(/\/targets\?month=2026-10/);
  await expect(page.getByRole('heading', { name: 'Set targets' })).toBeVisible();
  await page.getByRole('link', { name: /^Home repairs/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Target' });
  await sheet.getByLabel('Have this much available').fill('50');
  await sheet.getByRole('button', { name: 'Save target' }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/\/targets\?month=2026-10/);
  // Back returns to the Budget month it came from.
  await page.getByRole('button', { name: 'Back to budget' }).click();
  await expect(page).toHaveURL(/\/budget\?month=2026-10/);
});

test('Set targets: old links to the sheet open the page', async ({ page }) => {
  await page.goto('/budget/targets');
  await expect(page).toHaveURL(/\/targets$/);
  await expect(page.getByRole('heading', { name: 'Set targets' })).toBeVisible();
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

test('Rename payee: the same sheet from a transaction and from Settings', async ({ page }) => {
  await page.goto('/activity/txn/uber');
  await page.getByRole('link', { name: 'Rename payee' }).click();
  let sheet = page.getByRole('dialog', { name: 'Rename payee' });
  await expect(sheet.getByRole('heading', { name: 'Rename payee' })).toBeVisible();
  await expect(sheet.getByText('Bank names that become this payee')).toBeVisible();
  await sheet.getByLabel('Show as').fill('Uber rides');
  await sheet.getByRole('button', { name: 'Save name' }).click();
  await expect(sheet).toBeHidden();

  await page.goto('/settings/payees/p-uber');
  sheet = page.getByRole('dialog', { name: 'Rename payee' });
  await expect(sheet.getByRole('heading', { name: 'Rename payee' })).toBeVisible();
  await expect(sheet.getByLabel('Or merge into an existing payee')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Save name' })).toBeVisible();
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
    const box = (await label.boundingBox())!;
    expect([box.x, box.y, box.width]).toEqual([at.x, at.y, at.width]);
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

test('Pages do not slide with Reduce Motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/accounts');
  await page.waitForTimeout(1600);
  await page
    .getByRole('link', { name: /Everyday Checking/ })
    .first()
    .click();
  const frame = page.locator('.ll-page-in').first();
  await expect(frame).toHaveCount(1);
  expect(await frame.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});

test('Desktop: Budget header pills for Edit categories and Set targets, like Sync and Add', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'on a phone they sit in the ⋯ menu');
  await page.goto('/budget');
  for (const name of ['Edit categories', 'Set targets']) {
    const pill = page.getByRole('link', { name, exact: true });
    await expect(pill).toBeVisible();
    await expect(pill).toHaveClass(/rounded-full/);
  }
});
test('A row from before the budget opens read-only from the register', async ({ page }) => {
  await page.goto('/accounts/chk');
  await page.getByText('Old Bakery').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('Not counted')).toBeVisible();
  await expect(sheet.getByText('Before your budget')).toBeVisible();
  await expect(sheet.getByText('OLD BAKERY SF')).toBeVisible();
  // Nothing to change: no note box, no Rename payee.
  await expect(sheet.getByPlaceholder('Add a note')).toHaveCount(0);
  await expect(sheet.getByText('Rename payee')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(/\/accounts\/chk$/);
});
