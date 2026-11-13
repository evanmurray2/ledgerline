// A new budget, locked from its first moment (D-102), in a real browser against the real Worker: the passkey
// makes the keys, the recovery key is typed back, the first entry and snapshot are sent and read back; then the
// first-run setup and every change go out as entries of the log, the app lives on the log across a reload, the
// recovery key signs in on a new device, and two devices share the log. Then, on a budget of its own, a device is
// added.
import { expect, test, type Page } from '@playwright/test';
import { call, newLockedBudget, newDevice, withPasskeyDevice } from './lock-helpers';

/** Counts this page's reads of the log's public entries (GET /api/log/public): the notices are made from them. */
function publicReads(page: Page) {
  const n = { started: 0, done: 0 };
  const isRead = (url: string) => new URL(url).pathname === '/api/log/public';
  page.on('request', (r) => void (isRead(r.url()) && n.started++));
  const end = (r: { url(): string }) => void (isRead(r.url()) && n.done++);
  page.on('requestfinished', end);
  page.on('requestfailed', end);
  return n;
}

test('a new budget is locked with the passkey and the recovery key, and lives on the log', async ({
  page: owner,
  browser,
}) => {
  // Two devices and a sign-in with the recovery key: more than the usual 2 minutes.
  test.setTimeout(180_000);
  const page = await (await browser.newContext()).newPage();
  let key = '';

  await test.step('the owner sets up first: until then there is no Create account', async () => {
    await withPasskeyDevice(owner);
    // The app is served with its security headers: no outside host at all (docs/privacy.md 5.7).
    const res = await owner.goto('/budget');
    const csp = res?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('https:');
    expect(res?.headers()['x-frame-options']).toBe('DENY');
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
      // A new budget: it is locked before anything else.
      await expect(owner.getByRole('button', { name: 'Make my recovery key' })).toBeVisible();
    }
  });

  await test.step('the lock, before anything else: the budget key and the recovery key are made here', async () => {
    // A new account: its first-run setup has no bank step, so its budget is ready in three taps.
    await withPasskeyDevice(page);
    await page.goto('/budget');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await page.getByRole('button', { name: 'Make my recovery key' }).click();
    key = (await page.getByTestId('recovery-key').textContent())!;
    expect(key.length).toBeGreaterThan(20);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByTestId('recovery-key-typed').fill('not the key');
    await page.getByRole('button', { name: 'Lock my budget' }).click();
    await expect(page.getByText('That is not the recovery key shown.')).toBeVisible();
    await page.getByTestId('recovery-key-typed').fill(key);
    const started = page.waitForResponse((r) => r.url().includes('/api/start/seal'));
    await page.getByRole('button', { name: 'Lock my budget' }).click();
    expect((await started).status()).toBe(200);
    // The server holds the log now, and the budget is locked: no old route reads it.
    expect((await call(page, 'GET', '/api/log?after=0')).status).toBe(200);
    expect((await call(page, 'GET', '/api/sync?since=0&limit=5')).status).not.toBe(200);
  });

  await test.step('first-run setup is made on the device and goes out on the log', async () => {
    await expect(page).toHaveURL(/\/welcome/, { timeout: 30_000 });
    await page.getByRole('link', { name: 'Get started' }).click();
    const setupSent = page.waitForResponse((r) => r.url().includes('/api/log/append'));
    await page.getByRole('button', { name: 'Continue' }).click();
    expect((await setupSent).status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Make your categories' })).toBeVisible();
    await page.getByRole('button', { name: 'Go to my budget' }).click();
    await expect(page).toHaveURL(/\/budget/);
    await expect(page.getByText('Groceries')).toBeVisible();
    // A sign-in gives the app the passkey's key for the copy on this device.
    expect((await call(page, 'POST', '/api/settings/security/sign-out')).status).toBe(200);
    const verified = page.waitForResponse((r) => r.url().includes('/api/auth/login/verify'));
    await page.goto('/budget');
    expect((await verified).status()).toBe(200);
    // The copy is made and saved before the test goes on (a reload in the middle would leave it in memory only).
    await expect(page.getByText('Groceries')).toBeVisible({ timeout: 30_000 });
  });

  await test.step('the app lives on the log: it opens again from the copy, and a change goes out', async () => {
    await page.goto('/budget');
    await expect(page.getByText('Groceries')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Groceries')).toBeVisible({ timeout: 30_000 });
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
    // The banks screen opens (this budget has no bank): its list came from the Worker.
    await page.goto('/settings/connections');
    await expect(page.getByText('Test mode: test banks only.')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: 'test-results/lock-6.png' });
  });

  await test.step('a new sign-in: the passkey gives the budget’s secret in the same prompt', async () => {
    expect((await call(page, 'POST', '/api/settings/security/sign-out')).status).toBe(200);
    const again = page.waitForResponse((r) => r.url().includes('/api/auth/login/verify'));
    await page.goto('/budget');
    expect((await again).status()).toBe(200);
    await expect(page.getByText('Groceries')).toBeVisible({ timeout: 30_000 });
  });

  // A new device with a new passkey. Its own address: sign-in checks are counted per address (AUTH_LIMITER), and
  // the owner's device goes on below.
  const other = await newDevice(browser, '198.51.100.7');
  await test.step('the recovery key signs in on a new device and adds its passkey', async () => {
    // It signs in from now on (the lock set its public half, signed with the budget's key).
    expect((await call(page, 'GET', '/api/settings/security/recovery-key')).json).toMatchObject({
      set: true,
    });
    await other.goto('/budget');
    await other.getByRole('button', { name: 'Use your recovery key' }).click();
    await other.getByTestId('recovery-key-typed').fill(key);
    const slotAdded = other.waitForResponse((r) => r.url().includes('/api/log/append'), { timeout: 60_000 });
    await other.getByRole('button', { name: 'Continue' }).click();
    expect((await slotAdded).status()).toBe(200);
    await expect(other.getByText('Groceries')).toBeVisible({ timeout: 60_000 });
    // After a reload, the new passkey alone opens it: this device keeps no saved copy and no keys, so the passkey
    // is asked for the budget's secret, and the recovery key is not asked again.
    const reads = publicReads(other);
    await other.reload();
    await expect(other.getByText('Groceries')).toBeVisible({ timeout: 60_000 });
    await expect(other.getByText('Open your budget with your recovery key')).toHaveCount(0);
    // The recovery key signed in here, and this device added its passkey itself: it tells itself of neither. The
    // notices are made from the log's public entries: once the device's reads of them (the open's and the
    // notices' own) are back, a notice would show now.
    await expect.poll(() => reads.done >= 2 && reads.done === reads.started, { timeout: 30_000 }).toBe(true);
    await expect(other.getByText(/Your recovery key signed in on/)).toHaveCount(0);
    await expect(other.getByText(/A way in was added on/)).toHaveCount(0);
  });

  await test.step('two devices on one log: a change on the new device reaches the owner’s', async () => {
    await other.goto('/settings/categories');
    await expect(other.getByText('Climbing')).toBeVisible({ timeout: 30_000 });
    const sent = other.waitForResponse((r) => r.url().includes('/api/log/append'));
    await other.getByRole('link', { name: 'Add category' }).first().click();
    await other.getByRole('dialog').getByRole('textbox').first().fill('Kayaking');
    await other.getByRole('dialog').getByRole('button', { name: 'Add category' }).click();
    expect((await sent).status()).toBe(200);
    // Still no notice of its own ways in, on this screen too, long after the notices were read.
    await expect(other.getByText(/Your recovery key signed in on|A way in was added on/)).toHaveCount(0);
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
  });

  await test.step('the owner’s device tells of both (docs/privacy.md 5.8), each dismissed here only', async () => {
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
  });
});

