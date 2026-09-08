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
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByRole('option')).toHaveCount(0);
  await input.press('Tab');
  await expect(input).toHaveValue('');
  await assertCleanFixture(api, faults);
});

test('mixed malformed directory fields never break search or reach the option consumer', async ({ page }) => {
  const api = await installSyntheticApi(page, {
    universityResults: [
      { id: '10000000-0000-4000-8000-000000000011', name: 'Approved Safe University', shortcode: 'SAFE', domain: 'safe.approved.test', country: 'Nigeria' },
      { id: '10000000-0000-4000-8000-000000000012', name: 'Unsafe Metadata University', shortcode: 123, domain: { unexpected: true }, country: ['not-a-country'] },
      { id: '', name: 'Missing Identity University', shortcode: 'MISS', domain: 'missing.approved.test', country: 'Nigeria' },
    ],
  });
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register');
  const input = page.getByLabel(/^University/);
  await input.fill('does-not-match-a-name');
  await expect(page.getByRole('status')).toContainText('No matching university');
  await input.fill('unsafe');
  const unsafeOption = page.getByRole('option', { name: /Unsafe Metadata University/ });
  await expect(unsafeOption).toBeVisible();
  await expect(unsafeOption).not.toContainText('123');
  await expect(unsafeOption).not.toContainText('[object Object]');
  await input.fill('safe');
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(input).toHaveValue('Approved Safe University');
  await assertCleanFixture(api, faults);
});

test('keyboard navigation keeps the active long-directory option visible before committing it', async ({ page }) => {
  const longDirectory = Array.from({ length: 18 }, (_, index) => ({
    id: `10000000-0000-4000-8000-${String(index + 21).padStart(12, '0')}`,
    name: `Long Directory University ${String(index + 1).padStart(2, '0')}`,
    shortcode: `LONG${index + 1}`,
    domain: `long-${index + 1}.approved.test`,
    country: 'Nigeria',
  }));
  const api = await installSyntheticApi(page, { universityResults: longDirectory });
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register');
  const input = page.getByLabel(/^University/);
  const listbox = page.getByRole('listbox');

  async function expectActiveOptionVisible(): Promise<void> {
    const activeOption = page.getByRole('option', { selected: true });
    const [listboxRect, optionRect] = await Promise.all([listbox.boundingBox(), activeOption.boundingBox()]);
    expect(listboxRect).not.toBeNull();
    expect(optionRect).not.toBeNull();
    expect(optionRect!.y).toBeGreaterThanOrEqual(listboxRect!.y);
    expect(optionRect!.y + optionRect!.height).toBeLessThanOrEqual(listboxRect!.y + listboxRect!.height);
  }

  await input.fill('long directory');
  for (let index = 0; index < 15; index += 1) await input.press('ArrowDown');
  await expect(page.getByRole('option', { selected: true })).toContainText('Long Directory University 15');
  await expectActiveOptionVisible();
  for (let index = 0; index < 10; index += 1) await input.press('ArrowUp');
  await expect(page.getByRole('option', { selected: true })).toContainText('Long Directory University 05');
  await expectActiveOptionVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('Long Directory University 05');
  await expect(input).toBeFocused();
  await assertCleanFixture(api, faults);
});

test('retired widget does not collect student identity or verification proof', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page, api);
  await page.goto('/widget/verify?apiKey=synthetic-public-key&vendorId=synthetic-vendor&origin=https%3A%2F%2Fmerchant.approved.test');
  await expect(page.getByRole('heading', { name: 'Merchant verification is unavailable' })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
  await assertCleanFixture(api, faults);
});
