// Budget: Ready to Assign, Needs attention, pins, Fund all, Assign and the header.
// Against the SPA in mock mode (the real engine over the November fixture, apps/web/src/mock), on phone
// (390 x 844) and desktop (1280 x 800). Split from app.spec.ts.
import { expect, test } from '@playwright/test';
import { rta } from './mock-helpers';

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

test('Budget lists your groups first, then card payments, then Owed to you', async ({ page }) => {
  await page.goto('/budget');
  const y = async (text: string) => (await page.getByText(text, { exact: true }).first().boundingBox())!.y;
  await expect(page.getByText('Card payments', { exact: true }).first()).toBeVisible();
  const [bills, cards, owedY] = [await y('Bills'), await y('Card payments'), await y('Owed to you')];
  expect(bills).toBeLessThan(cards);
  expect(cards).toBeLessThan(owedY);
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
