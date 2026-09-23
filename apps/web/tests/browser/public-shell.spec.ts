import { expect, test } from '@playwright/test';
import { installSyntheticApi, seedSession } from './fixtures';

/**
 * Public shell contract (Task 2). Written against the existing `/` route
 * before the shell exists: skip link, single main/h1, mobile menu keyboard
 * behavior, and no placeholder social links. New-destination checks belong to
 * their owning page tasks.
 */
test('public shell has a single topic and keyboard entry', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/');
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator('h1')).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
});

test('mobile menu toggles with Escape close and focus return', async ({ page }) => {
  await installSyntheticApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Open menu' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Close menu' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeFocused();
});

test('public chrome has no placeholder social links', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/');
  await expect(page.locator('a[href="#"]')).toHaveCount(0);
});

test('marketplace uses the single shared footer with working deal navigation', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/marketplace');
  await expect(page.locator('footer')).toHaveCount(1);
  await expect(page.getByText('Student verification and access to benefits.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Get the app' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Marketplace' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Privacy', exact: true })).toHaveAttribute('href', '/privacy');
  await expect(page.getByRole('link', { name: 'Terms', exact: true })).toHaveAttribute('href', '/terms');
});

test('authenticated role destinations survive on the public shell', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'vendor');
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
});
