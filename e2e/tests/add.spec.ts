// Add a transaction: the Add button, Repeats, typing to find, transfers and owed to you.
// Against the SPA in mock mode (the real engine over the November fixture, apps/web/src/mock), on phone
// (390 x 844) and desktop (1280 x 800). Split from app.spec.ts.
import { expect, test } from '@playwright/test';
import { rta } from './mock-helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
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
