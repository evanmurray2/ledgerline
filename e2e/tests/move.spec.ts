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
  // The owner sets up first: until then there is no Create account.
  await withPasskeyDevice(owner);
  await owner.goto('/budget');
  await owner.getByLabel('Setup code').fill('e2e-setup-code-0123456789abcdefghijklmnop');
  await owner.getByRole('button', { name: 'Create passkey' }).click();
  await expect(owner).toHaveURL(/\/welcome/);

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

  // ---- the way back
  await page.goto('/settings/privacy');
  await page.getByRole('button', { name: 'Go back to how it was…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByRole('button', { name: 'Lock my budget' })).toBeVisible({ timeout: 30_000 });
  expect((await call(page, 'GET', '/api/log?after=0')).status).toBe(404);
  await page.goto('/budget');
  await expect(page.getByText('Groceries')).toBeVisible();
});
