// Moving a budget to its sealed log, in a real browser against the real Worker (docs/privacy.md section 8): the
// passkey makes the keys, the recovery key is typed back, the budget is frozen, sealed and read back; then the
// app lives on the log across a reload, and the way back returns the budget as it was.
import { expect, test, type Page } from '@playwright/test';

async function withPasskeyDevice(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
}

const call = (page: Page, method: string, path: string) =>
  page.evaluate(
    async ([m, p]) => {
      const r = await fetch(p!, {
        method: m,
        headers: { 'content-type': 'application/json', 'x-ledgerline': '1' },
        ...(m === 'POST' ? { body: '{}' } : {}),
      });
      return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
    },
    [method, path],
  );

test('lock a budget with the passkey and the recovery key, live on the log, and go back', async ({
  page: owner,
  browser,
}) => {
  // Three devices and two sign-ins with the recovery key or a device link: more than the usual 2 minutes.
  test.setTimeout(240_000);
  // The owner sets up first: until then there is no Create account.
  await withPasskeyDevice(owner);
  await owner.goto('/budget');
  // On a retry the same server has its owner already.
  const setup = owner.getByLabel('Setup code');
  const fresh = await Promise.race([
    setup.waitFor({ timeout: 15_000 }).then(() => true),
    owner
      .getByRole('button', { name: 'Create account' })
      .waitFor({ timeout: 15_000 })
      .then(() => false),
  ]).catch(() => false);
  if (fresh) {
    await setup.fill('e2e-setup-code-0123456789abcdefghijklmnop');
    await owner.getByRole('button', { name: 'Create passkey' }).click();
    await expect(owner).toHaveURL(/\/welcome/);
  }

  // A new account: its first-run setup has no bank step, so its budget is ready in three taps.
  const page = await (await browser.newContext()).newPage();
  await withPasskeyDevice(page);
  await page.goto('/budget');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await page.getByLabel(/I saved my recovery code/).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/welcome/);
  await page.getByRole('link', { name: 'Get started' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Make your categories' })).toBeVisible();
  await page.getByRole('button', { name: 'Go to my budget' }).click();
  await expect(page).toHaveURL(/\/budget/);
  // A sign-in gives the app the passkey's key for the copy on this device.
  expect((await call(page, 'POST', '/api/settings/security/sign-out')).status).toBe(200);
  const verified = page.waitForResponse((r) => r.url().includes('/api/auth/login/verify'));
  await page.goto('/budget');
  expect((await verified).status()).toBe(200);
  // The copy is made and saved before the test goes on (a reload in the middle would leave it in memory only).
  await expect(page.getByText('Groceries')).toBeVisible();

  // ---- Settings → Privacy: the move
  await page.goto('/settings/privacy');
  await page.getByRole('button', { name: 'Lock my budget' }).click();
  const key = (await page.getByTestId('recovery-key').textContent())!;
  expect(key.length).toBeGreaterThan(20);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('recovery-key-typed').fill('not the key');
  await page.getByRole('button', { name: 'Lock my budget' }).click();
  await expect(page.getByText('That is not the recovery key shown.')).toBeVisible();
  await page.getByTestId('recovery-key-typed').fill(key);
  await page.getByRole('button', { name: 'Lock my budget' }).click();
  await expect(page.getByText('Your budget is locked.')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/you can go back to how it was/)).toBeVisible();
  // The server holds the log now, and the old routes are closed.
  expect((await call(page, 'GET', '/api/log?after=0')).status).toBe(200);
  expect((await call(page, 'GET', '/api/sync?since=0&limit=5')).status).not.toBe(200);

  // ---- the app lives on the log: the budget shows, and after a reload it opens again from the copy
  await page.goto('/budget');
  await expect(page.getByText('Groceries')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Groceries')).toBeVisible({ timeout: 30_000 });
  // ---- a change is made on the device and goes out as an entry of the log
  await page.goto('/settings/categories');
  // The screen shows once the copy is open; a change made before that is refused for a locked budget.
  await expect(page.getByText('Rent')).toBeVisible({ timeout: 30_000 });
  const appended = page.waitForResponse((r) => r.url().includes('/api/log/append'));
  await page.getByRole('link', { name: 'Add category' }).first().click();
  await page.getByRole('dialog').getByRole('textbox').first().fill('Climbing');
  await page.getByRole('dialog').getByRole('button', { name: 'Add category' }).click();
  expect((await appended).status()).toBe(200);
  await page.reload();
  await expect(page.getByText('Climbing')).toBeVisible({ timeout: 30_000 });
  // The banks screen opens (this budget has no bank).
  await page.goto('/settings/connections');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/move-6.png' });
  // Opened from the keys held for a refresh and the place kept with the copy: no snapshot was read again.

  // ---- a new sign-in: the passkey gives the budget's secret in the same prompt
  expect((await call(page, 'POST', '/api/settings/security/sign-out')).status).toBe(200);
  const again = page.waitForResponse((r) => r.url().includes('/api/auth/login/verify'));
  await page.goto('/budget');
  expect((await again).status()).toBe(200);
  await expect(page.getByText('Groceries')).toBeVisible({ timeout: 30_000 });

  // ---- the recovery key: it signs in from now on (the move set its public half, signed with the budget's key)
  expect((await call(page, 'GET', '/api/settings/security/recovery-key')).json).toMatchObject({ set: true });
  // A new device with a new passkey: the recovery key signs in, opens the budget, and adds the passkey to it.
  // Its own address: sign-in checks are counted per address (AUTH_LIMITER), and the owner's device goes on below.
  const other = await (
    await browser.newContext({ extraHTTPHeaders: { 'cf-connecting-ip': '198.51.100.7' } })
  ).newPage();
  await withPasskeyDevice(other);
  await other.goto('/budget');
  await other.getByRole('button', { name: 'Use your recovery key' }).click();
  await other.getByTestId('recovery-key-typed').fill(key);
  const slotAdded = other.waitForResponse((r) => r.url().includes('/api/log/append'), { timeout: 60_000 });
  await other.getByRole('button', { name: 'Continue' }).click();
  expect((await slotAdded).status()).toBe(200);
  await expect(other.getByText('Groceries')).toBeVisible({ timeout: 60_000 });
  // After a reload, the new passkey alone opens it: this device keeps no saved copy and no keys, so the passkey
  // is asked for the budget's secret, and the recovery key is not asked again.
  await other.reload();
  await expect(other.getByText('Groceries')).toBeVisible({ timeout: 60_000 });
  await expect(other.getByText('Open your budget with your recovery key')).toHaveCount(0);
  // The recovery key signed in here, and this device added its passkey itself: it tells itself of neither.
  await other.waitForTimeout(3000);
  await expect(other.getByText(/Your recovery key signed in on/)).toHaveCount(0);
  await expect(other.getByText(/A way in was added on/)).toHaveCount(0);

  // ---- two devices on one log: a change made on the new device (its flush) reaches the owner's (its sync)
  await other.goto('/settings/categories');
  await expect(other.getByText('Climbing')).toBeVisible({ timeout: 30_000 });
  const sent = other.waitForResponse((r) => r.url().includes('/api/log/append'));
  await other.getByRole('link', { name: 'Add category' }).first().click();
  await other.getByRole('dialog').getByRole('textbox').first().fill('Kayaking');
  await other.getByRole('dialog').getByRole('button', { name: 'Add category' }).click();
  expect((await sent).status()).toBe(200);
  await other.close();
  // The owner's device reads the log when it opens: the other device's change is there.
  await page.goto('/settings/categories');
  await page.reload();
  await expect(page.getByText('Kayaking')).toBeVisible({ timeout: 30_000 });
  // A change made here goes on top of the other device's entry.
  const onTop = page.waitForResponse((r) => r.url().includes('/api/log/append'));
  await page.getByRole('link', { name: 'Add category' }).first().click();
  await page.getByRole('dialog').getByRole('textbox').first().fill('Sailing');
  await page.getByRole('dialog').getByRole('button', { name: 'Add category' }).click();
  expect((await onTop).status()).toBe(200);
  await expect(page.getByText('Sailing')).toBeVisible();

  // ---- the owner's device tells of both when it opens (docs/privacy.md 5.8), and each is dismissed here only.
  // Its own address from here: the checks each start makes are counted per address (AUTH_LIMITER).
  await page.setExtraHTTPHeaders({ 'cf-connecting-ip': '198.51.100.8' });
  await page.goto('/budget');
  const notices = page.getByTestId('sealed-notices');
  const added = notices.getByRole('alert').filter({ hasText: 'A way in was added on' });
  await expect(added).toBeVisible({ timeout: 30_000 });
  await expect(notices.getByText(/Your recovery key signed in on/)).toBeVisible();
  await added.getByRole('button', { name: 'This was me' }).click();
  await expect(added).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('sealed-notices').getByText(/Your recovery key signed in on/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/A way in was added on/)).toHaveCount(0);

  // ---- add a device with its own passkey (docs/privacy-keys.md section 10): the link signs it in, then both
  // devices show six digits, the person taps They match on both, and the budget key crosses, sealed to it.
  await page.goto('/settings/sign-in');
  await page.getByRole('button', { name: 'Add a device' }).click();
  const link = await page.getByLabel('Device link').inputValue();
  const addedPage = await (
    await browser.newContext({ extraHTTPHeaders: { 'cf-connecting-ip': '198.51.100.9' } })
  ).newPage();
  await withPasskeyDevice(addedPage);
  await addedPage.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await addedPage.getByRole('button', { name: 'Create passkey' }).click();
  await addedPage.getByRole('button', { name: 'Open Ledgerline' }).click();
  // Its passkey is no way in yet: the screen offers the add, and the recovery key instead.
  await expect(addedPage.getByRole('button', { name: 'Type your recovery key instead' })).toBeVisible({
    timeout: 60_000,
  });
  const codeHere = addedPage.getByTestId('add-code');
  await expect(codeHere).toHaveText(/^\d{6}$/, { timeout: 30_000 });
  await expect(page.getByTestId('add-code')).toHaveText((await codeHere.textContent())!, { timeout: 30_000 });
  await page.getByRole('button', { name: 'They match' }).click();
  const joinedSlot = addedPage.waitForResponse((r) => r.url().includes('/api/log/append'), {
    timeout: 60_000,
  });
  await addedPage.getByRole('button', { name: 'They match' }).click();
  expect((await joinedSlot).status()).toBe(200);
  await expect(addedPage.getByText('Groceries')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('The new device can open your budget')).toBeVisible({ timeout: 30_000 });
  // After a reload its own passkey alone opens the budget.
  await addedPage.reload();
  await expect(addedPage.getByText('Groceries')).toBeVisible({ timeout: 60_000 });
  await expect(addedPage.getByRole('button', { name: 'Type your recovery key instead' })).toHaveCount(0);
  await addedPage.close();

  // ---- the way back (in the app: one more reload so soon would run into the sign-in checks' limit per minute)
  await page.getByRole('link', { name: /^Privacy/ }).click();
  await page.getByRole('button', { name: 'Go back to how it was…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByRole('button', { name: 'Lock my budget' })).toBeVisible({ timeout: 30_000 });
  expect((await call(page, 'GET', '/api/log?after=0')).status).toBe(404);
  await page.goto('/budget');
  await expect(page.getByText('Groceries')).toBeVisible();
});
