import { expect, test } from '@playwright/test';
import { installSyntheticApi } from './fixtures';

/**
 * Widget design-regression baseline (Task 1B).
 *
 * Source boundary, verified against `src/app/widget/verify/page.tsx`: no
 * iframe embedding mode, popup, or redirect flow exists. The route is a static
 * unavailable notice. These tests pin that boundary so shared style/layout
 * changes cannot silently alter it, and Task 7 re-runs them against the
 * candidate. Do not weaken these assertions to make a redesign pass.
 */
test('widget verify is a static unavailable notice with no form or public chrome', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const response = await page.goto('/widget/verify');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Merchant verification is unavailable' })).toBeVisible();
  await expect(page.getByText('This verification widget is being replaced.', { exact: false })).toBeVisible();
  await expect(page.getByText('Do not submit student documents', { exact: false })).toBeVisible();
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator('main form, main input, main textarea, main select, main button')).toHaveCount(0);
  await expect(page.locator('header, footer')).toHaveCount(0);
  await expect(page.getByText("Don't miss the next big Awoof", { exact: false })).toHaveCount(0);
  await api.drainPendingHandlers();
  api.assertNoUnexpectedRequests();
});

for (const width of [320, 390]) {
  test(`widget verify has no clipped content at ${width}px`, async ({ page }) => {
    await installSyntheticApi(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/widget/verify');
    await expect(page.getByRole('heading', { name: 'Merchant verification is unavailable' })).toBeVisible();
    const overflow = await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

test('widget verify exposes no tab stops inside its own content', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/widget/verify');
  await expect(page.getByRole('heading', { name: 'Merchant verification is unavailable' })).toBeVisible();
  const tabbablesInMain = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('main a[href], main button, main input, main textarea, main select, main [tabindex]')];
    return candidates.filter((element) => {
      const node = element as HTMLElement;
      if (node.tabIndex < 0) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).length;
  });
  expect(tabbablesInMain).toBe(0);
});
