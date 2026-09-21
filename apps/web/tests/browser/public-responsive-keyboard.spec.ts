import { expect, test, type Page } from '@playwright/test';
import { installSyntheticApi } from './fixtures';

/**
 * Responsive and keyboard coverage the shell spec does not own: small-phone
 * and tablet widths, a 200%-zoom equivalent viewport, overflow with the
 * mobile menu expanded, keyboard menu toggling, and visible-focus rendering.
 */
const publicRoutes = ['/', '/marketplace', '/trust', '/help', '/contact', '/partner', '/developers'];

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const route of publicRoutes) {
  for (const width of [320, 768]) {
    test(`public ${route} renders without overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await installSyntheticApi(page);
      await page.goto(route);
      await expect(page.locator('h1').first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }
}

for (const route of ['/', '/marketplace']) {
  test(`public ${route} holds together at a 200%-zoom equivalent viewport`, async ({ page }) => {
    // 200% browser zoom on a 1280px layout viewport leaves ~640 CSS px.
    await page.setViewportSize({ width: 640, height: 400 });
    await installSyntheticApi(page);
    await page.goto(route);
    await expect(page.locator('h1').first()).toBeVisible();
    await expect(page.getByRole('main').getByRole('link').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
}

test('expanded mobile menu shows every destination without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSyntheticApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  const menu = page.getByRole('navigation', { name: 'Mobile' });
  await expect(menu).toBeVisible();
  for (const label of ['Students', 'Businesses', 'Universities', 'Trust', 'Help']) {
    await expect(menu.getByRole('link', { name: label })).toBeVisible();
  }
  await expect(menu.getByRole('link', { name: 'Login' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('mobile menu toggles from the keyboard alone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSyntheticApi(page);
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Open menu' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Close menu' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('navigation', { name: 'Mobile' })).toHaveCount(0);
});

test('keyboard focus renders the public focus outline', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'Skip to content' });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toHaveCSS('outline-width', '3px');
  await expect(skipLink).toHaveCSS('outline-style', 'solid');
  await expect(skipLink).toHaveCSS('outline-color', 'rgb(223, 103, 30)');
});

test('desktop nav links show the focus outline on keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installSyntheticApi(page);
  await page.goto('/');
  await page.keyboard.press('Tab');
  const students = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Students' });
  await students.focus();
  await expect(students).toBeFocused();
  await expect(students).toHaveCSS('outline-width', '3px');
});
