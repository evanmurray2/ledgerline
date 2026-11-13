// Open sign-up and recovery codes with the switch on (D-75; playwright.signup.config.ts), with Chromium's virtual
// passkey authenticator: the owner sets up, a new user creates an account, then recovers on another device.
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

/** A new budget is locked before anything else (D-102): the recovery key is made, typed back, and the budget sent. */
async function lockNewBudget(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Make my recovery key' }).click();
  const key = (await page.getByTestId('recovery-key').textContent())!;
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('recovery-key-typed').fill(key);
  await page.getByRole('button', { name: 'Lock my budget' }).click();
  return key;
}

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
  await alex.getByRole('button', { name: 'Create account' }).click();
  await expect(alex.getByRole('heading', { name: 'Create account' })).toBeVisible();
  await expect(alex.getByText('No one can recover it for you.')).toBeVisible();
  // A passkey and nothing else: no name or email is asked for (D-85).
  await expect(alex.getByLabel('Name')).toHaveCount(0);
  await alex.getByRole('button', { name: 'Create passkey' }).click();
  await expect(alex.getByRole('heading', { name: 'Save your recovery code' })).toBeVisible();
  const code = (await alex.getByTestId('recovery-code').textContent())!.trim();
  expect(code).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
  await expect(alex.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await alex.getByLabel(/I saved my recovery code/).check();
  await alex.getByRole('button', { name: 'Continue' }).click();
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
