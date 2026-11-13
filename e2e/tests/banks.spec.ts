// A linked bank of a locked budget through the real Worker (playwright.bank.config.ts): the owner locks a new budget,
// links a bank in first-run setup on the fake Plaid (hosted Link leaves the app and comes back to it), the Worker
// fetches the link's first run and seals it to the budget's inbox, and the device files it: the bank's account and
// transactions show in the budget. Then Fetch now runs again, and the bank is removed.
import { expect, test, type Page } from '@playwright/test';
import { call, comeBack, lockNewBudget, newDevice } from './lock-helpers';

/** Comes back to the app until `done` holds: each time the copy reads the log and its bank runs. */
async function untilFiled(page: Page, done: () => Promise<boolean>) {
  await expect
    .poll(
      async () => {
        if (await done()) return true;
        await comeBack(page);
        return false;
      },
      { timeout: 90_000, intervals: [2_000] },
    )
    .toBe(true);
}

test('the owner links a bank on the fake Plaid; its first run is fetched, sealed and filed on the device', async ({
  browser,
}) => {
  const page = await newDevice(browser, '198.51.100.41');
  const appended: string[] = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/log/append') appended.push(String(r.status()));
  });

  await test.step('the owner: the setup code, a passkey, the lock', async () => {
    await page.goto('/budget');
    await page.getByLabel('Setup code').fill('e2e-setup-code-0123456789abcdefghijklmnop');
    await page.getByRole('button', { name: 'Create passkey' }).click();
    await lockNewBudget(page);
    await expect(page).toHaveURL(/\/welcome/, { timeout: 30_000 });
    await page.getByRole('link', { name: 'Get started' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
  });

  await test.step('first-run setup’s bank step: only the owner links banks (D-75)', async () => {
    await expect(page.getByRole('heading', { name: 'Link your banks and cards' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('0 of 10 bank links used')).toBeVisible();
    await page.getByRole('button', { name: 'Link a bank' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Use a bank link' });
    await expect(dialog.getByText('Use 1 of your 10 bank links?')).toBeVisible();
    const tokenAsked = page.waitForResponse((r) => r.url().endsWith('/api/settings/connections/link-token'));
    await dialog.getByRole('button', { name: 'Link a bank' }).click();
    // A new link asks for a recent passkey check first.
    const confirm = page.getByRole('dialog').getByRole('button', { name: 'Use passkey' });
    await Promise.race([tokenAsked, confirm.waitFor({ timeout: 15_000 }).then(() => confirm.click())]).catch(
      () => undefined,
    );
    // The page leaves for the (fake) hosted Link, which sends it back to /link-done, then to this step.
    await page.waitForURL(/\/setup\/link/, { timeout: 30_000 });
    const finished = await page.waitForResponse(
      (r) => r.url().endsWith('/api/settings/connections/link-finish') && r.status() === 200,
      { timeout: 30_000 },
    );
    expect(await finished.json()).toMatchObject({
      status: 'linked',
      connectionId: expect.stringMatching(/^con_/),
    });

    // The Worker knows the link by its id and state only; the bank's name comes from the run, filed on the device.
    const conns = (await call(page, 'GET', '/api/settings/connections')).json as {
      used: number;
      items: { id: string; institution: string; status: string }[];
    };
    expect(conns.used).toBe(1);
    expect(conns.items[0]!.institution).toBe('');
    await untilFiled(page, async () => (await page.getByText('E2E Bank').count()) > 0);
    await expect(page.getByText('Linked', { exact: true })).toBeVisible();
    await expect(page.getByText('1 of 10 bank links used')).toBeVisible();
    // The run went out as a bank entry of the log, signed and sealed by this device.
    expect(appended.filter((s) => s === '200').length).toBeGreaterThan(1);
  });

  await test.step('the rest of first-run setup takes the bank’s account as it is today', async () => {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Make your categories' })).toBeVisible();
    await page.getByRole('button', { name: 'Go to my budget' }).click();
    await expect(page).toHaveURL(/\/budget/, { timeout: 30_000 });

    await page.goto('/accounts');
    await expect(page.getByText('E2E Checking')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('net-worth')).toHaveText('$1,250.50');
    await page.goto('/activity');
    await expect(page.getByText('E2E Coffee Roasters', { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('E2E Bookshop', { exact: false }).first()).toBeVisible();
  });

  await test.step('Fetch now: the Worker fetches the link again, and the device files it', async () => {
    // Nothing new at the fake bank.
    const before = appended.length;
    const asked = (await call(page, 'POST', '/api/settings/connections/refresh')).json;
    expect(asked).toEqual({ ok: true, started: 1 });
    await untilFiled(page, async () => appended.length > before);
  });

  await test.step('Remove bank: the Worker ends the link at the bank, then the device marks it removed', async () => {
    await page.goto('/settings/connections');
    await page.getByRole('button', { name: 'Remove bank…' }).click();
    await page.getByRole('button', { name: 'Remove bank', exact: true }).click();
    const confirmRemove = page.getByRole('dialog').getByRole('button', { name: 'Use passkey' });
    await confirmRemove.click({ timeout: 10_000 }).catch(() => undefined);
    await expect
      .poll(
        async () =>
          ((await call(page, 'GET', '/api/settings/connections')).json as { items: { status: string }[] })
            .items[0]?.status,
        { timeout: 30_000 },
      )
      .toBe('removed');
    // Its account and transactions stay.
    await page.goto('/activity');
    await expect(page.getByText('E2E Coffee Roasters', { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
  });
  await page.context().close();
});
