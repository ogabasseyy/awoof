import { expect, test } from '@playwright/test';

const draftRoutes = ['/legal', '/privacy', '/terms', '/cookies', '/legal/merchant-terms', '/legal/data-protection'];

for (const route of draftRoutes) {
  test(`${route} publishes the approved version without internal review notes`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page.locator('main h1')).toHaveCount(1);
    const version = ['/privacy', '/terms'].includes(route)
      ? 'Version 1.1 · Effective 24 September 2026'
      : 'Version 1.0 · Effective 23 September 2026';
    await expect(page.locator('main')).toContainText(version);
    await expect(page.locator('main')).not.toContainText('working draft');
    await expect(page.locator('main')).not.toContainText('Decisions requiring counsel');
    await expect(page.locator('main')).not.toContainText('proposed allocation');
    if (['/legal', '/privacy', '/terms', '/legal/merchant-terms'].includes(route)) {
      await expect(page.locator('main')).toContainText('Awoof Digital Services');
      await expect(page.locator('main')).toContainText('8449678');
      await expect(page.locator('main')).toContainText('2 Olaide Tomori Street, Ikeja, Lagos');
    }
    await expect(page.getByRole('link', { name: 'support@awoof.tech' })).toHaveAttribute('href', 'mailto:support@awoof.tech');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://awoof.tech${route}`);
    const anchors = page.locator('main nav a[href^="#"]');
    for (const href of await anchors.evaluateAll((links) => links.map((link) => link.getAttribute('href')!))) {
      await expect(page.locator(href)).toHaveCount(1);
      await expect(page.locator(`${href} h2`)).toHaveCount(1);
    }
    await page.setViewportSize({ width: 320, height: 740 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('/terms/v1-0 publishes the archived version 1.0 terms', async ({ page }) => {
  const route = '/terms/v1-0';
  const response = await page.goto(route);
  expect(response?.status()).toBe(200);
  await expect(page.locator('main h1')).toHaveCount(1);
  await expect(page.locator('main h1')).toHaveText('Terms of Service (Version 1.0)');
  await expect(page.locator('main')).toContainText('Version 1.0 · Effective 23 September 2026');
  await expect(page.locator('main')).not.toContainText('working draft');
  await expect(page.locator('main')).not.toContainText('Decisions requiring counsel');
  await expect(page.locator('main')).not.toContainText('proposed allocation');
  await expect(page.locator('main')).toContainText('Awoof Digital Services');
  await expect(page.locator('main')).toContainText('8449678');
  await expect(page.locator('main')).toContainText('2 Olaide Tomori Street, Ikeja, Lagos');
  await expect(page.getByRole('link', { name: 'support@awoof.tech' })).toHaveAttribute('href', 'mailto:support@awoof.tech');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://awoof.tech${route}`);
  const anchors = page.locator('main nav a[href^="#"]');
  for (const href of await anchors.evaluateAll((links) => links.map((link) => link.getAttribute('href')!))) {
    await expect(page.locator(href)).toHaveCount(1);
    await expect(page.locator(`${href} h2`)).toHaveCount(1);
  }
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('archived terms keep the version 1.0 eligibility text', async ({ page }) => {
  await page.goto('/terms/v1-0');
  await expect(page.locator('#eligibility')).toContainText('legal capacity to enter the applicable agreement');
  await expect(page.locator('#eligibility')).not.toContainText('declare that you meet this age requirement');
  await page.goto('/terms');
  await expect(page.locator('#eligibility')).toContainText('declare that you meet this age requirement');
});

test('current terms and legal index link the version 1.0 archive', async ({ page }) => {
  await page.goto('/terms');
  await expect(page.getByRole('navigation', { name: 'Legal documents', exact: true }).locator('a[href="/terms/v1-0"]')).toHaveCount(1);
  await expect(page.locator('main')).toContainText('archived version 1.0 accepted by existing accounts');
  await page.goto('/legal');
  await expect(page.getByRole('navigation', { name: 'Legal documents', exact: true }).locator('a[href="/terms/v1-0"]')).toHaveCount(1);
  const sitemap = await page.request.get('/sitemap.xml');
  expect(sitemap.ok()).toBe(true);
  expect(await sitemap.text()).toContain('/terms/v1-0</loc>');
});

test('privacy draft separates account, school-account and enrollment checks', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.locator('#verification')).toContainText('Current enrollment is a separate question');
  await expect(page.locator('#merchants')).toContainText('standard verification response does not include');
  await expect(page.locator('#retention')).toBeVisible();
  await expect(page.locator('main')).toContainText('People who cannot sign in can contact support@awoof.tech');
});

test('privacy notice records the terms-acceptance record and its retention', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.locator('#information').getByText(
    'Account and profile: name, email, institution, student or registration number, contact details when supplied, account role, linked sign-in identities and account status. Password-based accounts use a stored password hash. Student registration records your self-declaration that you are 18 or older, the Terms of Service version accepted and the server-recorded time. We do not independently verify age through this declaration.',
    { exact: true },
  )).toBeVisible();
  await expect(page.locator('#retention')).toContainText('record of the agreement under which the account was provided');
  await expect(page.locator('#retention')).toContainText('age declaration');
});

test('privacy notice keeps security reports on the in-app path', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.locator('#security')).toContainText('through in-app support after signing in');
});

