import { expect, test } from '@playwright/test';
import { installSyntheticApi } from './fixtures';

test('public header uses the new logo mark in white on blue', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/');
  const mark = page.locator('header [role="img"][aria-label="Awoof"]').first();
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute('data-brand-variant', 'white');
  await expect(mark).toHaveCSS('mask-image', /awoof-wordmark\.webp/);
});

test('public wordmark keeps its original proportions instead of filling a short header slot', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/');
  const mark = page.locator('header [role="img"][aria-label="Awoof"]').first();
  const box = await mark.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width / box!.height).toBeGreaterThan(2.85);
  expect(box!.width / box!.height).toBeLessThan(3.15);
  await expect(mark).toHaveCSS('mask-size', /^auto /);
});

test('student login uses a blue brand mark on its light mobile shell', async ({ page }) => {
  await installSyntheticApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/auth/student/login');
  const mark = page.locator('[role="img"][aria-label="Awoof"][data-brand-variant="blue"]').first();
  await expect(mark).toBeVisible();
});

test('new brand icons are discoverable for browser tabs and Apple bookmarks', async ({ page, request }) => {
  await installSyntheticApi(page);
  await page.goto('/');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /^\/icon\.png(?:\?|$)/);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', /^\/apple-icon\.png(?:\?|$)/);
  for (const path of ['/icon.png', '/apple-icon.png']) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('image/png');
  }
});
