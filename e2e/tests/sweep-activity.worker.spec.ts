// Edge cases on Activity and the transaction sheets, through the real stack (seeded November fixture, today Nov 14, 2026).
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

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

test('Search: under Needs attention, an amount or a category finds rows that need a category', async ({
  page,
}) => {
  await page.goto('/activity?filter=attention');
  await expect(page.getByText('Spotify')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Choose category for CVS Pharmacy/ })).toBeVisible();
  await search(page, '38.10');
  await expect(page.getByRole('button', { name: /Choose category for CVS Pharmacy/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Choose category for Amazon −\$38\.10/ })).toBeVisible();
  await expect(page.getByText('No transactions match.')).toHaveCount(0);
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

test('Add: a date before the budget start keeps Add off and says why; the start day itself adds', async ({
  page,
  request,
}) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  await add.getByPlaceholder('0.00').fill('10');
  await add.getByLabel('Payee').fill('Old check');
  const date = add.getByLabel('Date');
  await expect(date).toHaveAttribute('min', '2026-10-01');
  await date.fill('2026-09-30');
  const button = add.getByRole('button', { name: 'Add', exact: true });
  await expect(button).toBeDisabled();
  await expect(add.getByText('Pick a date from October 1, 2026 on')).toBeVisible();
  await date.fill('2026-10-01');
  await button.click();
  await expect(add).toHaveCount(0);
  const m = (await rows(request, 'manual_pending')).find((r) => r.payee_name === 'Old check')!;
  expect(m.date).toBe('2026-10-01');
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

test('Add: an upcoming row next year shows its year', async ({ page }) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  await add.getByPlaceholder('0.00').fill('10');
  await add.getByLabel('Payee').fill('New year party');
  await add.getByLabel('Date').fill('2027-01-01');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add).toHaveCount(0);
  const row = page.locator('[data-track]', { hasText: 'New year party' }).first();
  await expect(row).toContainText('Jan 1, 2027');
  // This year's days keep the short form.
  await expect(page.locator('[data-track]', { hasText: 'Comcast' }).first()).toContainText(/Nov 16(?!,)/);
});

test('Add: Ready to Assign picked for money in goes back to Needs a category when you switch to Out', async ({
  page,
  request,
}) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  await add.getByPlaceholder('0.00').fill('10');
  await add.getByRole('button', { name: 'In', exact: true }).click();
  await add.getByLabel('Payee').fill('Flip back');
  await add.getByLabel('Category').click();
  await page
    .getByRole('dialog', { name: 'Choose a category' })
    .getByRole('button', { name: 'Ready to Assign' })
    .click();
  await expect(add.getByLabel('Category')).toHaveText(/Ready to Assign/);
  await add.getByRole('button', { name: 'Out', exact: true }).click();
  await expect(add.getByLabel('Category')).toHaveText(/Needs a category/);
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add).toHaveCount(0);
  const m = (await rows(request, 'manual_pending')).find((r) => r.payee_name === 'Flip back')!;
  expect(m.amount).toBe(-1000);
  const o = (await rows(request, 'txn_overlay')).find((r) => r.txn_key === m.txn_key)!;
  expect(o).toMatchObject({ to_rta: 0, category_id: null });
});

test('Transaction sheet: a category archived since still shows by name, and Save keeps it', async ({
  page,
  request,
}) => {
  const r = await request.post('/api/settings/categories/dining/archive', {
    headers: H,
    data: { archived: true },
  });
  expect(r.ok()).toBe(true);
  await page.goto('/activity/txn/n-dining');
  const sheet = page.getByRole('dialog', { name: 'Burma Superstar transaction' });
  await expect(sheet.locator('#txn-cat')).toHaveText(/Dining out/);
  await sheet.getByLabel('Memo').fill('Birthday');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const o = (await rows(request, 'txn_overlay')).find((x) => x.txn_key === 'n-dining')!;
  expect(o).toMatchObject({ category_id: 'dining', memo: 'Birthday' });
});

test('Transaction sheet: your own category says “Set by you.”, and nothing about changing it back', async ({
  page,
}) => {
  await page.goto('/activity/txn/n-dining');
  const sheet = page.getByRole('dialog', { name: 'Burma Superstar transaction' });
  await expect(sheet.getByText('Set by you.', { exact: true })).toBeVisible();
  await sheet.locator('#txn-cat').click();
  await page
    .getByRole('dialog', { name: 'Choose a category' })
    .getByRole('button', { name: 'Groceries' })
    .first()
    .click();
  await expect(sheet.locator('#txn-cat')).toHaveText(/Groceries/);
  await expect(sheet.getByText(/Set by|won’t change it back/)).toHaveCount(0);
});

