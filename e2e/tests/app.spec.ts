// End-to-end flows against the SPA in mock mode (the real engine over the November fixture, apps/web/src/mock), on phone (390 x 844) and desktop (1280 x 800).
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
  await expect(rta(page)).toHaveText('$1,999.90');
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

test('Needs attention fixes move money and Ready to Assign reads $1,851.65', async ({ page }) => {
  await page.goto('/budget?view=attention');
  await expect(rta(page)).toHaveText('$1,999.90');
  const fixes: [string, string][] = [
    ['Cover $18.25 for Dining out', '$1,981.65'],
    ['Fund $90.00 for Car insurance', '$1,891.65'],
    ['Fund $250.00 for Vacation', '$1,641.65'],
    ['Move $210.00 for Gifts', '$1,851.65'],
  ];
  for (const [name, after] of fixes) {
    await page.getByRole('button', { name }).click();
    await expect(rta(page)).toHaveText(after);
  }
  // Low isn't in Needs attention, and has no filter of its own: its row says Low.
  await expect(page.getByRole('button', { name: 'Add $20.00 for Personal care' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Low/ })).toHaveCount(0);
  await expect(page.getByText('Done just now')).toBeVisible();
  await expect(page.getByText('Added $18.25 from Ready to Assign')).toBeVisible();
  await expect(page.getByText('Moved $210.00 back to Ready to Assign')).toBeVisible();
  // Freedom's payment category is covered once Dining out is.
  await page.getByRole('button', { name: 'All' }).click();
  await expect(page.getByText('Freedom Unlimited').first()).toBeVisible();
  await expect(page.getByText('needs $18.25 more')).toHaveCount(0);
});

