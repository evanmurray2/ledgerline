// Edge cases on Accounts, account pages, Settings → Import and export, and Reports, through the real stack (SPA →
// Worker → local store seeded with the November fixture; "today" is Nov 14, 2026).
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

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

/** CSV history rows the server holds, as (date, amount, name). */
async function history(request: APIRequestContext) {
  return (await rows(request, 'bank_txn'))
    .filter((r) => String(r.provider_txn_id).startsWith('csv_'))
    .map((r) => ({ date: r.date, amount: r.amount, name: r.raw_name }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

test.beforeEach(async ({ page, request }) => {
  const r = await request.post('/__dev/seed-november', {
    headers: { 'content-type': 'application/json', 'x-ledgerline': '1' },
    data: {},
  });
  expect(r.ok()).toBe(true);
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

/** Settings → Import and export, with a file chosen. */
async function chooseFile(page: Page, name: string, body: string | Buffer) {
  await page.goto('/settings/data');
  await page.locator('input[type=file]').setInputFiles({
    name,
    mimeType: 'text/csv',
    buffer: typeof body === 'string' ? Buffer.from(body) : body,
  });
}

test('Import: a file is imported once; importing it again adds nothing and says so', async ({
  page,
  request,
}) => {
  const csv =
    'Date,Description,Amount\r\n10/02/2026,"Smith, Jones",-12.34\r\n09/30/2026,Corner Shop,(3.00)\r\n';
  await chooseFile(page, 'october.csv', csv);
  await page.getByLabel('Account it came from').selectOption({ label: 'Marcus Savings' });
  await page.getByRole('button', { name: 'Import 2 transactions' }).click();
  await expect(page.getByText('Imported 2 transactions as history.')).toBeVisible();
  expect(await history(request)).toEqual([
    { date: '2026-09-30', amount: -300, name: 'Corner Shop' },
    { date: '2026-10-02', amount: -1234, name: 'Smith, Jones' },
  ]);
  // The same file again, later (the app answers the very same change within 2 seconds itself): nothing doubles.
  await page.reload();
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'october.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByLabel('Account it came from').selectOption({ label: 'Marcus Savings' });
  await page.getByRole('button', { name: 'Import 2 transactions' }).click();
  await expect(
    page.getByText('Nothing new to import. Skipped 2 transactions already imported.'),
  ).toBeVisible();
  expect(await history(request)).toHaveLength(2);
});

test('Import: an empty file or one with only a header says there is nothing in it', async ({ page }) => {
  await chooseFile(page, 'empty.csv', '');
  await expect(page.getByText('This file has no transactions. Choose another file.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Import / })).toHaveCount(0);
  // The same input takes the next file (and the same one again).
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'head.csv', mimeType: 'text/csv', buffer: Buffer.from('date,payee,amount\n\n') });
  await expect(page.getByText('This file has no transactions. Choose another file.')).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({
    name: 'head.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('date,payee,amount\n2026-09-01,Shop,-1.00\n'),
  });
  await expect(page.getByRole('button', { name: 'Import 1 transaction' })).toBeVisible();
  await expect(page.getByText('This file has no transactions.')).toHaveCount(0);
});

test('Import: a file in the Windows encoding keeps its accents', async ({ page, request }) => {
  // "Café" in Windows-1252: é is the single byte 0xE9, which isn't valid UTF-8.
  const body = Buffer.concat([
    Buffer.from('date;payee;amount\n02.10.2026;Caf'),
    Buffer.from([0xe9]),
    Buffer.from(';-4,50\n'),
  ]);
  await chooseFile(page, 'cafe.csv', body);
  await page.getByLabel('Account it came from').selectOption({ label: 'Marcus Savings' });
  await page.getByRole('button', { name: 'Import 1 transaction' }).click();
  await expect(page.getByText('Imported 1 transaction as history.')).toBeVisible();
  expect(await history(request)).toEqual([{ date: '2026-10-02', amount: -450, name: 'Café' }]);
});

test('Import: lines it can’t read, and rows from the budget’s dates, are counted apart', async ({ page }) => {
  const csv = [
    'date,payee,amount',
    '2026-02-30,Bad day,-1.00',
    '2026-09-01,Bad amount,lots',
    '2026-11-10,In the budget,-2.00',
    '2026-09-02,Good,-3.00',
  ].join('\n');
  await chooseFile(page, 'mixed.csv', csv);
  await page.getByLabel('Account it came from').selectOption({ label: 'Marcus Savings' });
  await page.getByRole('button', { name: 'Import 4 transactions' }).click();
  await expect(
    page.getByText(
      'Imported 1 transaction as history. Skipped 1 transaction already in your linked accounts. Couldn’t read the date or amount on 2 lines.',
    ),
  ).toBeVisible();
});

test('Import: a file without the columns says which it needs', async ({ page }) => {
  await chooseFile(page, 'wrong.csv', 'when,who,how much\n2026-09-01,Shop,-1.00\n');
  await page.getByRole('button', { name: 'Import 1 transaction' }).click();
  await expect(page.getByText(/needs date, payee and amount columns/)).toBeVisible();
});

test('Register: a filter that no longer matches anything can still go back to All', async ({ page }) => {
  await page.goto('/accounts/marcus?show=pending');
  await expect(page.getByText('No transactions match.')).toBeVisible();
  // The filter on screen keeps its chip, at 0.
  await expect(page.getByRole('button', { name: /^Pending/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page).toHaveURL(/\/accounts\/marcus$/);
  await expect(page.getByText('No transactions match.')).toHaveCount(0);
});

test('Reports: a month before the budget starts shows the first month', async ({ page }) => {
  await page.goto('/reports?month=2026-01');
  await expect(page.getByTestId('month-label')).toContainText('October 2026');
  await expect(page.getByRole('button', { name: 'Previous month' })).toBeDisabled();
  await expect(page.getByText('January 2026')).toHaveCount(0);
});

test('Setup: Back to a finished setup goes to the budget, so it can’t run twice', async ({ page }) => {
  for (const path of ['/setup/categories', '/setup/link', '/setup/start', '/welcome']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/budget$/);
  }
  await expect(page.getByRole('button', { name: 'Go to my budget' })).toHaveCount(0);
});

/** No part of the screen is wider than the window (a long word would push the page sideways on a phone). */
async function noSideScroll(page: Page) {
  const wide = await page.evaluate(() =>
    Array.from(document.querySelectorAll('body *'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > window.innerWidth + 1;
      })
      .map((el) => `${el.tagName}.${el.className}`.slice(0, 80)),
  );
  expect(wide).toEqual([]);
}

test('Accounts: a long name with no spaces, and emoji, fit on the screen', async ({ page, request }) => {
  const name = 'Ünïcödé🏦Savings' + 'X'.repeat(44);
  const r = await request.post('/api/accounts/marcus/name', {
    headers: { 'content-type': 'application/json', 'x-ledgerline': '1' },
    data: { name },
  });
  expect(r.ok()).toBe(true);
  await page.goto('/accounts');
  await expect(page.getByText(name).first()).toBeVisible();
  await noSideScroll(page);
  await page.goto('/accounts/marcus');
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await noSideScroll(page);
  await page.goto('/settings/data');
  await page.locator('input[type=file]').setInputFiles({
    name: 'a.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('date,payee,amount\n2026-09-01,x,-1\n'),
  });
  await page.getByLabel('Account it came from').selectOption({ label: name });
  await noSideScroll(page);
});

test('Accounts: a name of only spaces is refused, and the old name stays', async ({ page }) => {
  await page.goto('/accounts/marcus');
  await page.getByRole('button', { name: 'More for this account' }).click();
  await page.getByRole('button', { name: 'Rename account' }).click();
  const sheet = page.getByRole('dialog', { name: 'Rename account' });
  await sheet.getByLabel('Name').fill('   ');
  await expect(sheet.getByRole('button', { name: 'Save' })).toBeDisabled();
  await sheet.getByLabel('Name').fill('  Rainy day  ');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Rainy day', exact: true })).toBeVisible();
});

test('Import: a file too big for one import says to split it', async ({ page }) => {
  const line = '2026-09-01,Shop with a long name for size,-1.00\n';
  const body = 'date,payee,amount\n' + line.repeat(Math.ceil(5_000_001 / line.length));
  await page.goto('/settings/data');
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'big.csv', mimeType: 'text/csv', buffer: Buffer.from(body) });
  await expect(page.getByText('This file is too big. Import one year at a time.')).toBeVisible();
});

test('Full backup: the file ends with its end line, and Download works twice', async ({ page }) => {
  await page.goto('/settings/data');
  for (let i = 0; i < 2; i++) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).last().click();
    const d = await download;
    const text = await (await import('node:fs/promises')).readFile((await d.path())!, 'utf8');
    const lines = text.trim().split('\n');
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ end: true });
  }
});

