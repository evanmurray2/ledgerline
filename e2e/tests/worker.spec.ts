// The prototype's November through the real stack: SPA → Worker → local D1 (seeded fixture) → Money rules.
import { expect, test, type Page } from '@playwright/test';

const rta = (page: Page) => page.getByTestId(test.info().project.name === 'desktop' ? 'nav-rta' : 'rta');

test.beforeEach(async ({ page, request }) => {
  const r = await request.post('/__dev/seed-november', {
    headers: { 'content-type': 'application/json', 'x-ledgerline': '1' },
    data: {},
  });
  expect(r.ok()).toBe(true);
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

test('Budget shows the November numbers from the Worker', async ({ page }) => {
  await page.goto('/budget');
  await expect(rta(page)).toHaveText('$981.90');
  if (test.info().project.name === 'phone') {
    // Group totals appear on the phone layout; the desktop table shows group names only, as in the prototype.
    await expect(page.getByText('$1,121.85').first()).toBeVisible();
    await expect(page.getByText('$441.45').first()).toBeVisible();
    await expect(page.getByText('$18,877.63').first()).toBeVisible();
  } else {
    await expect(page.getByRole('cell', { name: '$212.40' })).toBeVisible();
  }
  await expect(page.getByText('$878.32').first()).toBeVisible();
  await expect(page.getByText('$1,430.60 out').first()).toBeVisible();
});

test('Needs attention fixes reach $643.65 through the API', async ({ page }) => {
  await page.goto('/budget?view=attention');
  await expect(rta(page)).toHaveText('$981.90');
  for (const [name, after] of [
    ['Cover $18.25 for Dining out', '$963.65'],
    ['Fund $90.00 for Car insurance', '$873.65'],
    ['Fund $250.00 for Vacation', '$623.65'],
    ['Move $40.00 for Gifts', '$663.65'],
  ] as const) {
    await page.getByRole('button', { name }).click();
    await expect(rta(page)).toHaveText(after);
  }
  await page.getByRole('button', { name: /^Low \d/ }).click();
  await page.getByRole('button', { name: 'Add $20.00 for Personal care' }).click();
  await expect(rta(page)).toHaveText('$643.65');
  await page.reload();
  await expect(rta(page)).toHaveText('$643.65');
});

test('Activity: categorizing an uncategorized purchase persists', async ({ page }) => {
  await page.goto('/activity');
  const chip = page.getByRole('button', { name: /^Needs attention \d+$/ });
  await expect(page.getByRole('button', { name: /Choose category for Amazon −\$38\.10/ })).toBeVisible();
  await expect(chip).toHaveText(/Needs attention [1-9]/);
  const before = Number((await chip.textContent())!.match(/\d+/)![0]);
  await page.getByRole('button', { name: /Choose category for Amazon −\$38\.10/ }).click();
  await page
    .getByRole('dialog', { name: 'Choose a category' })
    .getByRole('button', { name: 'Shopping' })
    .first()
    .click();
  await expect(page.getByRole('button', { name: /Change category for Amazon −\$38\.10/ })).toHaveText(
    'Shopping',
  );
  // The count drops at once, without reloading the list.
  await expect(chip).toHaveText(`Needs attention ${before - 1}`);
  // Leaving and coming back shows the server's state.
  await page.goto('/budget');
  await page.goto('/activity');
  await expect(chip).toHaveText(`Needs attention ${before - 1}`);
  await page.reload();
  await expect(page.getByRole('button', { name: /Choose category for Amazon −\$38\.10/ })).toHaveCount(0);
});

test('Saved screens check for changes when the app opens again', async ({ page }) => {
  await page.goto('/activity');
  const chip = page.getByRole('button', { name: /^Needs attention \d+$/ });
  await expect(chip).toHaveText(/Needs attention [1-9]/);
  const before = Number((await chip.textContent())!.match(/\d+/)![0]);
  // Let this screen be saved on the device (at most every 2 s)…
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: /Choose category for Amazon −\$38\.10/ }).click();
  await page
    .getByRole('dialog', { name: 'Choose a category' })
    .getByRole('button', { name: 'Shopping' })
    .first()
    .click();
  await expect(chip).toHaveText(`Needs attention ${before - 1}`);
  // …then leave before the change is saved: reopening must not trust the old copy.
  await page.reload();
  await expect(chip).toHaveText(`Needs attention ${before - 1}`);
});

