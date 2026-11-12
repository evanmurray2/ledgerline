// The prototype's November through the real stack: SPA → Worker → local store (seeded fixture) → the phone's engine → Money rules.
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
  await expect(rta(page)).toHaveText('$1,999.90');
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
  // No outside host at all: banks are linked on Plaid's own site (docs/privacy.md 5.7).
  expect(csp).not.toContain('https:');
  expect(res?.headers()['x-frame-options']).toBe('DENY');
  await expect(rta(page)).toHaveText('$1,999.90');
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
  await expect(rta(page)).toHaveText('$1,999.90');
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
  expect(await page.evaluate(() => window.localStorage.getItem('ledgerline-saved-data'))).toBeNull();
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByText('Connect to the internet and try again', { exact: false }).first(),
  ).toBeVisible();
  await context.setOffline(false);
});

test('Needs attention fixes reach $1,851.65 through the API', async ({ page }) => {
  await page.goto('/budget?view=attention');
  await expect(rta(page)).toHaveText('$1,999.90');
  for (const [name, after] of [
    ['Cover $18.25 for Dining out', '$1,981.65'],
    ['Fund $90.00 for Car insurance', '$1,891.65'],
    ['Fund $250.00 for Vacation', '$1,641.65'],
    ['Move $210.00 for Gifts', '$1,851.65'],
  ] as const) {
    await page.getByRole('button', { name }).click();
    await expect(rta(page)).toHaveText(after);
  }
  await page.reload();
  await expect(rta(page)).toHaveText('$1,851.65');
});

