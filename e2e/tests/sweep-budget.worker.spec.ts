// Edge cases on Budget through the real stack (SPA → Worker → local store → the phone's engine). Seeded with the
// canonical November fixture before each test; "today" is Nov 14, 2026.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const desktop = () => test.info().project.name === 'desktop';
const rta = (page: Page) => page.getByTestId(desktop() ? 'nav-rta' : 'rta');
const label = (page: Page) => page.getByTestId('month-label');

async function rows(request: APIRequestContext, table: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (;;) {
    const r = await request.get(
      `/api/sync?since=0&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    const p = (await r.json()) as {
      cursor: string | null;
      rows: { t: string; d: Record<string, unknown> }[];
    };
    out.push(...p.rows.filter((x) => x.t === table).map((x) => x.d));
    if (!p.cursor) return out;
    cursor = p.cursor;
  }
}

/** The server's assignment for one category and month, in cents (0 when there is none). */
async function assigned(request: APIRequestContext, categoryId: string, month: string): Promise<number> {
  const a = (await rows(request, 'assignment')).find(
    (r) => r.category_id === categoryId && r.month === month,
  );
  return (a?.amount as number | undefined) ?? 0;
}

test.beforeEach(async ({ page, request }) => {
  const r = await request.post('/__dev/seed-november', { headers: H, data: {} });
  expect(r.ok()).toBe(true);
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

test('Budget: a month before the budget starts shows its first month, and a malformed one this month', async ({
  page,
}) => {
  await page.goto('/budget?month=2020-01');
  await expect(label(page)).toContainText('October 2026');
  await expect(page.getByRole('button', { name: 'Previous month' })).toBeDisabled();
  // Not the empty first-budget card for a month with nothing in it.
  await expect(page.getByText('October 2026 is over. Changes here carry into November.')).toBeVisible();
  await expect(page.getByText(/Give your .* a job/)).toHaveCount(0);
  // Its category sheet assigns in October, not in a month the budget doesn't have.
  await page.goto('/budget/category/groceries?month=2020-01');
  await expect(page.getByRole('dialog').getByLabel('Assigned in October')).toHaveValue('600.00');

  for (const bad of ['abc', '2026-13', '2026-1']) {
    await page.goto(`/budget?month=${bad}`);
    await expect(label(page)).toHaveAccessibleName('November 2026');
    await expect(rta(page)).toHaveText('$1,999.90');
  }
});

test('Assign: an amount too large is refused with the limit, and the budget still opens', async ({
  page,
  request,
}) => {
  await page.goto('/budget/category/groceries');
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Assigned in November').fill('90000000000000');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet.getByText('Enter an amount up to $99,999,999.99.')).toBeVisible();
  expect(await assigned(request, 'groceries', '2026-11')).toBe(60_000);
  // The largest amount is taken.
  await sheet.getByLabel('Assigned in November').fill('99,999,999.99');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page).not.toHaveURL(/category/);
  await expect(rta(page)).toHaveText('−$99,997,400.09');
  await page.goto('/budget/category/dining');
  await page.getByRole('dialog').getByLabel('Assigned in November').fill('99999999.99');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page).not.toHaveURL(/category/);
  await page.reload();
  await expect(rta(page)).toHaveText('−$199,997,200.08');
});

test('Category sheet: a pasted "$-3" is an amount, and letters say to enter one', async ({
  page,
  request,
}) => {
  await page.goto('/budget/category/groceries');
  const sheet = page.getByRole('dialog');
  const box = sheet.getByLabel('Assigned in November');
  await box.fill('abc');
  await expect(sheet.getByTestId('disabled-why')).toHaveText('Enter an amount to save');
  await box.fill('600.00');
  await expect(sheet.getByTestId('disabled-why')).toHaveText('Change the amount to save');
  await box.fill('$-3');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page).not.toHaveURL(/category/);
  await expect.poll(() => assigned(request, 'groceries', '2026-11')).toBe(-300);
});

test('Category sheet: Enter saves the amount, and Enter on a move moves it', async ({ page, request }) => {
  await page.goto('/budget/category/groceries');
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Assigned in November').fill('650');
  await sheet.getByLabel('Assigned in November').press('Enter');
  await expect(page).not.toHaveURL(/category/);
  await expect(rta(page)).toHaveText('$1,949.90');
  await expect.poll(() => assigned(request, 'groceries', '2026-11')).toBe(65_000);

  await page.goto('/budget/category/groceries');
  await sheet.getByRole('button', { name: 'Move money' }).click();
  const move = page.getByRole('dialog', { name: 'Move money' });
  await expect(move.getByRole('button', { name: 'From', exact: true })).toContainText('Groceries');
  await move.getByRole('button', { name: 'To', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Move to' })
    .getByRole('button', { name: 'Ready to Assign' })
    .click();
  await expect(move.getByRole('button', { name: 'To', exact: true })).toContainText('Ready to Assign');
  await move.getByLabel('Amount').fill('1,234.5');
  // More than Groceries has: its new amount shows below zero.
  await expect(move.getByText('−$972.10')).toBeVisible();
  await move.getByLabel('Amount').fill('25');
  await move.getByLabel('Amount').press('Enter');
  await expect(page).not.toHaveURL(/category/);
  await expect(rta(page)).toHaveText('$1,974.90');
  // Enter with nothing to save does nothing.
  await page.goto('/budget/category/groceries');
  await sheet.getByLabel('Assigned in November').press('Enter');
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(/category/);
});

test('Category sheet: Move money on an overspent category covers it from Ready to Assign', async ({
  page,
  request,
}) => {
  const before = await assigned(request, 'dining', '2026-11');
  await page.goto('/budget/category/dining');
  await page.getByRole('dialog').getByRole('button', { name: 'Move money' }).click();
  const move = page.getByRole('dialog', { name: 'Move money' });
  // It starts with the cover: from Ready to Assign, the amount it's over.
  await expect(move.getByRole('button', { name: 'From', exact: true })).toContainText('Ready to Assign');
  await expect(move.getByRole('button', { name: 'To', exact: true })).toContainText('Dining out');
  await expect(move.getByLabel('Amount')).toHaveValue('18.25');
  await move.getByRole('button', { name: 'Move $18.25' }).click();
  await expect(page).not.toHaveURL(/category/);
  await expect(rta(page)).toHaveText('$1,981.65');
  await expect.poll(() => assigned(request, 'dining', '2026-11')).toBe(before + 1825);
});

test('Assign sheet: with a category picked, a missing or wrong amount says to enter one', async ({
  page,
}) => {
  await page.goto('/budget/assign');
  const sheet = page.getByRole('dialog', { name: 'Assign money' });
  await sheet.getByRole('button', { name: 'Clear all' }).click();
  await expect(sheet.getByTestId('disabled-why')).toHaveText('Pick a category to assign');
  await sheet.getByLabel('Category').click();
  await page
    .getByRole('dialog', { name: 'Choose a category' })
    .getByRole('button', { name: 'Groceries' })
    .first()
    .click();
  await expect(sheet.getByTestId('disabled-why')).toHaveText('Enter an amount to assign');
  await sheet.getByLabel('Amount').fill('12.345');
  await expect(sheet.getByTestId('disabled-why')).toHaveText('Enter an amount to assign');
  await sheet.getByLabel('Amount').fill('$2,252.5');
  await expect(sheet.getByRole('button', { name: 'Assign anyway' })).toBeEnabled();
  await expect(sheet.getByTestId('assign-left')).toHaveText('−$252.60');
});

test('Target: a balance by a month already gone by can’t be saved', async ({ page, request }) => {
  await page.goto('/budget/category/vacation/target');
  const sheet = page.getByRole('dialog');
  await sheet.getByText('Balance by a date').click();
  await sheet.getByPlaceholder('0.00').fill('1000');
  // Typed in: the picker's lower limit doesn't stop typing.
  await sheet.getByLabel('By').fill('2026-05');
  await expect(sheet.getByRole('button', { name: 'Save target' })).toBeDisabled();
  await expect(sheet.getByTestId('disabled-why')).toHaveText('Choose a month from November 2026 on');
  await sheet.getByLabel('By').fill('2026-11');
  await expect(sheet.getByRole('button', { name: 'Save target' })).toBeEnabled();
  // The server says the same to anything that sends one.
  const r = await request.put('/api/categories/vacation/target', {
    headers: H,
    data: {
      categoryId: 'vacation',
      month: '2026-11',
      target: { type: 'by_date', amount: 100000, targetMonth: '2026-05' },
    },
  });
  expect(r.status()).toBe(422);
  expect(((await r.json()) as { message: string }).message).toBe('Choose a month from November 2026 on.');
});

test('Ready to Assign: a seven-figure amount below zero stays on one line, inside its box', async ({
  page,
  request,
}) => {
  const r = await request.post('/api/budget/set', {
    headers: H,
    data: { month: '2026-11', categoryId: 'home', assigned: 123_494_989 },
  });
  expect(r.ok()).toBe(true);
  // The narrowest phone, and the computer's sidebar.
  if (!desktop()) await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/budget');
  const amount = rta(page);
  await expect(amount).toHaveText('−$1,233,967.99');
  const box = (await amount.boundingBox())!;
  // One line, not the minus sign on a line of its own.
  const font = await amount.evaluate((e) => Number(getComputedStyle(e).fontSize.replace('px', '')));
  expect(box.height).toBeLessThan(font * 1.8);
  // Inside the sidebar's card (12 px padding), or clear of the phone's Take back button.
  const right = desktop()
    ? await amount
        .locator('xpath=..')
        .boundingBox()
        .then((c) => c!.x + c!.width - 12)
    : (await page.getByRole('button', { name: 'Take back' }).boundingBox())!.x;
  expect(box.x + box.width).toBeLessThanOrEqual(right);
});

/** Whether an element's text runs past its own box (it shows under whatever sits beside it). */
const overflows = (el: Element) => el.scrollWidth > el.clientWidth + 1;

test('Long names wrap instead of running under the amount or the buttons', async ({ page, request }) => {
  const long = 'Supercalifragilisticexpialidocious' + 'X'.repeat(26);
  const r = await request.post('/api/settings/categories', {
    headers: H,
    data: { name: long, groupId: 'g_bills', kind: 'spending' },
  });
  expect(r.ok()).toBe(true);
  await page.goto('/budget');
  const name = desktop()
    ? page.getByRole('rowheader').getByRole('button', { name: new RegExp(`^${long}`) })
    : page.locator('[data-track="budget.category"]', { hasText: long }).locator('span').first();
  await expect(name).toBeVisible();
  expect(await name.evaluate(overflows)).toBe(false);

  await name.click();
  const title = page.getByRole('dialog').getByRole('heading', { name: long });
  await expect(title).toBeVisible();
  expect(await title.evaluate(overflows)).toBe(false);
  const pin = page.getByRole('button', { name: `Pin ${long} to the top` });
  const t = (await title.boundingBox())!;
  const pb = (await pin.boundingBox())!;
  expect(t.x + t.width).toBeLessThanOrEqual(pb.x);
});