test('Accounts: net worth and the Ally repair prompt', async ({ page }) => {
  await page.goto('/accounts');
  await expect(page.getByText('$22,555.35').first()).toBeVisible();
  await expect(page.getByText(/Ally/).first()).toBeVisible();
});

test('Categories: rename a group, reorder by dragging, and remove a category', async ({ page }) => {
  await page.goto('/categories');
  const groups = page.locator('section').getByRole('heading', { level: 2 });
  // Card payments come first and are made by the app; your groups follow.
  await expect(groups.nth(1)).toHaveText('Bills');
  await expect(groups.nth(2)).toHaveText('Everyday');
  // Drag Bills below Everyday by its handle: no Edit mode.
  const handle = page.getByRole('button', { name: 'Reorder group Bills' });
  const everyday = page.getByRole('link', { name: 'Rename group Everyday' });
  const from = (await handle.boundingBox())!;
  const to = (await everyday.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 400, { steps: 12 });
  await page.mouse.up();
  await expect(groups.nth(1)).toHaveText('Everyday');
  await expect(groups.nth(2)).toHaveText('Bills');

  await page.getByRole('link', { name: 'Rename group Everyday' }).click();
  const sheet = page.getByRole('dialog', { name: 'Rename group' });
  await sheet.getByLabel('Name').fill('Day to day');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(groups.nth(1)).toHaveText('Day to day');

  // Removing happens on the category's own sheet, with a confirm step.
  await page.getByRole('link', { name: /^Dining out/ }).click();
  const edit = page.getByRole('dialog', { name: 'Edit category' });
  await edit.getByRole('button', { name: 'Remove Dining out…' }).click();
  await edit.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('Dining out archived: it has history, so reports keep it')).toBeVisible();
  await expect(page.getByRole('link', { name: /^Dining out/ })).toHaveCount(0);
});

test('Target: a yearly refill is met in its Due month, and the Due month is kept', async ({ page }) => {
  await page.goto('/budget/category/groceries/target');
  await page.getByPlaceholder('0.00').fill('124');
  await page.getByRole('button', { name: 'Year', exact: true }).click();
  await page.getByLabel('Due').fill('2027-03');
  // November through March: five steps, the last one in March.
  await expect(page.getByText(/by Mar(ch)? 2027 from what you have now, in 5 monthly steps/)).toBeVisible();
  await page.getByRole('button', { name: 'Save target' }).click();
  await expect(page).not.toHaveURL(/\/target/);
  await page.goto('/budget/category/groceries/target');
  await expect(page.getByLabel('Due')).toHaveValue('2027-03');
});

test('Pending: money you add goes to Ready to Assign, and a bank pending charge takes your amount', async ({
  page,
  request,
}) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  await add.getByPlaceholder('0.00').fill('500');
  await add.getByRole('button', { name: 'In', exact: true }).click();
  await add.getByLabel('Payee').fill('Zelle from a friend');
  await add.getByLabel('Category').click();
  await page
    .getByRole('dialog', { name: 'Choose a category' })
    .getByRole('button', { name: 'Ready to Assign' })
    .click();
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await page.goto('/budget');
  await expect(rta(page)).toHaveText('$1,481.90');

  // A card hold with no estimate yet: set your own amount.
  const v = (await (await request.get('/api/activity')).json()) as {
    pending: { key: string; amount: number; badgeKind: string | null; sheet: string }[];
  };
  const hold = v.pending.find(
    (r) => r.amount < 0 && r.badgeKind !== 'mine' && r.badgeKind !== 'est' && r.sheet === 'txn',
  )!;
  await page.goto(`/activity/txn/${encodeURIComponent(hold.key)}`);
  await page.getByRole('dialog').getByLabel('Your estimate').fill('123.45');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).not.toHaveURL(/\/txn\//);
  const after = (await (await request.get(`/api/transactions/${encodeURIComponent(hold.key)}`)).json()) as {
    amount: number;
    estimatedAmount: number;
  };
  expect(after.estimatedAmount).toBe(-12_345);
  expect(after.amount).toBe(-12_345);
});

test('Accounts: rename an account', async ({ page }) => {
  await page.goto('/accounts/sapphire');
  await page.getByRole('button', { name: 'More for this account' }).click();
  await page.getByRole('menuitem', { name: 'Rename account' }).click();
  const sheet = page.getByRole('dialog', { name: 'Rename account' });
  await sheet.getByLabel('Name').fill('Travel card');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Travel card' })).toBeVisible();
  await page.goto('/accounts');
  await expect(page.getByText('Travel card').first()).toBeVisible();
});