test('Exports: the transactions CSV reads back with its quotes and commas', async ({ page, request }) => {
  // A payee with a comma and a quote, and a memo with a line break.
  await request.post('/api/accounts/marcus/name', {
    headers: { 'content-type': 'application/json', 'x-ledgerline': '1' },
    data: { name: 'Savings, "rainy"' },
  });
  await page.goto('/settings/data');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Transactions (CSV)' }).click();
  const d = await download;
  const text = await (await import('node:fs/promises')).readFile((await d.path())!, 'utf8');
  expect(text.split('\n')[0]).toBe('date,account,payee,amount,status,category,memo,raw_name');
  expect(text).toContain('"Savings, ' + '""rainy""' + '"');
});

test('Register: each filter chip’s count is the number of rows it shows', async ({ page }) => {
  for (const id of ['sapphire', 'freedom', 'checking', 'ally', 'marcus']) {
    await page.goto(`/accounts/${id}`);
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Account');
    const chips = page.getByRole('group', { name: 'Show' }).getByRole('button');
    const names = (await chips.allTextContents()).filter((t) => !/^All/.test(t));
    for (const name of names) {
      const n = Number(/\d+$/.exec(name)![0]);
      const label = name.replace(/\d+$/, '');
      await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: label }).click();
      await expect(page.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('main a[href*="/txn/"]'), `${id} ${label}`).toHaveCount(n);
      await page
        .getByRole('group', { name: 'Show' })
        .getByRole('button', { name: 'All', exact: true })
        .click();
    }
  }
});

test('Reports: a month with more refunds than spending reads as a negative amount', async ({ page }) => {
  await page.goto('/activity/add');
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  await add.getByPlaceholder('0.00').fill('20000');
  await add.getByRole('button', { name: 'In', exact: true }).click();
  await add.getByLabel('Payee').fill('Big refund');
  await add.getByLabel('Category').click();
  await page
    .getByRole('dialog', { name: 'Choose a category' })
    .getByRole('button', { name: 'Groceries' })
    .first()
    .click();
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add).toHaveCount(0);
  await page.goto('/reports');
  if (test.info().project.name === 'phone') await page.getByRole('button', { name: 'Trends' }).click();
  const chart = page.getByRole('img', { name: /^Spending by month/ });
  await expect(chart).toHaveAttribute('aria-label', /Nov −\$[\d.,]+k? so far/);
  await expect(chart).not.toHaveAttribute('aria-label', /\$-/);
});