test('terms keep payment disputes on verified paths', async ({ page }) => {
  await page.goto('/terms');
  await expect(page.locator('#payments')).toContainText('in-app support after signing in for Awoof’s involvement');
});

test('terms route result queries and complaints through in-app support', async ({ page }) => {
  await page.goto('/terms');
  await expect(page.locator('#verification')).toContainText('Query a result through in-app support after signing in');
  await expect(page.locator('#disputes')).toContainText('Send a complaint through in-app support after signing in');
});

test('terms draft does not promise discounts or universal school support', async ({ page }) => {
  await page.goto('/terms');
  await expect(page.locator('main')).toContainText('Awoof account access alone does not establish current enrollment');
  await expect(page.locator('main')).toContainText('Merchants set the terms of their own offers');
});

test('cookies notice discloses the homepage first-visit preference', async ({ page }) => {
  await page.goto('/cookies');
  await expect(page.locator('#essential')).toContainText('first-visit preference in local storage');
});

test('merchant-order and schedule-annex conditions stay on partner legal pages', async ({ page }) => {
  await page.goto('/terms');
  await expect(page.locator('main')).not.toContainText('These terms apply only through a separately accepted order form');
  await expect(page.locator('main')).not.toContainText('completed processing annexes govern personal-data matters');
  await page.goto('/legal/merchant-terms');
  await expect(page.locator('main')).toContainText('These terms apply only through a separately accepted order form');
  await expect(page.locator('main')).toContainText('completed processing annexes govern personal-data matters before exchange');
  await page.goto('/legal/data-protection');
  await expect(page.locator('main')).toContainText('incorporate its identified version into an agreement and complete the required processing annexes');
});

test('legal navigation and sitemap expose approved policies with partner execution boundaries', async ({ page }) => {
  await page.goto('/legal');
  const navigation = page.getByRole('navigation', { name: 'Legal documents', exact: true });
  for (const route of draftRoutes) {
    await expect(navigation.locator(`a[href="${route}"]`)).toHaveCount(1);
    if (!route.startsWith('/legal/')) await expect(page.locator(`footer a[href="${route}"]`)).toHaveCount(1);
  }
  const sitemap = await page.request.get('/sitemap.xml');
  expect(sitemap.ok()).toBe(true);
  const sitemapText = await sitemap.text();
  for (const route of draftRoutes) expect(sitemapText).toContain(`${route}</loc>`);
  await navigation.getByRole('link', { name: 'Merchant partnership terms', exact: true }).click();
  await expect(page).toHaveURL(/\/legal\/merchant-terms$/);
  await expect(page.locator('main h1')).toHaveText('Merchant Partnership Terms');
  await expect(page.locator('main')).toContainText('reading these terms does not execute an agreement');
});
