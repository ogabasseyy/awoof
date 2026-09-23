import { expect, test } from '@playwright/test';

for (const route of ['/privacy', '/terms']) {
  test(`${route} is a clearly marked, non-indexable legal draft`, async ({ page }) => {
    await page.goto(route);
    await expect(page.locator('main h1')).toHaveCount(1);
    await expect(page.getByText('Draft for owner and legal review', { exact: true })).toBeVisible();
    await expect(page.locator('main')).toContainText('Awoof Digital Services');
    await expect(page.locator('main')).toContainText('RC 8449678');
    await expect(page.locator('main')).toContainText('2 Olaide Tomori Street, Ikeja, Lagos');
    await expect(page.getByRole('link', { name: 'support@awoof.tech' })).toHaveAttribute('href', 'mailto:support@awoof.tech');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });
}

test('privacy draft separates account, school-account and enrollment checks', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'Verification is more than a school sign-in' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Merchant disclosures' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Retention and deletion' })).toBeVisible();
  await expect(page.locator('main')).toContainText('People who cannot sign in can contact support@awoof.tech');
});

test('terms draft does not promise discounts or universal school support', async ({ page }) => {
  await page.goto('/terms');
  await expect(page.getByRole('heading', { name: 'Eligibility and offers' })).toBeVisible();
  await expect(page.locator('main')).toContainText('Awoof account access alone does not establish current enrollment');
  await expect(page.locator('main')).toContainText('Merchants set the terms of their own offers');
});
