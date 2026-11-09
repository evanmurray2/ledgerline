// Edge cases of sync, the phone's copy and the API through the real stack (SPA → Worker → store → the phone's
// engine), with the November fixture and "today" pinned to Nov 14, 2026: odd links, two tabs at once, changes made
// while a download is under way, and input the app itself never sends.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const rta = (page: Page) => page.getByTestId(test.info().project.name === 'desktop' ? 'nav-rta' : 'rta');

interface Page_ {
  through: number;
  more: boolean;
  cursor: string | null;
  rows: { t: string; k: unknown[]; d: Record<string, unknown> | null }[];
}
const syncPage = async (request: APIRequestContext, q: string): Promise<Page_> => {
  const r = await request.get(`/api/sync?${q}`);
  expect(r.status(), q).toBe(200);
  return (await r.json()) as Page_;
};

test.beforeEach(async ({ page, request }) => {
  const r = await request.post('/__dev/seed-november', { headers: H, data: {} });
  expect(r.ok()).toBe(true);
  await page.addInitScript(() => {
    if (!window.localStorage.getItem('ledgerline-theme')) window.localStorage.setItem('ledgerline-theme', 'light');
  });
});

test('A Budget link to a month thousands of years away doesn’t stop the app', async ({ page }) => {
  await page.goto('/budget?month=9999-12');
  await expect(page.getByText('That month isn’t in your budget. Pick another month.').first()).toBeVisible();
  // The app still works: this month opens.
  await page.goto('/budget');
  await expect(rta(page)).toHaveText('$981.90');
});

test('A change made between the pages of a full download arrives with the next sync', async ({ request }) => {
  // A full download, one small page at a time…
  let p = await syncPage(request, 'since=0&limit=20');
  const through = p.through;
  let pages = 1;
  // …and another device assigns $5 to Dining out while it runs.
  const a = await request.post('/api/budget/assign', {
    headers: H,
    data: { month: '2026-11', items: [{ categoryId: 'dining', amount: 500 }] },
  });
  expect(a.ok()).toBe(true);
  while (p.cursor) {
    p = await syncPage(request, `since=0&limit=500&cursor=${encodeURIComponent(p.cursor)}`);
    pages++;
    // Every page of one download says the same change number: the one it started at.
    expect(p.through).toBe(through);
  }
  expect(pages).toBeGreaterThan(1);
  // The changes after it bring the new assignment.
  const next = await syncPage(request, `since=${through}`);
  const row = next.rows.find((r) => r.t === 'assignment' && r.d?.category_id === 'dining' && r.d.month === '2026-11');
  expect(row?.d).toBeTruthy();
  expect(next.through).toBeGreaterThan(through);
  // And nothing is left after that.
  expect((await syncPage(request, `since=${next.through}`)).rows).toEqual([]);
});

test('Two tabs assigning at once both count', async ({ page, context }) => {
  const other = await context.newPage();
  await page.goto('/budget?view=attention');
  await other.goto('/budget?view=attention');
  await expect(rta(page)).toHaveText('$981.90');
  await expect(rta(other)).toHaveText('$981.90');
  // The same fix on both tabs at the same moment: each tab's tap is its own change.
  await Promise.all([
    page.getByRole('button', { name: 'Cover $18.25 for Dining out' }).click(),
    other.getByRole('button', { name: 'Cover $18.25 for Dining out' }).click(),
  ]);
  await page.reload();
  await other.reload();
  await expect(rta(page)).toHaveText('$945.40');
  await expect(rta(other)).toHaveText('$945.40');
});

test('The API answers bad input plainly, never with a server error', async ({ request }) => {
  const send = (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, data: string, headers = H) =>
    request.fetch(path, { method, headers, data });
  for (const [method, path] of [
    ['POST', '/api/budget/assign'],
    ['POST', '/api/budget/set'],
    ['POST', '/api/budget/move'],
    ['PUT', '/api/categories/dining/target'],
    ['POST', '/api/transactions'],
    ['POST', '/api/transactions/categorize'],
    ['POST', '/api/settings/categories'],
    ['POST', '/api/settings/payees/merge'],
    ['PATCH', '/api/settings'],
    ['POST', '/api/usage'],
    ['POST', '/api/notes'],
    ['POST', '/api/settings/security/sign-out-session'],
    ['POST', '/api/auth/copy-status'],
  ] as const)
    for (const body of ['null', '[]', '"x"', '{', '{"month":"2026-11","items":[{"categoryId":"dining","amount":0.5}]}']) {
      const r = await send(method, path, body);
      expect(r.status(), `${method} ${path} ${body}`).toBeLessThan(500);
      expect(r.headers()['content-type'], `${method} ${path} ${body}`).toContain('application/json');
    }
  // Amounts that aren't whole cents, or are past what a number holds exactly.
  for (const amount of [0.5, 1e16, -1e300, '100', null])
    expect(
      (
        await send(
          'POST',
          '/api/budget/assign',
          JSON.stringify({ month: '2026-11', items: [{ categoryId: 'dining', amount }] }),
        )
      ).status(),
      String(amount),
    ).toBe(400);
  // A change without the app's header, or as a form, is refused.
  const ok = JSON.stringify({ month: '2026-11', items: [{ categoryId: 'dining', amount: 100 }] });
  expect((await send('POST', '/api/budget/assign', ok, { 'content-type': 'application/json' })).status()).toBe(403);
  expect(
    (await send('POST', '/api/budget/assign', ok, { 'content-type': 'text/plain', 'x-ledgerline': '1' })).status(),
  ).toBe(415);
  expect(
    (await send('POST', '/api/budget/assign', ok, { ...H, origin: 'https://evil.example' })).status(),
  ).toBe(403);
  // Security headers on every API answer, refusals too.
  const r = await request.get('/api/nope-not-a-route');
  expect(r.headers()['x-content-type-options']).toBe('nosniff');
  expect(r.headers()['cache-control']).toBe('no-store');
  expect(r.headers()['x-frame-options']).toBe('DENY');
});

test('Sync paging: odd limits and cursors get a bounded page or a plain refusal', async ({ request }) => {
  for (const limit of ['-1', '0', '1.5', 'abc', '99999']) {
    const p = await syncPage(request, `since=0&limit=${limit}`);
    expect(p.rows.length, limit).toBeGreaterThan(0);
    expect(p.rows.length, limit).toBeLessThanOrEqual(500);
    const q = await syncPage(request, `since=1&limit=${limit}`);
    expect(q.rows.length, limit).toBeLessThanOrEqual(500);
  }
  for (const cursor of ['garbage', '{"t":0,"after":[],"through":0}', '{"t":0,"after":[1,2,3,4,5],"through":0}'])
    expect((await request.get(`/api/sync?since=0&cursor=${encodeURIComponent(cursor)}`)).status(), cursor).toBe(400);
  for (const since of ['-1', 'abc', '1.5'])
    expect((await request.get(`/api/sync?since=${since}`)).status(), since).toBe(400);
});

test('Appearance: Dark stays after a reload, and Match device follows the device', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Dark/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('radio', { name: /Match device/ }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
