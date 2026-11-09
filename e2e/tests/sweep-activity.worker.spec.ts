// Edge cases on Activity and the transaction sheets, through the real stack (seeded November fixture, today Nov 14, 2026).
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const rta = (page: Page) => page.getByTestId(test.info().project.name === 'desktop' ? 'nav-rta' : 'rta');
const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };

/** Every row of one table, from the server's sync (a full download). */
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

test.beforeEach(async ({ page, request }) => {
  const r = await request.post('/__dev/seed-november', { headers: H, data: {} });
  expect(r.ok()).toBe(true);
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

const search = async (page: Page, text: string) => {
  await page.getByRole('searchbox', { name: 'Search transactions' }).fill(text);
};

test('Search: an amount typed with a dollar sign or a comma finds posted and waiting rows', async ({
  page,
}) => {
  await page.goto('/activity');
  await expect(page.getByText('Uniqlo').first()).toBeVisible();
  for (const [text, payee] of [
    ['$200.80', 'Uniqlo'],
    ['1,500', 'Vanguard'],
    ['1018', 'Venmo cashout'],
    ['$1,018.00', 'Venmo cashout'],
  ] as const) {
    await search(page, text);
    // Wait for the search to apply: an unrelated row goes.
    await expect(page.getByText('Spotify', { exact: true })).toHaveCount(0);
    await expect(page.getByText(payee, { exact: true }).first()).toBeVisible();
    await search(page, '');
    await expect(page.getByText('Spotify', { exact: true })).toBeVisible();
  }
});

test('Search: _ and % are plain letters, not wildcards', async ({ page }) => {
  await page.goto('/activity');
  await expect(page.getByText('Uniqlo').first()).toBeVisible();
  for (const text of ['_', '%', 'a_b']) {
    await search(page, text);
    await expect(page.getByText('No transactions match.')).toBeVisible();
    await expect(page.getByText('Uniqlo')).toHaveCount(0);
  }
});

test('Add: amounts that are not money keep Add off; 1,234.5 adds $1,234.50 out', async ({
  page,
  request,
}) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  await add.getByLabel('Payee').fill('Odd input');
  const button = add.getByRole('button', { name: 'Add', exact: true });
  for (const text of ['abc', '.', '$-3', '0', '0.00', '1.234', '-']) {
    await add.getByPlaceholder('0.00').fill(text);
    await expect(button).toBeDisabled();
  }
  await add.getByPlaceholder('0.00').fill('1,234.5');
  await button.click();
  await expect(add).toHaveCount(0);
  const m = (await rows(request, 'manual_pending')).find((r) => r.payee_name === 'Odd input')!;
  expect(m.amount).toBe(-123_450);
});

test('Add: a quick double tap on Add adds one transaction', async ({ page, request }) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  await add.getByPlaceholder('0.00').fill('12.34');
  await add.getByLabel('Payee').fill('Double tap');
  await add.getByRole('button', { name: 'Add', exact: true }).dblclick();
  await expect(add).toHaveCount(0);
  await page.waitForTimeout(500);
  const made = (await rows(request, 'manual_pending')).filter((r) => r.payee_name === 'Double tap');
  expect(made).toHaveLength(1);
});

test('Add: an emoji and accented payee shows in Activity and a search finds it', async ({ page }) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  await add.getByPlaceholder('0.00').fill('4.50');
  await add.getByLabel('Payee').fill('  Café ☕️ Zoë  ');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add).toHaveCount(0);
  await expect(page.getByText('Café ☕️ Zoë', { exact: true }).first()).toBeVisible();
  await search(page, 'zoë');
  await expect(page.getByText('Café ☕️ Zoë', { exact: true }).first()).toBeVisible();
});

test('Add: a payee longer than the server takes is cut at 120 letters, so Add works', async ({
  page,
  request,
}) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  await add.getByPlaceholder('0.00').fill('4.50');
  await add.getByLabel('Payee').fill('x'.repeat(200));
  await expect(add.getByLabel('Payee')).toHaveValue('x'.repeat(120));
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add).toHaveCount(0);
  expect((await rows(request, 'manual_pending')).some((r) => r.payee_name === 'x'.repeat(120))).toBe(true);
});

test('Edit: an amount that is not money keeps Save off and says why', async ({ page, request }) => {
  await page.goto('/activity/txn/n-check-1043');
  const sheet = page.getByRole('dialog', { name: 'Check #1043 transaction' });
  for (const text of ['abc', '0', '', '.']) {
    await sheet.getByLabel('Amount', { exact: true }).fill(text);
    await expect(sheet.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(sheet.getByTestId('disabled-why')).toHaveText('Enter an amount');
  }
  await sheet.getByLabel('Amount', { exact: true }).fill('$1,125.5');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const m = (await rows(request, 'manual_pending')).find((r) => r.txn_key === 'n-check-1043')!;
  expect(m.amount).toBe(-112_550);
});

test('Split: a line amount that is not money keeps Save split off', async ({ page }) => {
  await page.goto('/activity');
  await page.getByText('Target', { exact: true }).first().click();
  await page.getByRole('link', { name: 'Split into categories' }).click();
  const sheet = page.getByRole('dialog', { name: 'Split' });
  await sheet.getByLabel('Category for line 2').click();
  await page
    .getByRole('dialog', { name: 'Choose a category' })
    .getByRole('button', { name: 'Groceries' })
    .first()
    .click();
  for (const text of ['abc', '1.234', '', '-5']) {
    await sheet.getByLabel('Amount for line 1').fill(text);
    await expect(sheet.getByRole('button', { name: 'Save split' })).toBeDisabled();
    await expect(sheet.getByTestId('disabled-why')).toHaveText('Enter an amount for every line');
  }
  await sheet.getByLabel('Amount for line 1').fill('40');
  await expect(sheet.getByLabel('Amount for line 2')).toHaveValue('9.15');
  await sheet.getByRole('button', { name: 'Save split' }).click();
  await expect(sheet).toHaveCount(0);
});

test('Delete: an entry you added that was owed to you leaves nothing on Owed to you', async ({ page }) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  await add.getByPlaceholder('0.00').fill('80');
  await add.getByLabel('Payee').fill('Dinner with Sam');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add).toHaveCount(0);
  await page.goto('/owed');
  await expect(page.getByText('Out with others')).toBeVisible();
  const before = await page.locator('main').innerText();
  await page.goto('/activity');
  await page.getByText('Dinner with Sam', { exact: true }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Dinner with Sam transaction' });
  await sheet.getByRole('button', { name: 'Half', exact: true }).click();
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await page.goto('/owed');
  await expect(page.getByText('Dinner with Sam').first()).toBeVisible();
  await page.goto('/activity');
  await page.getByText('Dinner with Sam', { exact: true }).first().click();
  await sheet.getByRole('button', { name: 'Delete…' }).click();
  await sheet.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await page.goto('/owed');
  await expect(page.getByText('Out with others')).toBeVisible();
  expect(await page.locator('main').innerText()).toBe(before);
});