test('A pinned category is saved with the budget', async ({ page }) => {
  await page.goto('/budget');
  const rows = page.locator('[data-track="budget.category"]', { hasText: 'Personal care' });
  await rows.first().click();
  await page.getByRole('button', { name: 'Pin Personal care to the top' }).click();
  await expect(page.getByText('Personal care pinned to the top')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByText('Pinned', { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(2);
  await rows.first().click();
  await page.getByRole('button', { name: 'Pin Personal care to the top' }).click();
  await expect(page.getByText('Personal care unpinned')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(rows.first()).toBeVisible();
  await expect(page.getByText('Pinned', { exact: true })).toHaveCount(0);
});

test('An edit’s answer brings what it changed: no second sync request', async ({ page }) => {
  await page.goto('/budget');
  const rows = page.locator('[data-track="budget.category"]', { hasText: 'Personal care' });
  await rows.first().click();
  const syncs: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/sync') syncs.push(r.url());
  });
  const answer = page.waitForResponse((r) => /\/api\/settings\/categories\/[^/]+\/pin$/.test(r.url()));
  await page.getByRole('button', { name: 'Pin Personal care to the top' }).click();
  const r = await answer;
  expect(Number(r.request().headers()['x-sync-since'])).toBeGreaterThan(0);
  const body = (await r.json()) as { ok: boolean; sync?: { rows: unknown[]; more: boolean } };
  expect(body.sync?.rows.length).toBeGreaterThan(0);
  expect(body.sync?.more).toBe(false);
  await expect(page.getByText('Personal care pinned to the top')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Pinned', { exact: true })).toBeVisible();
  expect(syncs).toEqual([]);
  // Put it back.
  await rows.first().click();
  await page.getByRole('button', { name: 'Pin Personal care to the top' }).click();
  await expect(page.getByText('Personal care unpinned')).toBeVisible();
});

test('Activity: categorizing an uncategorized purchase persists', async ({ page }) => {
  await page.goto('/activity?filter=all');
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
  // Going to another tab and back, in the app, doesn't bring the row back (the list's cache was marked fresh by
  // the count change, so it showed the old list for 2 minutes).
  await page
    .getByRole('link', { name: /Budget/ })
    .first()
    .click();
  await expect(rta(page)).toBeVisible();
  await page
    .getByRole('link', { name: /Activity/ })
    .first()
    .click();
  await expect(chip).toHaveText(`Needs attention ${before - 1}`);
  await expect(page.getByRole('button', { name: /Choose category for Amazon −\$38\.10/ })).toHaveCount(0);
  // Leaving and coming back shows the server's state.
  await page.goto('/budget');
  await page.goto('/activity');
  await expect(chip).toHaveText(`Needs attention ${before - 1}`);
  await page.reload();
  await expect(page.getByRole('button', { name: /Choose category for Amazon −\$38\.10/ })).toHaveCount(0);
});

test('Activity: OK on a bank row that cleared at a new amount clears it', async ({ page }) => {
  await page.goto('/activity');
  const chip = page.getByRole('button', { name: /^Needs attention \d+$/ });
  const ok = page.getByRole('button', { name: 'OK Shake Shack' });
  await expect(ok).toBeVisible();
  const before = Number((await chip.textContent())!.match(/\d+/)![0]);
  await ok.click();
  await expect(page.getByText('Shake Shack · marked OK')).toBeVisible();
  await expect(ok).toHaveCount(0);
  await expect(chip).toHaveText(`Needs attention ${before - 1}`);
  await page.reload();
  await expect(chip).toHaveText(`Needs attention ${before - 1}`);
  await expect(ok).toHaveCount(0);
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
  await page.goto('/activity?filter=all');
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

test('An entry added with no signal is kept on the device and sent once when the connection is back', async ({
  page,
  context,
  request,
}) => {
  await page.goto('/activity');
  const onServer = async () =>
    (await rows(request, 'manual_pending')).filter((m) => m.payee_name === 'Offline lunch');
  await expect(page.getByRole('link', { name: 'Add transaction' })).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await page.getByRole('link', { name: 'Add transaction' }).click();
  const add = page.getByRole('dialog', { name: 'Add a transaction' });
  await add.getByPlaceholder('0.00').fill('12.34');
  await add.getByLabel('Payee').fill('Offline lunch');
  await add.getByLabel('Category').click();
  await page
    .getByRole('dialog', { name: 'Choose a category' })
    .getByRole('button', { name: 'Dining out' })
    .first()
    .click();
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add).toHaveCount(0);
  // The copy took it at once; the server hasn't seen it.
  await expect(page.getByTestId('offline-banner')).toContainText('1 waiting to send');
  await expect(page.getByText('Offline lunch').first()).toBeVisible();
  expect(await onServer()).toHaveLength(0);

  await context.setOffline(false);
  await expect.poll(async () => (await onServer()).length, { timeout: 15_000 }).toBe(1);
  expect((await onServer())[0]!.amount).toBe(-1234);
  // The phone's row and the server's are one row (the same id), not two.
  await page.reload();
  await expect(page.getByText('Offline lunch')).toHaveCount(1);
});

test('An edit the server refuses is taken out; the edit made after it stays and is sent', async ({
  page,
  context,
  request,
}) => {
  await page.goto('/activity');
  const onServer = async (payee: string) =>
    (await rows(request, 'manual_pending')).filter((m) => m.payee_name === payee).length;
  const addLink = page.getByRole('link', { name: 'Add transaction' });
  await expect(addLink).toBeVisible();
  const addEntry = async (payee: string, amount: string) => {
    await addLink.click();
    const add = page.getByRole('dialog', { name: 'Add a transaction' });
    await add.getByPlaceholder('0.00').fill(amount);
    await add.getByLabel('Payee').fill(payee);
    await add.getByLabel('Category').click();
    await page
      .getByRole('dialog', { name: 'Choose a category' })
      .getByRole('button', { name: 'Dining out' })
      .first()
      .click();
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(add).toHaveCount(0);
  };

  await context.setOffline(true);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await addEntry('Refused dinner', '20.00');
  await addEntry('Kept dinner', '30.00');
  await expect(page.getByTestId('offline-banner')).toContainText('2 waiting to send');
  await expect(page.getByText('Refused dinner').first()).toBeVisible();

  // Back online, the server refuses the first of the two (here: the test answers in its place).
  let refusedOnce = false;
  await page.route('**/api/transactions', async (route) => {
    const body = route.request().postData() ?? '';
    if (!refusedOnce && route.request().method() === 'POST' && body.includes('Refused dinner')) {
      refusedOnce = true;
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid', message: 'Refused by the test.' }),
      });
    } else await route.continue();
  });
  // Nothing is downloaded again: every sync after this asks only for what changed.
  const syncs: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/sync')) syncs.push(new URL(r.url()).searchParams.get('since') ?? '');
  });
  await context.setOffline(false);
  await expect.poll(() => onServer('Kept dinner'), { timeout: 15_000 }).toBe(1);
  expect(refusedOnce).toBe(true);
  expect(syncs.length).toBeGreaterThan(0);
  expect(syncs.filter((since) => since === '0' || since === '')).toEqual([]);
  expect(await onServer('Refused dinner')).toBe(0);
  // The copy dropped the refused entry and kept the other, as one row.
  await expect(page.getByText('Refused dinner')).toHaveCount(0);
  await expect(page.getByText('Kept dinner')).toHaveCount(1);
  await page.reload();
  await expect(page.getByText('Refused dinner')).toHaveCount(0);
  await expect(page.getByText('Kept dinner')).toHaveCount(1);
});

