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
  await page
    .locator('input[type=file]')
    .setInputFiles({
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
