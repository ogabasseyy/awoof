import { expect, test } from '@playwright/test';
import { installSyntheticApi } from './fixtures';

/**
 * Partner and developer pages (Task 5): honest merchant/university journeys
 * and a developer overview grounded in real routes with synthetic examples.
 */
test('partner page covers merchants and universities honestly', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/partner');
  await expect(page.locator('main h1')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'For universities', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Vendor register' })).toHaveAttribute('href', '/auth/vendor/register');
  await expect(page.getByRole('link', { name: 'Vendor sign in' })).toHaveAttribute('href', '/auth/vendor/login');
  await expect(page.locator('main').getByText(/widget verification is unavailable/i)).toBeVisible();
  await expect(page.locator('main').getByText(/thousands of verified|guaranteed|case stud/i)).toHaveCount(0);
});

test('partner journey links the merchant terms and data-protection schedule', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/partner');
  const legal = page.getByRole('navigation', { name: 'Partner legal documents' });
  await expect(legal.getByRole('link', { name: 'Merchant partnership terms' })).toHaveAttribute('href', '/legal/merchant-terms');
  await expect(legal.getByRole('link', { name: 'Partner data-protection schedule' })).toHaveAttribute('href', '/legal/data-protection');
});

test('partner university anchor resolves to the universities section', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/partner#universities');
  await expect(page.locator('main #universities')).toBeVisible();
});

test('developers page documents real routes with synthetic examples', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/developers');
  await expect(page.locator('main h1')).toHaveCount(1);
  await expect(page.locator('main').getByText('/api/merchant-verification/exchange').first()).toBeVisible();
  await expect(page.locator('main').getByText('/api/merchant-verification/assertions').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open vendor integration' })).toHaveAttribute('href', '/vendor/integration');
});

test('developers page renders no secret-shaped example values', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/developers');
  const examples = page.locator('main pre');
  await expect(examples.first()).toBeVisible();
  const count = await examples.count();
  for (let index = 0; index < count; index += 1) {
    const text = (await examples.nth(index).innerText()) ?? '';
    expect(text).not.toMatch(/awoof_[A-Za-z0-9]{4,}/);
    expect(text).not.toMatch(/sk-(live|test)-[A-Za-z0-9]+/);
    expect(text.split(/\s+/).some((token) => /^[A-Za-z0-9_-]{43}$/.test(token))).toBe(false);
  }
});