test('Accounts: net worth and the Ally repair prompt', async ({ page }) => {
  await page.goto('/accounts');
  await expect(page.getByText('$22,354.35').first()).toBeVisible();
  await expect(page.getByText(/Ally/).first()).toBeVisible();
});

test('Categories: rename a group, reorder by dragging, and remove a category', async ({ page }) => {
  await page.goto('/categories');
  const groups = page.locator('section').getByRole('heading', { level: 2 });
  // Card payments are made by the app and can't be edited, so only your groups show.
  await expect(groups.filter({ hasText: 'Card payments' })).toHaveCount(0);
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

  // An overspent category can't be removed: archived, its overspending would drop out of Budget's attention.
  await page.getByRole('link', { name: /^Dining out/ }).click();
  const edit = page.getByRole('dialog', { name: 'Edit category' });
  await expect(edit.getByText('To remove Dining out, cover its $18.25 overspending first.')).toBeVisible();
  await expect(edit.getByRole('button', { name: 'Remove Dining out…' })).toHaveCount(0);
  await edit.getByRole('button', { name: 'Close' }).click();

  // Removing happens on the category's own sheet, with a confirm step.
  await page.getByRole('link', { name: /^Groceries/ }).click();
  await edit.getByRole('button', { name: 'Remove Groceries…' }).click();
  await edit.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('Groceries archived. Reports keep its history.')).toBeVisible();
  await expect(page.getByRole('link', { name: /^Groceries/ })).toHaveCount(0);
});

test('Target: a yearly refill is met in its Due month, and the Due month is kept', async ({ page }) => {
  await page.goto('/budget/category/groceries/target');
  await page.getByPlaceholder('0.00').fill('124');
  await page.getByRole('button', { name: 'Year', exact: true }).click();
  await page.getByLabel('Due').fill('2027-03');
  // November through March: five steps, the last one in March.
  await expect(page.getByText(/by Mar(ch)? 2027, in 5 steps/)).toBeVisible();
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
  // The sheet closes when the add is saved: leaving the page sooner can drop it.
  await expect(add).toHaveCount(0);
  await page.goto('/budget');
  await expect(rta(page)).toHaveText('$2,499.90');

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
  await page.getByRole('dialog').getByRole('button', { name: 'Estimate…' }).click();
  await page.getByRole('dialog').getByLabel('Your estimate').fill('123.45');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).not.toHaveURL(/\/txn\//);
  const after = (await rows(request, 'txn_overlay')).find((o) => o.txn_key === key)!;
  expect(after.estimated_amount).toBe(-12_345);
});

test('Accounts: rename an account', async ({ page }) => {
  await page.goto('/accounts/sapphire');
  await page.getByRole('button', { name: 'More for this account' }).click();
  await page.getByRole('button', { name: 'Rename account' }).click();
  const sheet = page.getByRole('dialog', { name: 'Rename account' });
  await sheet.getByLabel('Name').fill('Travel card');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Travel card' })).toBeVisible();
  await page.goto('/accounts');
  await expect(page.getByText('Travel card').first()).toBeVisible();
});

test('Accounts: Close account says why it can’t close a card with a balance', async ({ page }) => {
  await page.goto('/accounts/sapphire');
  await page.getByRole('button', { name: 'More for this account' }).click();
  await page.getByRole('button', { name: 'Close account' }).click();
  const sheet = page.getByRole('dialog', { name: 'Close account' });
  await expect(sheet.getByText(/You still owe \$[\d,.]+ on this card\. Pay it off first\./)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Close account' })).toBeDisabled();
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
  // Settings is loaded when first opened: until its code arrives the screen isn't shown, so it records no view.
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Budget' }).first().click();
  await expect(page).toHaveURL(/\/budget/);
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/usage') && r.method() === 'POST');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await sent;
  expect(views).toContain('settings');
  expect(views).toContain('budget');
  expect(views).not.toContain('settings.appearance');
});