test('Category picker: a search finds Ready to Assign, and a search that finds nothing says so', async ({
  page,
}) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  await add.getByRole('button', { name: 'In', exact: true }).click();
  await add.getByLabel('Category').click();
  const picker = page.getByRole('dialog', { name: 'Choose a category' });
  await picker.getByRole('searchbox', { name: 'Search categories' }).fill('zzz');
  await expect(picker.getByText('No category called “zzz”.')).toBeVisible();
  await picker.getByRole('searchbox', { name: 'Search categories' }).fill('ready');
  await picker.getByRole('button', { name: 'Ready to Assign' }).click();
  await expect(add.getByLabel('Category')).toHaveText(/Ready to Assign/);
});

test('Transfer: both sides name the two accounts the right way round', async ({ page }) => {
  for (const key of ['n-to-marcus', 'n-from-checking-m']) {
    await page.goto(`/activity/txn/${key}`);
    const sheet = page.getByRole('dialog', { name: 'Transfer' });
    await expect(sheet.getByText('From Everyday Checking', { exact: true })).toBeVisible();
    await expect(sheet.getByText('To Marcus Savings · Nov 12', { exact: true })).toBeVisible();
  }
  await page.goto('/activity/txn/n-sapphire-pay');
  await expect(
    page
      .getByRole('dialog', { name: 'Transfer' })
      .getByText('To Sapphire Preferred · Nov 4', { exact: true }),
  ).toBeVisible();
});

test('Transfer: Unpair says what happened, and both halves then need a category', async ({ page }) => {
  await page.goto('/activity/txn/n-to-marcus');
  const sheet = page.getByRole('dialog', { name: 'Transfer' });
  await sheet.getByRole('button', { name: 'Unpair' }).click();
  await expect(sheet.getByText('Both halves now need a category.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(
    page.getByRole('button', { name: /Choose category for Transfer to Marcus Savings/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Choose category for Transfer from Everyday Checking/ }),
  ).toBeVisible();
});

test('Paid back: money in that paid back two purchases lists both; Unlink, then Undo, puts both back', async ({
  page,
}) => {
  await page.goto('/owed');
  const out = page.getByText('Out with others').locator('..');
  await expect(out).toContainText('$1,430.60');
  await page.goto('/activity/match/n-venmo');
  await page.getByRole('button', { name: 'Match $1,018.00' }).click();
  await expect(page.getByText(/Matched \$1,018\.00\. 2 items are paid back\./)).toBeVisible();
  await page.goto('/activity/txn/n-venmo');
  const sheet = page.getByRole('dialog', { name: 'Venmo cashout paid back' });
  await expect(sheet.getByText('Nopa · Nov 8')).toBeVisible();
  await expect(sheet.getByText('Rent · Oct 31')).toBeVisible();
  await expect(sheet.getByText('It went to Ready to Assign and paid back $1,018.00.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Unlink' }).click();
  await expect(sheet.getByText('This $1,018.00 is back in Waiting to match.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Undo' }).click();
  await expect(sheet.getByText('Nopa · Nov 8')).toBeVisible();
  await page.goto('/owed');
  await expect(out).toContainText('$412.60');
  // The purchase's own sheet names the money that paid it.
  await page.goto('/activity/txn/n-nopa');
  await expect(
    page.getByRole('dialog', { name: 'Nopa paid back' }).getByText('Venmo cashout · Nov 14'),
  ).toBeVisible();
});

test('Owed to you: a custom amount over the purchase keeps Save off and says the most', async ({
  page,
  request,
}) => {
  await page.goto('/activity/txn/n-dining');
  const sheet = page.getByRole('dialog', { name: 'Burma Superstar transaction' });
  await sheet.getByRole('button', { name: 'Custom', exact: true }).click();
  await sheet.getByLabel('Amount owed').fill('200');
  await expect(sheet.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(sheet.getByTestId('disabled-why')).toHaveText('Enter at most $136.15 owed');
  await sheet.getByLabel('Amount owed').fill('136.15');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const e = (await rows(request, 'expected_reimbursement')).find((x) => x.txn_key === 'n-dining')!;
  expect(e.amount).toBe(13_615);
});
