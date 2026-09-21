import { expect, test } from '@playwright/test';
import { installSyntheticApi } from './fixtures';

for (const width of [390, 1440]) {
  test(`Remix centered hero and branded layered cards at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await installSyntheticApi(page);
    await page.goto('/');
    const hero = page.locator('#hero');
    await expect(hero).toHaveCSS('background-image', 'none');
    await expect(hero.locator('h1')).toHaveCSS('text-align', 'center');
    await expect(hero.locator('h1 em')).toBeVisible();
    await expect(hero.getByAltText('Awoof')).toBeVisible();
    await expect(hero.getByText('Good fuel.')).toBeVisible();
    await expect(hero.getByText('More power')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
