import { expect, test } from '@playwright/test';
import { installSyntheticApi } from './fixtures';

/**
 * Public information pages (Task 4): trust, help, and contact render honest,
 * login-independent content with real next steps and no fabricated claims.
 */
test('trust page explains checks, sharing, and limits', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/trust');
  await expect(page.locator('main h1')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Two checks, not one' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What merchants learn' })).toBeVisible();
  await expect(page.getByText('Eligibility answers never include your documents')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Limits' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Get help' })).toBeVisible();
  await expect(page.locator('main')).toContainText('privacy notice and terms are published, owner-approved policies');
  await expect(page.locator('main')).not.toContainText('Until then, this trust center');
});

test('help page is usable without login and guides pending states honestly', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/help');
  await expect(page.locator('main h1')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Codes and delivery' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pending or expired status' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Consent' })).toBeVisible();
  await expect(page.locator('main').getByText(/pending/i).first()).toBeVisible();
  await expect(page).not.toHaveURL(/\/auth\//);
});

test('contact page links real support with sign-in expectations', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/contact');
  await expect(page.locator('main h1')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Student sign in' })).toHaveAttribute('href', '/auth/student/login');
  await expect(page.getByRole('link', { name: 'Vendor sign in' })).toHaveAttribute('href', '/auth/vendor/login');
  await expect(page.getByRole('link', { name: 'support@awoof.tech' })).toHaveAttribute('href', 'mailto:support@awoof.tech');
  await expect(page.locator('main')).not.toContainText('No public inbox or phone line');
  await expect(page.locator('main').getByText(/inside your account/i).first()).toBeVisible();
});

for (const path of ['/trust', '/help', '/contact']) {
  test(`${path} carries no fabricated certifications, counts, or contacts`, async ({ page }) => {
    await installSyntheticApi(page);
    await page.goto(path);
    const main = page.locator('main');
    await expect(main.getByText(/ISO\s?27001|SOC\s?2|PCI DSS/i)).toHaveCount(0);
    await expect(main.getByText(/thousands of verified/i)).toHaveCount(0);
    await expect(main.getByText(/\+2348000000000/)).toHaveCount(0);
    if (path !== '/contact') await expect(main.getByText(/support@awoof\.tech/)).toHaveCount(0);
  });
}
