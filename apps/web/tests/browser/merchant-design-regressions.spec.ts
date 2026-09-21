import { expect, test } from '@playwright/test';
import { apiOrigin, appOrigin, installSyntheticApi, seedSession } from './fixtures';

/**
 * Merchant design regressions (Task 6): integration clarity with credential
 * hygiene. Key reveal/revoke behavior preserved; keys never rendered unless
 * the server just issued them in-session.
 */
const headers = { 'access-control-allow-origin': appOrigin };

test('integration API tab explains server-side key scope', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'vendor');
  await page.goto('/vendor/integration');
  await page.getByRole('button', { name: 'API Configuration' }).click();
  await expect(page.getByText(/server keys live on your backend/i)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Developer guide' })).toHaveAttribute('href', '/developers');
});

test('existing key stays hidden with scope guidance', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'vendor');
  await page.route(`${apiOrigin}/api/vendors/payment/api-key`, async (route) => {
    await route.fulfill({ headers, json: { success: true, data: { hasApiKey: true } } });
  });
  await page.goto('/vendor/integration');
  await page.getByRole('button', { name: 'API Configuration' }).click();
  await expect(page.locator('input[value="***hidden***"]')).toBeVisible();
  await expect(page.locator('main').getByText(/awoof_/)).toHaveCount(0);
});

test('integration tabs and key generation entry point survive', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'vendor');
  await page.goto('/vendor/integration');
  for (const tab of ['Overview', 'Widget Integration', 'API Configuration', 'Webhook Setup']) {
    await expect(page.getByRole('button', { name: tab, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'API Configuration' }).click();
  await expect(page.getByRole('button', { name: /generate/i })).toBeVisible();
});
