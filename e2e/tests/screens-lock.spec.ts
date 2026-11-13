// A locked budget's screens through the real Worker (D-102), each on a new account made in the browser: Accounts
// and Banks of a budget with no bank on a phone (Sync and pull to refresh ask the Worker's Fetch now), then the
// copy opened with no signal; and two devices on one log: an edit on one shows on the other when it comes back to
// the app, the recovery key's "Set up sign-in with it" and a new recovery key from Settings → Sign-in, the copy made
// again from a snapshot (the rebuild banner), Sign out deleting the copy, and the "different history" screen.
// Runs after lock.spec.ts, on the same Worker (playwright.lock.config.ts).
import { readFileSync } from 'node:fs';
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

  // ---- No signal: the passkey alone opens the locked budget's copy, in the real engine (openWithoutSignal), with
  // the keys from the log's public entries kept with the copy.
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'You’re offline' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Open with passkey' }).tap();
  await expect(page.getByRole('heading', { name: 'You’re offline' })).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('net-worth')).toHaveText('$0.00', { timeout: 30_000 });
  await page.getByRole('navigation').getByRole('link', { name: 'Budget' }).tap();
  await expect(page.getByText('Groceries').first()).toBeVisible({ timeout: 30_000 });
  await page.context().setOffline(false);
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

  // A budget locked before the lock set the key's sign-in (the owner's) shows "Set up sign-in with it": here the
  // test answers once that it isn't set, and the step sends the key's public half, signed, to the real Worker.
  let unset = true;
  await page.route('**/api/settings/security/recovery-key', async (route) => {
    if (route.request().method() !== 'GET' || !unset) return route.fallback();
    unset = false;
    await route.fulfill({ json: { set: false, setAt: null } });
  });
  await page.reload();
  await expect(card.getByText('Your recovery key can’t sign in yet.', { exact: false })).toBeVisible({
    timeout: 30_000,
  });
  await card.getByRole('button', { name: 'Set up sign-in with it' }).click();
  await card.getByTestId('recovery-key-typed').fill(oldKey);
  const signInSet = page.waitForResponse(
    (r) => r.url().endsWith('/api/settings/security/recovery-key') && r.request().method() === 'POST',
  );
  await card.getByRole('button', { name: 'Set up', exact: true }).click();
  const setRes = await signInSet;
  expect(setRes.status()).toBe(200);
  // It was signed with the budget's key (docs/privacy-keys.md 11).
  expect(setRes.request().headers()['x-ledgerline-signature']).toBeTruthy();
  await expect(page.getByText('Your recovery key signs in now')).toBeVisible();
  await expect(
    card.getByText('It opens your budget and signs you in if you lose every passkey.'),
  ).toBeVisible({ timeout: 30_000 });
  await page.unrouteAll();

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

  // ---- Settings → Backup: the full backup is made in the browser from its copy, after the passkey is asked.
  // Without a lock it is the copy's SQLite file; with the recovery key, the same bytes sealed (docs/privacy.md 5.8).
  await page.goto('/settings/data');
  const backup = page.getByTestId('device-backup');
  await expect(backup).toBeVisible({ timeout: 30_000 });
  await backup.getByRole('checkbox').check();
  const plainSaved = page.waitForEvent('download');
  await backup.getByRole('button', { name: 'Download' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Use passkey' }).click();
  const plainFile = await plainSaved;
  expect(plainFile.suggestedFilename()).toMatch(/^ledgerline-backup-\d{4}-\d{2}-\d{2}\.sqlite$/);
  const plain = readFileSync((await plainFile.path())!);
  expect(plain.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0');
  expect(plain.includes('Climbing')).toBe(true);
  await expect(backup.getByText('Saved. Keep it somewhere safe.')).toBeVisible();
  await backup.getByRole('checkbox').uncheck();
  await backup.getByTestId('backup-recovery-key').fill(newKey);
  const lockedSaved = page.waitForEvent('download');
  await backup.getByRole('button', { name: 'Download' }).click();
  // Each backup asks for the passkey.
  await page.getByRole('dialog').getByRole('button', { name: 'Use passkey' }).click();
  const lockedFile = await lockedSaved;
  expect(lockedFile.suggestedFilename()).toMatch(/^ledgerline-backup-\d{4}-\d{2}-\d{2}\.locked$/);
  const locked = readFileSync((await lockedFile.path())!);
  const magic = 'LEDGERLINE-BACKUP\n1\n';
  expect(locked.subarray(0, magic.length).toString('latin1')).toBe(magic);
  expect(locked.includes('SQLite format')).toBe(false);
  expect(locked.includes('Climbing')).toBe(false);
  // The whole copy, sealed (not a part of it).
  expect(locked.length).toBeGreaterThan(plain.length * 0.9);
  await expect(backup.getByText('Saved. Keep it somewhere safe.')).toBeVisible();
  await page.goto('/settings/categories');
  await expect(page.getByText('Climbing')).toBeVisible({ timeout: 30_000 });

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

  // ---- A server that shows a device another history: the next entry doesn't follow the one the device has
  // (here: the test changes a byte of its prevHash on the way). The device stops, says so, and changes nothing.
  await addCategory(page, 'Surfing');
  let forked = false;
  await other.context().route(/\/api\/log\?after=\d+$/, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { entries: string[] };
    if (forked || body.entries.length === 0) return route.fulfill({ response: res, json: body });
    forked = true;
    const bytes = Uint8Array.from(atob(body.entries[0]!), (c) => c.charCodeAt(0));
    // The header's length (4 bytes), then 'LLE1', the kind, the budget id (4 + 26) and the number (8): prevHash.
    bytes[47] = bytes[47]! ^ 0xff;
    const changed = btoa(String.fromCharCode(...bytes));
    await route.fulfill({ response: res, json: { ...body, entries: [changed, ...body.entries.slice(1)] } });
  });
  await comeBack(other);
  await expect(other.getByTestId('forked')).toContainText(
    'The server showed this device a different history. Nothing was changed.',
    { timeout: 30_000 },
  );
  expect(forked).toBe(true);
  await other.context().close();
  await page.context().close();
});
