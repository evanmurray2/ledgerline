// Shared steps for the suites through the real Worker (the passkey, signup, lock and bank configs): a device with a
// passkey, a call to the API from the page, a new account whose budget is locked and set up in the browser, a
// second device that opens it with the recovery key, and what the device keeps of it.
import { expect, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';

/** Chromium's virtual authenticator stands in for Face ID, with PRF (the key for the saved copy). */
export async function withPasskeyDevice(page: Page) {
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

/** One API call from the page, with its cookie and the app's header. */
export const call = (page: Page, method: string, path: string) =>
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

/** A new page in its own browser context with a passkey. Each has its own address: sign-in checks are counted
 * per address (AUTH_LIMITER, 20 a minute). */
export async function newDevice(browser: Browser, ip: string, options: BrowserContextOptions = {}) {
  const page = await (
    await browser.newContext({ ...options, extraHTTPHeaders: { 'cf-connecting-ip': ip } })
  ).newPage();
  await withPasskeyDevice(page);
  return page;
}

/** The owner sets up first, with the setup code: until then there is no Create account. Nothing when done. */
export async function ensureOwner(browser: Browser) {
  const owner = await newDevice(browser, '198.51.100.30');
  await owner.goto('/budget');
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
    await expect(owner.getByRole('button', { name: 'Make my recovery key' })).toBeVisible();
  }
  await owner.context().close();
}

/** The lock screen: the recovery key is made, written down and typed back, and the locked budget is sent. */
export async function lockNewBudget(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Make my recovery key' }).click();
  const key = (await page.getByTestId('recovery-key').textContent())!;
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('recovery-key-typed').fill(key);
  const started = page.waitForResponse((r) => r.url().includes('/api/start/seal'));
  await page.getByRole('button', { name: 'Lock my budget' }).click();
  expect((await started).status()).toBe(200);
  return key;
}

/**
 * A new account on a new device: its budget is locked, its first-run setup is done (no bank step), and a fresh
 * sign-in gives the app the passkey's key, so the device keeps a saved copy. Gives the page and the recovery key.
 */
export async function newLockedBudget(
  browser: Browser,
  ip: string,
  options: BrowserContextOptions = {},
): Promise<{ page: Page; key: string }> {
  await ensureOwner(browser);
  const page = await newDevice(browser, ip, options);
  await page.goto('/budget');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'Create passkey' }).click();
  const key = await lockNewBudget(page);
  await expect(page).toHaveURL(/\/welcome/, { timeout: 30_000 });
  await page.getByRole('link', { name: 'Get started' }).click();
  const setupSent = page.waitForResponse((r) => r.url().includes('/api/log/append'));
  await page.getByRole('button', { name: 'Continue' }).click();
  expect((await setupSent).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Make your categories' })).toBeVisible();
  await page.getByRole('button', { name: 'Go to my budget' }).click();
  // Each category is an entry of the log: on a busy machine the step takes more than the usual 10 seconds.
  await expect(page).toHaveURL(/\/budget/, { timeout: 30_000 });
  await expect(page.getByText('Groceries').first()).toBeVisible();
  expect((await call(page, 'POST', '/api/settings/security/sign-out')).status).toBe(200);
  const verified = page.waitForResponse((r) => r.url().includes('/api/auth/login/verify'));
  await page.goto('/budget');
  expect((await verified).status()).toBe(200);
  await expect(page.getByText('Groceries').first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await savedCopy(page))?.blob ?? false, { timeout: 15_000 }).toBe(true);
  return { page, key };
}

/** A second device opens the budget with the recovery key, and adds its own passkey to it. */
export async function joinWithRecoveryKey(browser: Browser, ip: string, key: string): Promise<Page> {
  const page = await newDevice(browser, ip);
  await page.goto('/budget');
  await page.getByRole('button', { name: 'Use your recovery key' }).click();
  await page.getByTestId('recovery-key-typed').fill(key);
  const slotAdded = page.waitForResponse((r) => r.url().includes('/api/log/append'), { timeout: 60_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  expect((await slotAdded).status()).toBe(200);
  await expect(page.getByText('Groceries').first()).toBeVisible({ timeout: 60_000 });
  return page;
}

/** Adds a category on Settings → Categories; it goes out as an entry of the log. */
export async function addCategory(page: Page, name: string) {
  const appended = page.waitForResponse((r) => r.url().includes('/api/log/append'));
  await page.getByRole('link', { name: 'Add category' }).first().click();
  await page.getByRole('dialog').getByRole('textbox').first().fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Add category' }).click();
  expect((await appended).status()).toBe(200);
  await expect(page.getByText(name)).toBeVisible();
}

/** The app is shown again after a moment in the background, as when the person comes back to it. */
export async function comeBack(page: Page) {
  for (const state of ['hidden', 'visible'])
    await page.evaluate((s) => {
      Object.defineProperty(document, 'visibilityState', { value: s, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
}

/** The copy this device keeps in IndexedDB: whether it has a saved blob, and whether any of it reads plain. */
export const savedCopy = (page: Page) =>
  page.evaluate(async () =>
    // Not opened when it isn't there: opening it would make an empty one before the app does.
    !(await indexedDB.databases()).some((d) => d.name === 'ledgerline-copy')
      ? null
      : new Promise<{ deviceId: string; blob: boolean; plain: boolean } | null>((resolve) => {
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