test('Pin a category: it shows first under Pinned, and Unpin takes it off', async ({ page }) => {
  await page.goto('/budget');
  const rows = page.locator('[data-track="budget.category"]', { hasText: 'Personal care' });
  await expect(page.getByText('Pinned', { exact: true })).toHaveCount(0);
  await rows.first().click();
  const pin = page.getByRole('button', { name: 'Pin Personal care to the top' });
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/budget$/);
  // The first group is Pinned, and it lists the category; its own group still has it too.
  await expect(page.getByText('Pinned', { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(2);
  // Unpin from the sheet (the Worker suite checks a reload keeps the pin).
  await rows.first().click();
  await page.getByRole('button', { name: 'Pin Personal care to the top' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Pinned', { exact: true })).toHaveCount(0);
  await expect(rows).toHaveCount(1);
});

test('Needs attention: a Short card shows under Card payments, and Fund covers it', async ({ page }) => {
  // Freedom is short only by Dining out's overspending: covering Dining out covers the card too.
  await page.goto('/budget?view=attention');
  await expect(page.getByText('Covering Dining out covers this card too')).toBeVisible();
  await expect(page.getByRole('button', { name: /for Freedom Unlimited/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cover $18.25 for Dining out' }).click();
  await expect(page.getByText('Covering Dining out covers this card too')).toHaveCount(0);

  // A new budget: card debt from before the start has no money set aside yet.
  await page.goto('/budget?mock=empty&view=attention');
  await expect(page.getByRole('heading', { name: 'Card payments' })).toBeVisible();
  await page.getByRole('button', { name: 'Fund $842.17 for Sapphire Preferred' }).click();
  await expect(page.getByText('Added $842.17 from Ready to Assign')).toBeVisible();
  await expect(page.getByRole('button', { name: /for Sapphire Preferred/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Fund $214.88 for Freedom Unlimited' })).toBeVisible();
});

test('Fund all funds every underfunded category at once', async ({ page }) => {
  await page.goto('/budget?view=attention');
  await page.getByRole('button', { name: /Fund all · \$340\.00/ }).click();
  await expect(rta(page)).toHaveText('$1,659.90');
});

test('Undo on a fix puts the money back', async ({ page }) => {
  await page.goto('/budget?view=attention');
  await page.getByRole('button', { name: 'Cover $18.25 for Dining out' }).click();
  await expect(rta(page)).toHaveText('$1,981.65');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(rta(page)).toHaveText('$1,999.90');
});

test('At the bottom of the list the Ready to Assign bar stays still', async ({ page }) => {
  // Folding the bar makes the list taller, which moved the scroll position and unfolded it again, in a loop.
  await page.goto('/budget?view=attention');
  await page.getByRole('button', { name: 'Cover $18.25 for Dining out' }).click();
  const undo = page.getByRole('button', { name: 'Undo' });
  await undo.scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(500);
  const ys: number[] = [];
  for (let i = 0; i < 8; i++) {
    ys.push((await undo.boundingBox())!.y);
    await page.waitForTimeout(100);
  }
  expect(new Set(ys).size).toBe(1);
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
  await page.getByLabel('Amount').fill('2018');
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
  await expect(page.getByTestId('link-meter')).toHaveText('4 of 10 bank links used');
  await page.getByRole('button', { name: /Link another bank/ }).click();
  await expect(page.getByText('Use 1 of your 6 bank links?')).toBeVisible();
  await page.getByRole('button', { name: 'Link a bank' }).click();
  await expect(page.getByTestId('link-meter')).toHaveText('5 of 10 bank links used');
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

test('Budget lists your groups first, then card payments, then Owed to you', async ({ page }) => {
  await page.goto('/budget');
  const y = async (text: string) => (await page.getByText(text, { exact: true }).first().boundingBox())!.y;
  await expect(page.getByText('Card payments', { exact: true }).first()).toBeVisible();
  const [bills, cards, owedY] = [await y('Bills'), await y('Card payments'), await y('Owed to you')];
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
  await expect(sheet.getByLabel('Group')).toHaveValue('g_everyday');
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
  await expect(sheet.getByRole('button', { name: 'Assign', exact: true })).toBeDisabled();
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

test('Desktop: type into Assigned, Tab saves and moves on, Escape puts it back', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the table is desktop only');
  await page.goto('/budget');
  const groceries = page.getByLabel('Assigned to Groceries');
  await groceries.click();
  await expect(groceries).toHaveValue('600.00');
  await groceries.fill('650');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Assigned to Dining out')).toBeFocused();
  await expect(rta(page)).toHaveText('$1,949.90');
  await expect(groceries).toHaveValue('$650.00');
  await page.keyboard.type('999');
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Assigned to Dining out')).toHaveValue('$200.00');
  await expect(rta(page)).toHaveText('$1,949.90');
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
  await page.goto('/activity/txn/n-uber');
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('link', { name: 'Rename payee' }).click();
  let sheet = page.getByRole('dialog', { name: 'Rename payee' });
  await expect(sheet.getByRole('heading', { name: 'Rename payee' })).toBeVisible();
  await expect(sheet.getByText('Bank names')).toBeVisible();
  await sheet.getByLabel('Show as').fill('Uber rides');
  await sheet.getByRole('button', { name: 'Save name' }).click();
  await expect(sheet).toBeHidden();

  await page.goto('/settings/payees');
  await page.getByRole('link', { name: 'Rename Uber Eats' }).click();
  sheet = page.getByRole('dialog', { name: 'Rename payee' });
  await expect(sheet.getByRole('heading', { name: 'Rename payee' })).toBeVisible();
  await expect(sheet.getByText('UBER EATS')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Save name' })).toBeVisible();
});

test('Payees: search by bank text, and renaming to another payee’s name joins them, with Undo', async ({
  page,
}) => {
  await page.goto('/settings/payees');
  await expect(page.getByText('Looks like the same payee')).toHaveCount(0);
  await page.getByLabel('Search payees').fill('BLUEBOTTLECOFFEE');
  await expect(page.getByRole('link', { name: 'Rename Bluebottle Coffee' })).toBeVisible();
  await page.getByRole('link', { name: 'Rename Bluebottle Coffee' }).click();
  const sheet = page.getByRole('dialog', { name: 'Rename payee' });
  await sheet.getByLabel('Show as').fill('Blue');
  // Payees starting with what you typed are offered as chips.
  await sheet.getByRole('button', { name: 'Blue Bottle Coffee' }).click();
  await expect(
    sheet.getByText('You have a payee named Blue Bottle Coffee. Saving joins them.'),
  ).toBeVisible();
  await sheet.getByRole('button', { name: 'Join payees' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Joined into Blue Bottle Coffee' })).toBeVisible();
  await page.getByLabel('Search payees').fill('');
  await expect(page.getByRole('link', { name: 'Rename Bluebottle Coffee' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Rename Blue Bottle Coffee' })).toContainText('4 transactions');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('link', { name: 'Rename Bluebottle Coffee' })).toBeVisible();
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

test('Phone: Add floats at the bottom right, above the tabs; Select hides it', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'on a computer Add is a header pill');
  await page.goto('/activity?filter=all');
  const add = page.getByRole('link', { name: 'Add transaction' });
  await expect(add).toBeVisible();
  // In thumb reach: just above the tab bar, at the right edge.
  const box = (await add.boundingBox())!;
  const tabs = (await page
    .getByRole('link', { name: /^Budget/ })
    .last()
    .boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(tabs.y);
  expect(box.y + box.height).toBeGreaterThan(tabs.y - 40);
  expect(box.x + box.width).toBeGreaterThan(390 - 30);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(add).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await add.click();
  await expect(page.getByRole('dialog', { name: 'Add a transaction' })).toBeVisible();
  await expect(page).toHaveURL(/\/activity\/add/);
});

test('Add a transaction: a future date shows Repeats, today hides it', async ({ page }) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  const date = add.getByLabel('Date');
  const today = await date.inputValue();
  await expect(add.getByLabel('Repeats')).toHaveCount(0);
  await expect(add.getByText('It counts now.')).toBeVisible();
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  await date.fill(new Date(Date.UTC(y, m - 1, d + 10)).toISOString().slice(0, 10));
  await expect(add.getByLabel('Repeats')).toBeVisible();
  await expect(add.getByText('It counts from that date.')).toBeVisible();
  await date.fill(today);
  await expect(add.getByLabel('Repeats')).toHaveCount(0);
});

test('Add a transaction: typing finds a payee, an account and a category', async ({ page }) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  // Payee: your payees that match are listed as you type; a tap fills the name in.
  const payee = add.getByLabel('Payee');
  await payee.fill('blu');
  const names = add.getByRole('listbox', { name: 'Matching names' });
  await expect(names.getByRole('option').first()).toHaveText('Blue Bottle Coffee');
  await names.getByRole('option', { name: 'Blue Bottle Coffee' }).click();
  await expect(payee).toHaveValue('Blue Bottle Coffee');
  await expect(names).toBeHidden();
  // A name you don't have yet is fine: nothing is listed.
  await payee.fill('Check #1044');
  await expect(names).toBeHidden();
  // Account: the same search sheet as the category.
  await expect(add.getByLabel('Account')).toHaveText('Everyday Checking');
  await add.getByLabel('Account').click();
  const accounts = page.getByRole('dialog', { name: 'Choose an account' });
  await accounts.getByLabel('Search accounts').fill('zzz');
  await expect(accounts.getByText('No account called “zzz”.')).toBeVisible();
  await accounts.getByLabel('Search accounts').fill('sapph');
  await accounts.getByRole('button', { name: /Sapphire Preferred/ }).click();
  await expect(add.getByLabel('Account')).toHaveText('Sapphire Preferred');
  // Category: the one you use most for the payee comes first.
  await payee.fill('blue bottle coffee');
  await add.getByLabel('Category').click();
  const cats = page.getByRole('dialog', { name: 'Choose a category' });
  await expect(cats.getByText('Usually for Blue Bottle Coffee')).toBeVisible();
  await cats.getByRole('button', { name: 'Dining out' }).first().click();
  await expect(add.getByLabel('Category')).toContainText('Dining out');
  await add.getByLabel('Category').click();
  await cats.getByLabel('Search categories').fill('groc');
  await cats.getByRole('button', { name: /Groceries/ }).click();
  await expect(add.getByLabel('Category')).toContainText('Groceries');
});

test('Add a transaction: a transfer adds the other side and leaves Ready to Assign alone', async ({
  page,
}) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  await add.getByLabel('Amount', { exact: true }).fill('50');
  await add.getByRole('button', { name: 'Transfer' }).click();
  await expect(add.getByLabel('Category')).toHaveCount(0);
  // A transfer has no payee (D-107).
  await expect(add.getByLabel('Payee')).toHaveCount(0);
  await expect(add.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await add.getByLabel('To account').click();
  await page
    .getByRole('dialog', { name: 'Choose an account' })
    .getByRole('button', { name: /Sapphire Preferred/ })
    .click();
  await expect(add.getByText('Sapphire Preferred gets the other side.')).toBeVisible();
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add).toBeHidden();
  // Activity opens on Not posted yet, which lists both sides.
  await expect(page.getByText('Transfer to Sapphire Preferred').first()).toBeVisible();
  await expect(page.getByText('Transfer from Everyday Checking').first()).toBeVisible();
  await page
    .getByRole('link', { name: /^Budget/ })
    .last()
    .click();
  await expect(rta(page)).toHaveText('$1,999.90');
});

test('Add a transaction: owed to you, then paid back', async ({ page }) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  await add.getByLabel('Amount', { exact: true }).fill('30');
  await add.getByLabel('Payee').fill('Dinner with Sam');
  await add.getByRole('button', { name: 'Owed to you' }).click();
  await expect(add.getByLabel('Amount owed')).toHaveValue('15.00');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add).toBeHidden();
  await page.getByRole('link', { name: 'Add transaction' }).first().click();
  await add.getByLabel('Amount', { exact: true }).fill('15');
  await add.getByRole('button', { name: 'In', exact: true }).click();
  await add.getByLabel('Payee').fill('Sam');
  await add.getByRole('button', { name: 'Paid back' }).click();
  await expect(add.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  // The new owed item is listed, at its half.
  const item = add.locator('label', { hasText: 'Dinner with Sam' });
  await expect(item).toContainText('of $15.00');
  await item.getByRole('checkbox').check();
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add).toBeHidden();
  // What Sam owed came out of Ready to Assign. Paid back, it is there again.
  await page
    .getByRole('link', { name: /^Budget/ })
    .last()
    .click();
  await expect(rta(page)).toHaveText('$1,999.90');
});

test('Owed to you opened from Accounts goes back to Accounts', async ({ page }) => {
  await page.goto('/accounts');
  await page.getByRole('link', { name: /Owed to you · not in this total/ }).click();
  await expect(page).toHaveURL(/\/owed\?from=accounts/);
  await page.getByRole('button', { name: 'Back to accounts' }).click();
  await expect(page).toHaveURL(/\/accounts$/);
});
