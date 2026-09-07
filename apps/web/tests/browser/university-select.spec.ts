import { expect, test } from '@playwright/test';
import { assertCleanFixture, collectBrowserFaults } from './browser-assertions';
import {
  appOrigin,
  installSyntheticApi,
  seedSession,
  storageTabPath,
} from './fixtures';

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`university selection accepts keyboard choice on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const api = await installSyntheticApi(page);
    const faults = collectBrowserFaults(page, api);
    await page.goto('/auth/student/register');
    const input = page.getByLabel(/^University/);
    await expect(input).toBeEnabled();
    await input.fill('Approved');
    await input.press('ArrowDown');
    await input.press('ArrowDown');
    await input.press('Enter');
    await expect(input).toHaveValue('Approved Beta University');
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('role', 'combobox');
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    await input.press('Tab');
    await expect(page.getByLabel(/^Matric Number/)).toBeFocused();
    await expect(input).toHaveValue('Approved Beta University');
    expect(api.universityRequests.length).toBeGreaterThan(0);
    expect(api.universityRequests.every((request) => !request.authorizationPresent)).toBe(true);
    await assertCleanFixture(api, faults);
  });
}

test('university selection accepts a touch option without losing the selected value', async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: appOrigin,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page, api);
  try {
    await page.goto('/auth/student/register');
    const input = page.getByLabel(/^University/);
    await input.fill('aau');
    await page.getByRole('option', { name: /Approved Alpha University/ }).tap();
    await expect(input).toHaveValue('Approved Alpha University');
    await input.press('Tab');
    await expect(input).toHaveValue('Approved Alpha University');
    await assertCleanFixture(api, faults);
  } finally {
    await context.close();
  }
});

test('escape discards an uncommitted university query', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register');
  const input = page.getByLabel(/^University/);
  await input.fill('Approved');
  await input.press('ArrowDown');
  await input.press('Escape');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(input).toHaveValue('Approved');
  await input.press('Tab');
  await expect(input).toHaveValue('');
  await assertCleanFixture(api, faults);
});

test('a public directory 401 retries without changing the stored session', async ({ page }) => {
  await seedSession(page, 'student');
  const api = await installSyntheticApi(page, { universityStatus: 401 });
  const faults = collectBrowserFaults(page, api);
  await page.goto(`${appOrigin}${storageTabPath}`);
  const before = await page.evaluate(() => localStorage.getItem('awoof.session.v1'));
  await page.goto('/auth/student/register');
  const input = page.getByLabel(/^University/);
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  expect(api.refreshCalls).toBe(0);
  expect(api.universityRequests.every((request) => !request.authorizationPresent)).toBe(true);
  api.setUniversityDirectory(200);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await input.fill('aau');
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(input).toHaveValue('Approved Alpha University');
  expect(api.refreshCalls).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('awoof.session.v1')) === before).toBe(true);
  await assertCleanFixture(api, faults);
});

test('an empty public directory announces a local no-match state', async ({ page }) => {
  const api = await installSyntheticApi(page, { universityResults: [] });
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register');
  const input = page.getByLabel(/^University/);
  await input.fill('aau');
  await expect(page.getByRole('status')).toContainText('No matching university');
  await expect(page.getByRole('option')).toHaveCount(0);
  await input.press('Tab');
  await expect(input).toHaveValue('');
  await assertCleanFixture(api, faults);
});

test('widget selection follows controlled identity without entering verification', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page, api);
  await page.goto('/widget/verify?apiKey=synthetic-public-key&vendorId=synthetic-vendor&origin=https%3A%2F%2Fmerchant.approved.test');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  const input = page.getByLabel(/^University/);
  await input.fill('aau');
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  await input.fill('different school');
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await input.press('Tab');
  await expect(input).toHaveValue('');
  await assertCleanFixture(api, faults);
});
