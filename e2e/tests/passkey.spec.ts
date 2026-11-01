// First-time setup, sign-out, sign-in and adding a second device, with Chromium's virtual passkey authenticator.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

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
    },
  });
  return cdp;
}

const post = (page: Page, path: string) =>
  page.evaluate(async (p) => {
    const r = await fetch(p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ledgerline': '1' },
      body: '{}',
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  }, path);

test('set up a passkey, sign out, sign in, and add a second device', async ({ page, browser }) => {
  await withPasskeyDevice(page);
  await page.goto('/budget');
  await expect(page.getByRole('heading', { name: 'Set up sign-in' })).toBeVisible();

  await page.getByLabel('Setup code').fill('wrong-code-that-is-long-enough-to-check');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page.getByRole('alert')).toContainText('isn’t valid');

  await page.getByLabel('Setup code').fill('e2e-setup-code-0123456789abcdefghijklmnop');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  // Signed in: a new budget starts at first-run setup.
  await expect(page).toHaveURL(/\/welcome/);

  // The production app saves its data on the device; signing out (here, the session ending) clears it.
  await page.goto('/budget');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ledgerline-saved-data'))).not.toBeNull();
  expect((await post(page, '/api/settings/security/sign-out')).status).toBe(200);
  await page.goto('/budget');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ledgerline-saved-data'))).toBeNull();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page).toHaveURL(/\/welcome/);

  // A second device: a link from this one, opened in a separate browser with its own authenticator.
  const link = await post(page, '/api/settings/security/device-link');
  expect(link.status).toBe(200);
  const other: BrowserContext = await browser.newContext();
  const phone = await other.newPage();
  await withPasskeyDevice(phone);
  await phone.goto(String(link.json.url));
  await expect(phone.getByRole('heading', { name: 'Add this device' })).toBeVisible();
  await phone.getByRole('button', { name: 'Create passkey' }).click();
  await expect(phone.getByRole('heading', { name: 'This device is set up' })).toBeVisible();

  // The link worked once.
  const again = await other.newPage();
  await withPasskeyDevice(again);
  await again.context().clearCookies();
  await again.goto(String(link.json.url));
  await again.getByRole('button', { name: 'Create passkey' }).click();
  await expect(again.getByRole('alert')).toContainText('isn’t valid');
  await other.close();
});
