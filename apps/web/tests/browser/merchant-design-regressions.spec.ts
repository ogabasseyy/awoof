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
  await expect(page.getByRole('link', { name: 'Merchant Partnership Terms' })).toHaveAttribute('href', '/legal/merchant-terms');
  await expect(page.getByRole('link', { name: 'Partner Data-Protection Schedule' })).toHaveAttribute('href', '/legal/data-protection');
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

test('vendor analytics reports purchasing students, never a verification count (A5)', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'vendor');
  await page.route(`${apiOrigin}/api/vendors/analytics`, async (route) => {
    await route.fulfill({
      headers,
      json: {
        success: true,
        data: {
          overall: {
            totalOrders: 9, completedOrders: 8, totalRevenue: 640, totalCommission: 64,
            totalEarnings: 576, uniqueCustomers: 7, averageOrderValue: 80, conversionRate: 88.89,
          },
          products: [],
          timeBased: [],
          monthly: [],
          students: { totalStudents: 11, purchasingStudents: 7, verifiedStudents: 7, repeatCustomers: 3 },
          topProducts: [],
        },
      },
    });
  });
  await page.goto('/vendor/analytics');
  await page.getByRole('button', { name: 'Students', exact: true }).click();
  await expect(page.getByText('Purchasing Students', { exact: true })).toBeVisible();
  await expect(page.getByText('Verified Students', { exact: true })).toHaveCount(0);
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
