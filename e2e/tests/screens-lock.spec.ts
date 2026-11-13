// A locked budget's screens through the real Worker (D-102), each on a new account made in the browser: Accounts
// and Banks of a budget with no bank on a phone (Sync and pull to refresh ask the Worker's Fetch now), and two
// devices on one log: an edit on one shows on the other when it comes back to the app, a new recovery key from
// Settings → Sign-in, the copy made again from a snapshot (the rebuild banner), and Sign out deleting the copy.
// Runs after lock.spec.ts, on the same Worker (playwright.lock.config.ts).
import { expect, test, type Page } from '@playwright/test';
import {
  addCategory,
  call,
  comeBack,
  joinWithRecoveryKey,
  newDevice,
  newLockedBudget,
  savedCopy,
} from './lock-helpers';

/** A touch dragged down from the top of the list, or let go. */
const drag = (page: Page, phase: 'pull' | 'release') =>
  page.evaluate(async (phase) => {
    const el = document.querySelector('[data-testid="net-worth"]')!.closest('.overflow-y-auto')!;
    const touch = (y: number) => new Touch({ identifier: 1, target: el, clientX: 100, clientY: y });
    const fire = (type: string, y: number) =>
      el.dispatchEvent(
        new TouchEvent(type, {
          touches: type === 'touchend' ? [] : [touch(y)],
          changedTouches: [touch(y)],
          bubbles: true,
          cancelable: true,
        }),
      );
    if (phase === 'release') return void fire('touchend', 300);
    fire('touchstart', 100);
    for (let y = 110; y <= 300; y += 20) {
      fire('touchmove', y);
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, phase);

test('a locked budget with no bank, on a phone: pulling down and Sync ask the Worker, and Banks says so', async ({
  browser,
}) => {
  const { page } = await newLockedBudget(browser, '198.51.100.21', {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  await page.goto('/accounts');
  await expect(page.getByTestId('net-worth')).toHaveText('$0.00', { timeout: 30_000 });

  // Pulling down asks the Worker to fetch every bank (Fetch now): none is linked, so it is up to date at once.
  const pulled = page.waitForResponse((r) => r.url().endsWith('/api/settings/connections/refresh'));
  await drag(page, 'pull');
  await expect(page.getByTestId('pull-refresh')).toContainText('Release to sync');
  await drag(page, 'release');
  const r = await pulled;
  expect(r.status()).toBe(200);
  expect(await r.json()).toEqual({ ok: true, started: 0 });
  await expect(page.getByTestId('pull-refresh')).toContainText('Up to date');

  // Banks: the server knows no link of this budget, and only the owner links banks (D-75).
  expect((await call(page, 'GET', '/api/settings/connections')).json).toMatchObject({ used: 0, items: [] });
  await page.goto('/settings/connections');
  await expect(page.getByText('Linking banks isn’t available on your account yet.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('Test mode: test banks only.')).toBeVisible();
  await expect(page.getByTestId('link-meter')).toHaveCount(0);

  // Back on Accounts, the Sync button in the header asks the same. (A tap within 2 seconds of the pull would get
  // the pull's answer and send nothing: api/client.ts keeps a double tap from sending a change twice.)
  await page.goto('/accounts');
  await expect(page.getByTestId('net-worth')).toHaveText('$0.00', { timeout: 30_000 });
  const synced = page.waitForResponse((r) => r.url().endsWith('/api/settings/connections/refresh'));
  await page.getByRole('button', { name: 'Sync', exact: true }).tap();
  expect((await synced).status()).toBe(200);
  await expect(page.getByTestId('pull-refresh')).toContainText('Up to date');
  await page.context().close();
});

test('two devices on one log: an edit shows on coming back, a new recovery key, a rebuild, and Sign out', async ({
  browser,
}) => {
  // Two devices, three sign-ins and a rebuild: more than the usual 2 minutes.
  test.setTimeout(240_000);
  const { page, key: oldKey } = await newLockedBudget(browser, '198.51.100.22');

  // ---- Settings → Sign-in → Recovery key: the lock set its sign-in, and a new key replaces it
  await page.goto('/settings/sign-in');
  const card = page.getByTestId('recovery-key-card');
  await expect(
    card.getByText('It opens your budget and signs you in if you lose every passkey.'),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(card.getByText('Set up sign-in with it')).toHaveCount(0);
  await card.getByRole('button', { name: 'Make a new recovery key' }).click();
  const newKey = (await card.getByTestId('recovery-key').textContent())!;
  expect(newKey).not.toBe(oldKey);
  await expect(card.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await card.getByRole('checkbox').check();
  await card.getByRole('button', { name: 'Continue' }).click();
  // A slip in the key is caught before the passkey is asked.
  await card.getByTestId('recovery-key-typed').fill(oldKey);
  await card.getByRole('button', { name: 'Use the new key' }).click();
  await expect(card.getByText('That is not the recovery key shown. Check it and try again.')).toBeVisible();
  await card.getByTestId('recovery-key-typed').fill(newKey);
  const wayAdded = page.waitForResponse((r) => r.url().includes('/api/log/append'));
  await card.getByRole('button', { name: 'Use the new key' }).click();
  expect((await wayAdded).status()).toBe(200);
  await expect(card.getByRole('button', { name: 'Make a new recovery key' })).toBeVisible({
    timeout: 30_000,
  });

  // The old key no longer signs in; the new one signs in on a new device and opens the budget.
  const tried = await newDevice(browser, '198.51.100.23');
  await tried.goto('/budget');
  await tried.getByRole('button', { name: 'Use your recovery key' }).click();
  await tried.getByTestId('recovery-key-typed').fill(oldKey);
  await tried.getByRole('button', { name: 'Continue' }).click();
  await expect(tried.getByRole('alert')).toBeVisible();
  await tried.context().close();
  const other = await joinWithRecoveryKey(browser, '198.51.100.24', newKey);

  // ---- an edit on one device shows on the other when the person comes back to it, with no reload
  await other.goto('/settings/categories');
  await expect(other.getByText('Rent')).toBeVisible({ timeout: 30_000 });
  await page.goto('/settings/categories');
  await expect(page.getByText('Rent')).toBeVisible({ timeout: 30_000 });
  await addCategory(page, 'Climbing');
  await comeBack(other);
  await expect(other.getByText('Climbing')).toBeVisible({ timeout: 15_000 });

  // ---- the copy made again from a snapshot: the entries after this device's place are gone from the server
  // (here: the test hides the first of them once), so it rebuilds from the newest snapshot, with a banner.
  await addCategory(page, 'Kayaking');
  await addCategory(page, 'Sailing');
  let hidden = false;
  await other.context().route(/\/api\/log\?after=\d+$/, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { entries: string[] };
    if (hidden || body.entries.length < 2) return route.fulfill({ response: res, json: body });
    hidden = true;
    await route.fulfill({ response: res, json: { ...body, entries: body.entries.slice(1) } });
  });
  // The snapshot is slow to come, so the banner stays long enough to see.
  await other.context().route(/\/api\/log\/snapshots\/[^/]+\/manifest$/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await comeBack(other);
  await expect(other.getByTestId('rebuilding-banner')).toContainText('Bringing your budget up to date');
  await expect(other.getByTestId('rebuilding-banner')).toHaveCount(0, { timeout: 30_000 });
  expect(hidden).toBe(true);
  for (const name of ['Climbing', 'Kayaking', 'Sailing']) await expect(other.getByText(name)).toBeVisible();
  await other.context().unrouteAll();
  // The rebuilt copy goes on as before: an edit made there reaches the first device.
  await addCategory(other, 'Rowing');
  await comeBack(page);
  await expect(page.getByText('Rowing')).toBeVisible({ timeout: 15_000 });

  // ---- Sign out of this device: the copy saved here is deleted first, then the sign-in ends
  const before = (await savedCopy(page))!;
  expect(before.blob).toBe(true);
  expect(before.plain).toBe(false);
  await page.goto('/settings/sign-in');
  await page.getByRole('button', { name: 'Sign out…' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible({ timeout: 30_000 });
  expect(await savedCopy(page)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('ledgerline-saved-data'))).toBeNull();
  expect((await call(page, 'GET', '/api/log?after=0')).status).not.toBe(200);
  // The other device is still signed in.
  await other.reload();
  await expect(other.getByText('Rowing')).toBeVisible({ timeout: 30_000 });
  // Signing in again makes a new copy, from the newest snapshot and the log since.
  let snapshots = 0;
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/log/snapshots') snapshots++;
  });
  const verified = page.waitForResponse((r) => r.url().includes('/api/auth/login/verify'));
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  expect((await verified).status()).toBe(200);
  await expect(page.getByText('Groceries').first()).toBeVisible({ timeout: 30_000 });
  expect(snapshots).toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        const c = await savedCopy(page);
        return !!c?.blob && c.deviceId !== before.deviceId;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await page.goto('/settings/categories');
  await expect(page.getByText('Rowing')).toBeVisible({ timeout: 30_000 });
  await other.context().close();
  await page.context().close();
});
