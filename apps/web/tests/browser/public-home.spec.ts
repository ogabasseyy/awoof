import { expect, test } from '@playwright/test';
import { installSyntheticApi } from './fixtures';

/**
 * Homepage contract (Task 3): verification-first hero, discoverable audience
 * paths, reachable deals, and a hero that reads with JavaScript disabled.
 */
test('homepage hero topic is student verification', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/');
  const heading = page.locator('main h1');
  await expect(heading).toHaveCount(1);
  await expect(heading).toContainText(/verif/i);
});

test('homepage audience paths are discoverable', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/');
  const main = page.locator('main');
  for (const audience of ['Students', 'Businesses', 'Universities']) {
    await expect(main.getByRole('heading', { name: audience, exact: true })).toBeVisible();
  }
  await expect(main.getByRole('link', { name: 'Browse benefits' })).toHaveAttribute('href', '/marketplace');
  await expect(main.getByRole('link', { name: 'Verify students' })).toHaveAttribute('href', '/partner');
  await expect(main.getByRole('link', { name: 'Connect enrollment' })).toHaveAttribute('href', '/partner#universities');
});

test('homepage keeps deals reachable and honest', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/');
  await expect(page.locator('main').getByRole('link', { name: /browse deals|see all deals/i }).first()).toBeVisible();
  await expect(page.locator('main').getByText(/thousands of verified/i)).toHaveCount(0);
  await expect(page.locator('main').getByText(/download for (android|ios)/i)).toHaveCount(0);
});

test('homepage hero reads with JavaScript disabled', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await installSyntheticApi(page);
    await page.goto('/');
    const heading = page.locator('main h1');
    await expect(heading).toBeVisible();
    await expect(heading).toContainText(/verif/i);
    const html = await page.content();
    if (!html.toLowerCase().includes('verif')) throw new Error('Hero verification topic missing from disabled-JS HTML.');
  } finally {
    await context.close();
  }
});
