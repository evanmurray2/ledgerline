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

/** The Sign in screen asks for the passkey by itself: `open` shows it, and the sign-in goes through with no tap. */
async function signsInByItself(page: Page, open: () => Promise<unknown>) {
  const verified = page.waitForResponse((r) => r.url().includes('/api/auth/login/verify'));
  await open();
  expect((await verified).status()).toBe(200);
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

  // Right after setup the passkey hasn't given the app a key yet, so nothing is saved until the next sign-in.
  await page.goto('/budget');
  expect(await page.evaluate(() => localStorage.getItem('ledgerline-saved-data'))).toBeNull();
  expect((await post(page, '/api/settings/security/sign-out')).status).toBe(200);
  await signsInByItself(page, () => page.goto('/budget'));
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
  await again.close();
  // Clearing that page's cookies signed the second device out too: it signs in again.
  await signsInByItself(phone, () => phone.goto('/budget'));
  await expect(phone).toHaveURL(/\/welcome/);

  // A computer keeps an encrypted copy too, like a phone (D-53). Signing in gets the passkey's PRF output in the same
  // prompt.
  await post(page, '/api/settings/security/sign-out');
  await signsInByItself(page, () => page.goto('/budget'));
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
  await expect(page.getByRole('heading', { name: 'No signal' })).toBeVisible();
  await page.getByRole('button', { name: 'Open with Face ID' }).click();
  await expect(page.getByRole('heading', { name: 'No signal' })).toBeHidden();
  // The budget opens from the copy (here, first-run setup), not "Couldn't reach Ledgerline".
  await expect(page).toHaveURL(/\/welcome/);
  await expect(page.getByRole('heading', { name: 'Ledgerline', exact: true })).toBeVisible();
  await expect(page.getByText('Couldn’t reach Ledgerline')).toBeHidden();
  await context.setOffline(false);

  // Locking ends the sign-in and keeps the copy: opening again downloads only what changed, not everything.
  await page.reload();
  await expect(page).toHaveURL(/\/welcome/);
  await post(page, '/api/settings/security/sign-out');
  const since: number[] = [];
  const why: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname !== '/api/sync') return;
    since.push(Number(u.searchParams.get('since')));
    if (u.searchParams.get('why')) why.push(u.searchParams.get('why')!);
  });
  await signsInByItself(page, () => page.reload());
  await expect(page).toHaveURL(/\/welcome/);
  await expect.poll(() => since.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(since[0]).toBeGreaterThan(0);
  expect((await copy())?.deviceId).toBe(first.deviceId);

  // A refresh while it's open and in use doesn't lock it: no passkey prompt, no new sign-in.
  let signIns = 0;
  const countSignIns = (r: { url(): string }) => {
    if (r.url().includes('/api/auth/login/verify')) signIns++;
  };
  page.on('request', countSignIns);
  const before = since.length;
  await page.reload();
  await expect(page).toHaveURL(/\/welcome/);
  await expect(page.getByRole('heading', { name: 'Ledgerline', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeHidden();
  await expect.poll(() => since.length, { timeout: 15_000 }).toBeGreaterThan(before);
  expect(since.at(-1)).toBeGreaterThan(0);
  expect(signIns).toBe(0);

  // 10 minutes in the background: the sign-in ends and the app shows Sign in, every time (it used to race a Lock
  // screen). That one passkey prompt opens the saved copy too, downloading only what changed.
  await page.clock.install();
  await page.reload();
  await expect(page).toHaveURL(/\/welcome/);
  await expect(page.getByRole('heading', { name: 'Ledgerline', exact: true })).toBeVisible();
  const setVisibility = (v: 'hidden' | 'visible') =>
    page.evaluate((state) => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, v);
  await setVisibility('hidden');
  await page.clock.setSystemTime(Date.now() + 11 * 60_000);
  const syncsBefore = since.length;
  await signsInByItself(page, () => setVisibility('visible'));
  await expect(page).toHaveURL(/\/welcome/);
  await expect(page.getByRole('heading', { name: 'Ledgerline', exact: true })).toBeVisible();
  await expect.poll(() => since.length, { timeout: 15_000 }).toBeGreaterThan(syncsBefore);
  expect(since.at(-1)).toBeGreaterThan(0);
  expect(signIns).toBe(1);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeHidden();
  page.off('request', countSignIns);

  // Signed out again, then signed out from the other device (Settings → Sign-in, here the API): a signed-out
  // device isn't listed, but "Sign out other devices" turns its copy off, and it deletes the copy as soon as it
  // opens, before anyone signs in.
  await post(page, '/api/settings/security/sign-out');
  const list = await phone.evaluate(async () => {
    const r = await fetch('/api/settings/security');
    return (await r.json()) as { otherSessions: number; signIns: { name: string; current: boolean }[] };
  });
  expect(list.signIns.map((x) => x.name)).not.toContain('Linux computer');
  expect(list.otherSessions).toBeGreaterThan(list.signIns.filter((x) => !x.current).length);
  const out = await phone.evaluate(async () => {
    const r = await fetch('/api/settings/security/sign-out-others', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ledgerline': '1' },
      body: '{}',
    });
    return r.status;
  });
  expect(out).toBe(200);
  await other.close();
  // After "Sign out of this device" the Sign in screen waits for a tap; that keeps Face ID from opening at once.
  await page.evaluate(() => sessionStorage.setItem('ledgerline-signed-out-here', '1'));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeEnabled();
  await expect.poll(async () => await copy(), { timeout: 15_000 }).toBeNull();

  // Signing in again starts a new copy.
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page).toHaveURL(/\/welcome/);
  await expect
    .poll(async () => (await copy())?.blob && (await copy())?.deviceId !== first.deviceId, {
      timeout: 15_000,
    })
    .toBe(true);
  // Only that fresh start downloaded everything, and it said why (the server logs it).
  expect(why).toEqual(['first']);
});
