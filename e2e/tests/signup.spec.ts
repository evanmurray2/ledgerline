// Open sign-up with the switch on (D-75; playwright.signup.config.ts), with Chromium's virtual passkey
// authenticator: the owner sets up, a new user creates an account and locks its budget, then recovers on another
// device with the recovery key.
import { expect, test, type Page } from '@playwright/test';
import { lockNewBudget, withPasskeyDevice } from './lock-helpers';

/** The robot check's address (e2e/check-server.ts): the app's port plus 1000, on 127.0.0.1. */
const CHECK_URL = `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 8799) + 1000}`;

const session = (page: Page) =>
  page.evaluate(async () => {
    const r = await fetch('/api/session', { headers: { 'x-ledgerline-sealed': '1' } });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  });

test('create an account, lock its budget, and recover on another device with the recovery key', async ({
  page,
  browser,
}) => {
  // The owner sets up first: until then there is no Create account.
  await withPasskeyDevice(page);
  await page.goto('/budget');
  await expect(page.getByRole('heading', { name: 'Set up sign-in' })).toBeVisible();
  await page.getByLabel('Setup code').fill('e2e-setup-code-0123456789abcdefghijklmnop');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await lockNewBudget(page);
  await expect(page).toHaveURL(/\/welcome/, { timeout: 30_000 });

  // A new user.
  const alexCtx = await browser.newContext();
  const alex = await alexCtx.newPage();
  await withPasskeyDevice(alex);
  await alex.goto('/budget');
  // The robot check runs on its own address (docs/privacy.md 5.6) and comes back with its token in the fragment,
  // which the app reads and takes out of the address.
  const checked = alex.waitForResponse((r) => r.url() === `${CHECK_URL}/`);
  await alex.getByRole('button', { name: 'Create account' }).click();
  const checkPage = await checked;
  expect(checkPage.headers()['content-security-policy']).toContain('https://challenges.cloudflare.com');
  await expect(alex.getByRole('heading', { name: 'Create account' })).toBeVisible();
  await expect(alex).toHaveURL(/\/budget$/);
  // The app's own pages still name no outside host.
  expect((await alex.request.get('/budget')).headers()['content-security-policy'] ?? '').not.toContain(
    'https:',
  );
  await expect(alex.getByText('No one can recover it for you.')).toBeVisible();
  // A passkey and nothing else: no name or email is asked for (D-85).
  await expect(alex.getByLabel('Name')).toHaveCount(0);
  await alex.getByRole('button', { name: 'Create passkey' }).click();
  // A new account locks its budget first, then starts at first-run setup, and can't link banks.
  const key = await lockNewBudget(alex);
  await expect(alex).toHaveURL(/\/welcome/, { timeout: 30_000 });
  expect((await session(alex)).json.canLinkBanks).toBe(false);
  // First-run setup without banks: the link step is skipped.
  await alex.getByRole('link', { name: 'Get started' }).click();
  await alex.getByRole('button', { name: 'Continue' }).click();
  await expect(alex.getByRole('heading', { name: 'Make your categories' })).toBeVisible();
  await alex.getByRole('button', { name: 'Go to my budget' }).click();
  await expect(alex).toHaveURL(/\/budget/);

  // Alex loses the device: the recovery key on a new one signs in and opens the budget. Its own address: sign-in
  // checks are counted per address.
  const phoneCtx = await browser.newContext({ extraHTTPHeaders: { 'cf-connecting-ip': '198.51.100.7' } });
  const phone = await phoneCtx.newPage();
  await withPasskeyDevice(phone);
  await phone.goto('/budget');
  await phone.getByRole('button', { name: 'Use your recovery key' }).click();
  await phone.getByTestId('recovery-key-typed').fill(key);
  await phone.getByRole('button', { name: 'Continue' }).click();
  await expect(phone.getByText('Groceries')).toBeVisible({ timeout: 60_000 });
  // Alex's first device still works, and tells of the recovery key's sign-in.
  expect((await session(alex)).status).toBe(200);
  await alex.reload();
  await expect(alex.getByText(/Your recovery key signed in on/)).toBeVisible({ timeout: 30_000 });

  // Alex deletes the account: the budget's name, then a confirm.
  await phone.goto('/settings/sign-in');
  await phone.getByRole('button', { name: 'Delete account' }).click();
  await phone.getByLabel(/to confirm/).fill('My budget');
  await phone.getByRole('button', { name: 'Delete account' }).last().click();
  await phone.getByRole('alertdialog').getByRole('button', { name: 'Delete account' }).click();
  await expect(phone.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  // Signed out everywhere.
  expect((await session(alex)).status).toBe(401);
});

test('the robot check says when it can’t load, and the privacy policy opens before sign-in', async ({
  page,
}) => {
  // A real site key, with Cloudflare's script blocked: the page says so and offers to try again.
  await page.route('https://challenges.cloudflare.com/**', (r) => r.abort());
  await page.route(`${CHECK_URL}/`, async (r) => {
    const res = await r.fetch();
    const body = (await res.text()).replace(/"siteKey":"[^"]*"/, '"siteKey":"0x4AAAAAAAreal"');
    await r.fulfill({ response: res, body });
  });
  await page.goto(`${CHECK_URL}/`);
  await expect(page.getByRole('alert')).toHaveText(
    'The robot check couldn’t load. Check your connection, then try the check again.',
  );
  await expect(page.getByRole('button', { name: 'Try the check again' })).toBeVisible();
  // The check's address holds nothing: no cookie.
  expect(await page.context().cookies(CHECK_URL)).toEqual([]);

  await page.goto('/budget');
  await page.getByRole('link', { name: 'Privacy policy' }).click();
  await expect(page.getByRole('heading', { name: 'The short version' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to budget' }).click();
  await expect(page.getByRole('heading', { name: /^(Sign in|Set up sign-in)$/ })).toBeVisible();
});
