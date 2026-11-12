// "Same purchase?" and Not the same (docs/payee-names.md 9.1) in mock mode: the card's Yes and No on Activity's
// Needs attention, and Not the same (with its Undo) on your entry's sheet and on a posted row paired with the bank's pending row. The `samepurchase` scenario (apps/web/src/mock/server.ts).
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ledgerline-theme', 'light'));
});

const card = (page: Page) => page.getByTestId('same-purchase');
/** Not posted yet, reached inside the app (a new page load starts the mock over). */
const notPosted = async (page: Page) => {
  await page.getByRole('button', { name: 'Not posted yet' }).click();
  await expect(page.getByText('counts now', { exact: false })).toBeVisible();
};

test('Same purchase? Yes: your entry covers the bank’s pending row, which stops showing', async ({
  page,
}) => {
  await page.goto('/activity?filter=attention&mock=samepurchase');
  await expect(card(page)).toHaveCount(1);
  await expect(card(page).getByText('SQ *NOPA SF')).toBeVisible();
  await expect(card(page).getByText('Dinner at Nopa')).toBeVisible();
  await page
    .getByRole('button', { name: 'Yes, Dinner at Nopa $42.00 and SQ *NOPA SF $46.50 are the same purchase' })
    .click();
  await expect(page.getByText('Paired as one purchase')).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await notPosted(page);
  await expect(page.getByText('Dinner at Nopa')).toBeVisible();
  await expect(page.getByText('SQ *NOPA SF')).toHaveCount(0);
});

test('Same purchase? No: the card goes and both rows stay', async ({ page }) => {
  await page.goto('/activity?filter=attention&mock=samepurchase');
  await page
    .getByRole('button', {
      name: 'No, Dinner at Nopa $42.00 and SQ *NOPA SF $46.50 are not the same purchase',
    })
    .click();
  await expect(page.getByText('Kept as two purchases')).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await notPosted(page);
  await expect(page.getByText('Dinner at Nopa')).toBeVisible();
  await expect(page.getByText('SQ *NOPA SF')).toBeVisible();
});

test('Not the same on your entry’s sheet ends its cover: the bank’s row counts again', async ({ page }) => {
  await page.goto('/activity?filter=pending&mock=samepurchase');
  await expect(page.getByText('TACOS EL PASTOR')).toHaveCount(0);
  await page.getByRole('link', { name: /^Tacos/ }).click();
  await expect(page.getByText('Matched to the bank')).toBeVisible();
  await page
    .getByRole('button', { name: 'Not the same: Tacos and Bank pending: TACOS EL PASTOR · Nov 12 · $12.50' })
    .click();
  await expect(page.getByText('Kept as two purchases')).toBeVisible();
  await expect(page.getByText('TACOS EL PASTOR')).toBeVisible();
});

test('Undo after Not the same pairs them again: the bank’s row stops showing', async ({ page }) => {
  await page.goto('/activity?filter=pending&mock=samepurchase');
  await page.getByRole('link', { name: /^Tacos/ }).click();
  await page
    .getByRole('button', { name: 'Not the same: Tacos and Bank pending: TACOS EL PASTOR · Nov 12 · $12.50' })
    .click();
  await expect(page.getByText('TACOS EL PASTOR')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Paired as one purchase')).toBeVisible();
  await expect(page.getByText('TACOS EL PASTOR')).toHaveCount(0);
  await expect(page.getByText('Tacos', { exact: true })).toBeVisible();
});

test('Not the same on a posted row paired with the bank’s pending row: the pending row counts again', async ({
  page,
}) => {
  await page.goto('/activity?mock=samepurchase&filter=all');
  await page
    .getByRole('link', { name: /^PHO 24 SAN FRANCISCO/ })
    .first()
    .click();
  await expect(page.getByText('Same purchase as')).toBeVisible();
  await page
    .getByRole('button', { name: 'Not the same: PHO 24 SAN FRANCISCO and Bank pending: PHO 24 · Nov 11' })
    .click();
  await expect(page.getByText('Kept as two purchases')).toBeVisible();
  await notPosted(page);
  await expect(page.getByText('PHO 24', { exact: true })).toBeVisible();
});
