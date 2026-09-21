import { expect, test } from '@playwright/test';
import { apiOrigin, appOrigin, installSyntheticApi, seedSession } from './fixtures';

/**
 * Student design regressions (Task 6): login clarity plus verification and
 * profile status honesty. Visual clarity only — all handlers preserved.
 */
const headers = { 'access-control-allow-origin': appOrigin };

test('student login renders labelled fields with inline errors', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/auth/student/login');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByText('Invalid email address')).toBeVisible();
});

test('student login shows server errors accessibly', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/auth/student/login');
  await page.getByLabel('Email').fill('invalid@approved.test');
  await page.getByLabel('Password', { exact: true }).fill('Wrongpass1');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page.getByRole('alert').first()).toContainText(/invalid credentials/i);
});

const verificationStatus = (eligible: boolean) => ({
  emailDomainApproved: true,
  email: 'student@approved.test',
  universityId: 'b9c35781-9f75-44b6-98ca-0c928fb993a9',
  eligibility: { eligible },
  notices: { verification: { version: 'fixture-notice', text: 'I agree to school email verification.' } },
});

async function stubVerification(page: Parameters<Parameters<typeof test>[1]>[0], eligible: boolean) {
  await page.route(`${apiOrigin}/api/verification/**`, async (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    let data: unknown = {};
    if (endpoint.endsWith('/status')) data = verificationStatus(eligible);
    else if (endpoint.includes('/methods/')) data = { methods: [{ methodType: 'email', isAvailable: true }] };
    else if (endpoint.endsWith('/consents')) data = { items: [], nextCursor: null };
    else if (endpoint.includes('/microsoft/identities')) data = { items: [], nextCursor: null };
    await route.fulfill({ headers, json: { success: true, data } });
  });
}

test('verification eligible state shows a status overview with next steps', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'student');
  await stubVerification(page, true);
  await page.goto('/student/verification');
  await expect(page.getByRole('heading', { name: 'Current status' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Your student eligibility is current.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse student offers' })).toHaveAttribute('href', '/marketplace');
});

test('verification action-needed state links help explicitly', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'student');
  await stubVerification(page, false);
  await page.goto('/student/verification');
  await expect(page.getByRole('heading', { name: 'Current status' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Get verification help' })).toHaveAttribute('href', '/help');
});

test('verification load failure shows an error without fake states', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'student');
  await page.route(`${apiOrigin}/api/verification/status`, async (route) => {
    await route.fulfill({ headers, status: 503, json: { success: false, error: { message: 'Down' } } });
  });
  await page.goto('/student/verification');
  await expect(page.getByRole('alert').first()).toContainText(/unable to load verification/i);
  await expect(page.getByText('Your student eligibility is current.')).toHaveCount(0);
});

test('profile badge never shows verified from unknown or negative eligibility', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'student');
  await page.route(`${apiOrigin}/api/verification/status`, async (route) => {
    await route.fulfill({ headers, json: { success: true, data: { eligibility: { eligible: false } } } });
  });
  await page.goto('/student/profile');
  await expect(page.getByText('Unverified', { exact: true })).toBeVisible();
  await expect(page.getByText('Verified', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /verify your student status/i })).toHaveAttribute('href', '/student/verification');
});
