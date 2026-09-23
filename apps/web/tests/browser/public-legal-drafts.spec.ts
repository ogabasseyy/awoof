import { expect, test } from '@playwright/test';

const draftRoutes = ['/legal', '/privacy', '/terms', '/cookies', '/legal/merchant-terms', '/legal/data-protection'];

for (const route of draftRoutes) {
  test(`${route} is a clearly marked, non-indexable legal draft`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page.locator('main h1')).toHaveCount(1);
    await expect(page.getByText('Draft for owner and legal review', { exact: true })).toBeVisible();
    await expect(page.locator('main')).toContainText('It is not effective');
    if (['/legal', '/privacy', '/terms', '/legal/merchant-terms'].includes(route)) {
      await expect(page.locator('main')).toContainText('Awoof Digital Services');
      await expect(page.locator('main')).toContainText('8449678');
      await expect(page.locator('main')).toContainText('2 Olaide Tomori Street, Ikeja, Lagos');
    }
    await expect(page.getByRole('link', { name: 'support@awoof.tech' })).toHaveAttribute('href', 'mailto:support@awoof.tech');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    const anchors = page.locator('main nav a[href^="#"]');
    for (const href of await anchors.evaluateAll((links) => links.map((link) => link.getAttribute('href')!))) {
      await expect(page.locator(href)).toHaveCount(1);
      await expect(page.locator(`${href} h2`)).toHaveCount(1);
    }
    await page.setViewportSize({ width: 320, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('privacy draft separates account, school-account and enrollment checks', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.locator('#verification')).toContainText('Current enrollment is a separate question');
  await expect(page.locator('#merchants')).toContainText('standard verification response does not include');
  await expect(page.locator('#retention')).toBeVisible();
  await expect(page.locator('main')).toContainText('People who cannot sign in can contact support@awoof.tech');
});

test('terms draft does not promise discounts or universal school support', async ({ page }) => {
  await page.goto('/terms');
  await expect(page.locator('main')).toContainText('Awoof account access alone does not establish current enrollment');
  await expect(page.locator('main')).toContainText('Merchants set the terms of their own offers');
});

test('review navigation connects all drafts without advertising them as launched policies', async ({ page }) => {
  await page.goto('/legal');
  const navigation = page.getByRole('navigation', { name: 'Legal review documents', exact: true });
  for (const route of draftRoutes) {
    await expect(navigation.locator(`a[href="${route}"]`)).toHaveCount(1);
    await expect(page.locator(`footer a[href="${route}"]`)).toHaveCount(0);
  }
  const sitemap = await page.request.get('/sitemap.xml');
  expect(sitemap.ok()).toBe(true);
  const sitemapText = await sitemap.text();
  for (const route of draftRoutes) expect(sitemapText).not.toContain(`${route}</loc>`);
  await navigation.getByRole('link', { name: 'Merchant partnership terms', exact: true }).click();
  await expect(page).toHaveURL(/\/legal\/merchant-terms$/);
  await expect(page.locator('main h1')).toHaveText('Merchant partnership terms');
});
