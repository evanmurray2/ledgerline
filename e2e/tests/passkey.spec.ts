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
      hasPrf: true,
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

test('set up a passkey, sign out, sign in, add a second device, and keep an encrypted copy', async ({
  page,
  browser,
  context,
}) => {
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

  // In a browser tab nothing is saved on the device (D-44): the session ending shows sign-in.
  await page.goto('/budget');
  expect(await page.evaluate(() => localStorage.getItem('ledgerline-saved-data'))).toBeNull();
  expect((await post(page, '/api/settings/security/sign-out')).status).toBe(200);
  await page.goto('/budget');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
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

  // The installed Home Screen app (D-44; Safari sets navigator.standalone there) keeps an encrypted copy. Signing
  // in there gets the passkey's PRF output in the same prompt.
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await post(page, '/api/settings/security/sign-out');
  await page.goto('/budget');
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page).toHaveURL(/\/welcome/);

  // One device with a copy, saved encrypted: nothing readable in it.
  const copy = async () =>
    page.evaluate(
      () =>
        new Promise<{ deviceId: string; blob: boolean; plain: boolean } | null>((resolve) => {
          const r = indexedDB.open('ledgerline-copy');
          r.onsuccess = () => {
            const db = r.result;
            if (!db.objectStoreNames.contains('copies')) return resolve(null);
            const g = db.transaction('copies').objectStore('copies').getAll();
            g.onsuccess = () => {
              const rec = g.result[0] as { deviceId: string; blob: { data: ArrayBuffer } | null } | undefined;
              if (!rec) return resolve(null);
              const text = rec.blob ? new TextDecoder('latin1').decode(rec.blob.data) : '';
              resolve({
                deviceId: rec.deviceId,
                blob: !!rec.blob,
                plain: /CREATE TABLE|SQLite format/.test(text),
              });
            };
          };
        }),
    );
  await expect.poll(async () => (await copy())?.blob ?? false, { timeout: 15_000 }).toBe(true);
  const first = (await copy())!;
  expect(first.plain).toBe(false);

  // No signal: Face ID opens the copy on its own.
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready).active);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ledgerline is locked' })).toBeVisible();
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('heading', { name: 'Ledgerline is locked' })).toBeHidden();
  await context.setOffline(false);

  // Turned off from Settings → Sign-in (here, the API): the next sign-in can't open it, so it's replaced.
  await page.reload();
  const rev = await post(page, `/api/settings/security/devices/${first.deviceId}/revoke`);
  expect(rev.status).toBe(200);
  await post(page, '/api/settings/security/sign-out');
  await page.reload();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page).toHaveURL(/\/welcome/);
  await expect.poll(async () => (await copy())?.deviceId, { timeout: 15_000 }).not.toBe(first.deviceId);
});