test('a device is added with its own passkey: six digits match on both, and the budget key crosses', async ({
  browser,
}) => {
  // A new locked budget, then a second device that signs in with a link and opens it.
  test.setTimeout(180_000);
  const { page } = await test.step('a new locked budget on its own account', () =>
    newLockedBudget(browser, '198.51.100.25'));
  // docs/privacy-keys.md section 10: the link signs it in, then both devices show six digits, the person taps
  // They match on both, and the budget key crosses, sealed to it.
  const addedPage = await newDevice(browser, '198.51.100.26');
  await test.step('the device link signs the new device in; its passkey is no way in yet', async () => {
    await page.goto('/settings/sign-in');
    await page.getByRole('button', { name: 'Add a device' }).click();
    const link = await page.getByLabel('Device link').inputValue();
    await addedPage.goto(link.replace(/^https?:\/\/[^/]+/, ''));
    await addedPage.getByRole('button', { name: 'Create passkey' }).click();
    await addedPage.getByRole('button', { name: 'Open Ledgerline' }).click();
    // The screen offers the add, and the recovery key instead.
    await expect(addedPage.getByRole('button', { name: 'Type your recovery key instead' })).toBeVisible({
      timeout: 60_000,
    });
  });

  await test.step('both devices show the same six digits; They match on both sends the key', async () => {
    const codeHere = addedPage.getByTestId('add-code');
    await expect(codeHere).toHaveText(/^\d{6}$/, { timeout: 30_000 });
    await expect(page.getByTestId('add-code')).toHaveText((await codeHere.textContent())!, {
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'They match' }).click();
    const joinedSlot = addedPage.waitForResponse((r) => r.url().includes('/api/log/append'), {
      timeout: 60_000,
    });
    await addedPage.getByRole('button', { name: 'They match' }).click();
    expect((await joinedSlot).status()).toBe(200);
    await expect(addedPage.getByText('Groceries')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('The new device can open your budget')).toBeVisible({ timeout: 30_000 });
  });

  await test.step('after a reload its own passkey alone opens the budget', async () => {
    await addedPage.reload();
    await expect(addedPage.getByText('Groceries')).toBeVisible({ timeout: 60_000 });
    await expect(addedPage.getByRole('button', { name: 'Type your recovery key instead' })).toHaveCount(0);
  });
  await addedPage.close();
});
