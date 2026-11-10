// Sign-in edge cases with real passkeys and open sign-up on (playwright.signup.config.ts): each test makes its own
// account, so it runs after signup.spec.ts or alone.
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

const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    async ([m, p, b]) => {
      const r = await fetch(p as string, {
        method: m as string,
        headers: m === 'GET' ? {} : { 'content-type': 'application/json', 'x-ledgerline': '1' },
        body: m === 'GET' ? undefined : JSON.stringify(b ?? {}),
      });
      return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
    },
    [method, path, body] as const,
  );

/** The owner sets up once per server (signup.spec.ts may have done it already). */
async function ownerSetUp(page: Page) {
  const s = await page.request.get('/api/auth/status');
  if (!((await s.json()) as { setupOpen: boolean }).setupOpen) return;
  const ctx = await page.context().browser()!.newContext();
  const owner = await ctx.newPage();
  await withPasskeyDevice(owner);
  await owner.goto('/budget');
  await owner.getByLabel('Setup code').fill('e2e-setup-code-0123456789abcdefghijklmnop');
  await owner.getByRole('button', { name: 'Create passkey' }).click();
  await expect(owner).toHaveURL(/\/welcome/);
  await ctx.close();
}

/** A new account on this page, through first-run setup to Budget. */
async function newAccount(page: Page) {
  await ownerSetUp(page);
  await withPasskeyDevice(page);
  await page.goto('/budget');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await page.getByLabel(/I saved my recovery code/).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('link', { name: 'Get started' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Go to my budget' }).click();
  await expect(page).toHaveURL(/\/budget/);
}

test('Signed out in one tab: the other tab shows Sign in at once, not the budget', async ({
  page,
  context,
}) => {
  await newAccount(page);
  const other = await context.newPage();
  await other.goto('/activity');
  await expect(other.getByText('No transactions in November.')).toBeVisible();
  // Sign out of this device, in the first tab.
  await page.goto('/settings/sign-in');
  await page.getByRole('button', { name: 'Sign out…', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  // The other tab, untouched, shows Sign in too, and nothing from the budget.
  await expect(other.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(other.getByText('No transactions in November.')).toBeHidden();
  // Its copy is gone, not saved again: nothing is kept on this device.
  const copies = await other.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const r = indexedDB.open('ledgerline-copy');
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('copies')) return resolve(0);
          const g = db.transaction('copies').objectStore('copies').count();
          g.onsuccess = () => resolve(g.result);
        };
      }),
  );
  expect(copies).toBe(0);
});

test('Using one tab keeps the other from ending the sign-in after 10 idle minutes', async ({
  page,
  context,
}) => {
  await newAccount(page);
  await context.clock.install();
  await page.goto('/activity');
  await expect(page.getByText('No transactions in November.')).toBeVisible();
  const other = await context.newPage();
  await other.goto('/activity');
  await expect(other.getByText('No transactions in November.')).toBeVisible();
  let signOuts = 0;
  for (const p of [page, other])
    p.on('request', (r) => {
      if (r.url().endsWith('/api/settings/security/sign-out')) signOuts++;
    });
  // 12 minutes: the first tab is left alone, the other is used every 3 minutes.
  for (let i = 0; i < 4; i++) {
    await context.clock.runFor(3 * 60_000);
    await other.keyboard.press('Shift');
  }
  await expect(other.getByText('No transactions in November.')).toBeVisible();
  await expect(other.getByRole('heading', { name: 'Sign in' })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeHidden();
  expect(signOuts).toBe(0);
  expect((await api(other, 'GET', '/api/session')).status).toBe(200);
});
