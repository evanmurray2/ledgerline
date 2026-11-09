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

const session = (page: Page) =>
  page.evaluate(async () => {
    const r = await fetch('/api/session');
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  });

test('create an account, save the recovery code, and recover on another device', async ({
  page,
  browser,
}) => {
  // The owner sets up first: until then there is no Create account.
  await withPasskeyDevice(page);
  await page.goto('/budget');
  await expect(page.getByRole('heading', { name: 'Set up sign-in' })).toBeVisible();
  await page.getByLabel('Setup code').fill('e2e-setup-code-0123456789abcdefghijklmnop');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page).toHaveURL(/\/welcome/);

  // A new user.
  const alexCtx = await browser.newContext();
  const alex = await alexCtx.newPage();
  await withPasskeyDevice(alex);
  await alex.goto('/budget');
  await alex.getByRole('button', { name: 'Create account' }).click();
  await expect(alex.getByRole('heading', { name: 'Create account' })).toBeVisible();
  await expect(alex.getByText('No one can recover it for you.')).toBeVisible();
  await alex.getByLabel('Name').fill('Alex');
  await alex.getByRole('button', { name: 'Create passkey' }).click();
  await expect(alex.getByRole('heading', { name: 'Save your recovery code' })).toBeVisible();
  const code = (await alex.getByTestId('recovery-code').textContent())!.trim();
  expect(code).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
  await expect(alex.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await alex.getByLabel(/I saved my recovery code/).check();
  await alex.getByRole('button', { name: 'Continue' }).click();
  // A new account starts at first-run setup, and can't link banks.
  await expect(alex).toHaveURL(/\/welcome/);
  expect((await session(alex)).json.canLinkBanks).toBe(false);

  // Alex loses the device: a recovery code on a new one.
  const phoneCtx = await browser.newContext();
  const phone = await phoneCtx.newPage();
  await withPasskeyDevice(phone);
  await phone.goto('/budget');
  await phone.getByRole('button', { name: 'Use a recovery code' }).click();
  await phone.getByLabel('Recovery code').fill('not-a-code');
  await phone.getByRole('button', { name: 'Create passkey' }).click();
  await expect(phone.getByRole('alert')).toContainText('isn’t valid');
  await phone.getByLabel('Recovery code').fill(code.toLowerCase());
  await phone.getByRole('button', { name: 'Create passkey' }).click();
  await expect(phone.getByRole('heading', { name: 'Save your new recovery code' })).toBeVisible();
  const next = (await phone.getByTestId('recovery-code').textContent())!.trim();
  expect(next).not.toBe(code);
  await phone.getByLabel(/I saved my recovery code/).check();
  await phone.getByRole('button', { name: 'Continue' }).click();
  await expect(phone).toHaveURL(/\/welcome/);
  // The recovery shows a notice; Alex's first device still works.
  expect((await session(phone)).json.recoveryNoticeAt).toEqual(expect.any(String));
  expect((await session(alex)).status).toBe(200);
});
