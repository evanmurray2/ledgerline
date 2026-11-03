// The prototype's November through the real stack: SPA → Worker → local D1 (seeded fixture) → Money rules.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const rta = (page: Page) => page.getByTestId(test.info().project.name === 'desktop' ? 'nav-rta' : 'rta');

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

test('The app is served with its security headers, and nothing on Budget breaks them', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  const res = await page.goto('/budget');
  const csp = res?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain('https://cdn.plaid.com');
  expect(res?.headers()['x-frame-options']).toBe('DENY');
  await expect(rta(page)).toHaveText('$981.90');
  await page
    .getByRole('link', { name: /Activity/ })
    .first()
    .click();
  await page.waitForLoadState('networkidle');
  expect(violations).toEqual([]);
});

test('With no passkey copy, nothing is kept on the device: with no signal it says it can’t connect', async ({
  page,
  context,
}) => {
  // A saved copy needs a passkey sign-in on an iPhone or iPad (D-45, D-48; passkey.spec.ts covers it). This
  // browser signs in without one.
  await page.goto('/budget');
  await expect(rta(page)).toHaveText('$981.90');
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
  expect(await page.evaluate(() => window.localStorage.getItem('ledgerline-saved-data'))).toBeNull();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('Couldn’t reach Ledgerline', { exact: false }).first()).toBeVisible();
  await context.setOffline(false);
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

test('Changes made elsewhere show when the app opens again', async ({ page, request }) => {
  await page.goto('/activity');
  const chip = page.getByRole('button', { name: /^Needs attention \d+$/ });
  await expect(chip).toHaveText(/Needs attention [1-9]/);
  const before = Number((await chip.textContent())!.match(/\d+/)![0]);
  // Another device categorizes the Amazon purchase…
  const txn = (await rows(request, 'bank_txn')).find(
    (r) => r.amount === -3810 && /amazon/i.test(String(r.raw_name)),
  )!;
  const shopping = (await rows(request, 'category')).find((c) => c.name === 'Shopping')!;
  const r = await request.patch(`/api/transactions/${encodeURIComponent(String(txn.txn_key))}`, {
    headers: { 'content-type': 'application/json', 'x-ledgerline': '1' },
    data: { categoryId: shopping.id },
  });
  expect(r.ok()).toBe(true);
  // …and this one picks it up from the server's change log when it opens again.
  await page.reload();
  await expect(chip).toHaveText(`Needs attention ${before - 1}`);
});

test('A change made with no signal is kept on the device and sent when the connection is back', async ({
  page,
  context,
  request,
}) => {
  await page.goto('/activity');
  const chip = page.getByRole('button', { name: /^Needs attention \d+$/ });
  await expect(chip).toHaveText(/Needs attention [1-9]/);
  const before = Number((await chip.textContent())!.match(/\d+/)![0]);
  const txn = (await rows(request, 'bank_txn')).find(
    (r) => r.amount === -3810 && /amazon/i.test(String(r.raw_name)),
  )!;
  const shopping = (await rows(request, 'category')).find((c) => c.name === 'Shopping')!;
  const onServer = async () =>
    (await rows(request, 'txn_overlay')).find((o) => o.txn_key === txn.txn_key)?.category_id ?? null;

  await context.setOffline(true);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await page.getByRole('button', { name: /Choose category for Amazon −\$38\.10/ }).click();
  await page
    .getByRole('dialog', { name: 'Choose a category' })
    .getByRole('button', { name: 'Shopping' })
    .first()
    .click();
  // The copy took it at once; the server hasn't seen it.
  await expect(chip).toHaveText(`Needs attention ${before - 1}`);
  await expect(page.getByTestId('offline-banner')).toContainText('1 waiting to send');
  expect(await onServer()).not.toBe(shopping.id);

  await context.setOffline(false);
  await expect.poll(onServer, { timeout: 15_000 }).toBe(shopping.id);
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
  // Card payments are made by the app and can't be edited, so only your groups show.
  await expect(groups.filter({ hasText: 'Credit card payments' })).toHaveCount(0);
  await expect(groups.nth(0)).toHaveText('Bills');
  await expect(groups.nth(1)).toHaveText('Everyday');
  // Drag Bills below Everyday by its handle: no Edit mode.
  const handle = page.getByRole('button', { name: 'Reorder group Bills' });
  const everyday = page.getByRole('link', { name: 'Rename group Everyday' });
  const from = (await handle.boundingBox())!;
  const to = (await everyday.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 400, { steps: 12 });
  await page.mouse.up();
  await expect(groups.nth(0)).toHaveText('Everyday');
  await expect(groups.nth(1)).toHaveText('Bills');

  await page.getByRole('link', { name: 'Rename group Everyday' }).click();
  const sheet = page.getByRole('dialog', { name: 'Rename group' });
  await sheet.getByLabel('Name').fill('Day to day');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(groups.nth(0)).toHaveText('Day to day');

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
  // Screens are worked out on the device (D-45): the server's own rows say which charge is a plain card hold.
  const overlays = new Map((await rows(request, 'txn_overlay')).map((o) => [o.txn_key, o]));
  const hold = (await rows(request, 'bank_txn')).find(
    (r) =>
      r.pending === 1 &&
      r.removed_at === null &&
      (r.amount as number) < 0 &&
      !overlays.get(r.txn_key)?.estimated_amount &&
      !overlays.get(r.txn_key)?.transfer_state,
  )!;
  const key = String(hold.txn_key);
  await page.goto(`/activity/txn/${encodeURIComponent(key)}`);
  await page.getByRole('dialog').getByLabel('Your estimate').fill('123.45');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).not.toHaveURL(/\/txn\//);
  const after = (await rows(request, 'txn_overlay')).find((o) => o.txn_key === key)!;
  expect(after.estimated_amount).toBe(-12_345);
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

test('Full backup: downloads every row of the budget as one file', async ({ page }) => {
  await page.goto('/settings/data');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).last().click();
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/^ledgerline-backup-\d{4}-\d{2}-\d{2}\.ndjson$/);
  const text = await (await import('node:fs/promises')).readFile((await d.path())!, 'utf8');
  const lines = text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(lines[0]).toMatchObject({ format: 'ledgerline-dump' });
  expect(lines.at(-1)).toMatchObject({ end: true });
  expect(lines.filter((l) => l.t === 'bank_txn').length).toBeGreaterThan(10);
  await expect(page.getByText('Saved. Keep it somewhere safe.')).toBeVisible();
});

test('Exports: Usage and notes downloads as a JSON file', async ({ page }) => {
  await page.goto('/settings/data');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Usage and notes (JSON)' }).click();
  const d = await download;
  expect(d.suggestedFilename()).toBe('ledgerline-usage.json');
  const text = await (await import('node:fs/promises')).readFile((await d.path())!, 'utf8');
  expect(JSON.parse(text)).toMatchObject({ events: expect.any(Array), daily: expect.any(Array) });
});

test('Usage: leaving Settings records no visit to Appearance', async ({ page }) => {
  const views: string[] = [];
  page.on('request', (r) => {
    if (!r.url().endsWith('/api/usage') || r.method() !== 'POST') return;
    const body = r.postDataJSON() as { events: { event: string; screen: string }[] };
    for (const e of body.events) if (e.event === 'view') views.push(e.screen);
  });
  // The first screen of a page load comes before usage is switched on, so Settings is opened from the app.
  await page.goto('/accounts');
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await expect(page).toHaveURL(/\/settings/);
  await page.getByRole('link', { name: 'Budget' }).first().click();
  await expect(page).toHaveURL(/\/budget/);
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/usage') && r.method() === 'POST');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await sent;
  expect(views).toContain('settings');
  expect(views).toContain('budget');
  expect(views).not.toContain('settings.appearance');
});
