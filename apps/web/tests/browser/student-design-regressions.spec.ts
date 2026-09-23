import { expect, test, type Page } from '@playwright/test';
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
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Enter your email first' })).toBeVisible();
});

test('student login shows server errors accessibly', async ({ page }) => {
  await installSyntheticApi(page);
  await page.route(`${apiOrigin}/api/auth/student/login-options`, (route) => route.fulfill({
    headers,
    json: { success: true, data: { password: true, providers: [], registration: true, recovery: true } },
  }));
  await page.goto('/auth/student/login');
  await page.getByLabel('Email').fill('invalid@approved.test');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
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

async function stubVerification(page: Page, eligible: boolean) {
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

// Task A2: school-account assurance and current-enrollment eligibility are
// independent checks with independent labels and expiry. A verified school
// mailbox never implies student benefits.
const pendingAssurance = {
  schoolAccountStatus: 'verified',
  schoolAccountMethod: 'email_otp',
  schoolAccountValidUntil: '2030-06-15T00:00:00.000Z',
  studentStatus: 'pending',
  enrollmentMethod: null,
  studentValidUntil: null,
  reason: 'awaiting_enrollment',
};

const credentialedHeaders = { ...headers, 'access-control-allow-credentials': 'true' };

async function stubVerificationWithAssurance(page: Page, failStatus: { current: boolean }) {
  await page.route(`${apiOrigin}/api/verification/**`, async (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    if (endpoint.endsWith('/status')) {
      if (failStatus.current) {
        await route.fulfill({ headers, status: 503, json: { success: false, error: { message: 'Down' } } });
        return;
      }
      await route.fulfill({ headers, json: { success: true, data: { ...verificationStatus(false), studentAssurance: pendingAssurance } } });
      return;
    }
    let data: unknown = {};
    if (endpoint.includes('/methods/')) data = { methods: [{ methodType: 'email', isAvailable: true }] };
    else if (endpoint.endsWith('/consents')) data = { items: [], nextCursor: null };
    else if (endpoint.includes('/microsoft/identities')) data = { items: [], nextCursor: null };
    else if (endpoint.includes('/microsoft/consents')) data = { items: [], nextCursor: null };
    await route.fulfill({ headers: credentialedHeaders, json: { success: true, data } });
  });
}

test('verification shows independent school and student status with expiry', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'student');
  await stubVerificationWithAssurance(page, { current: false });
  await page.goto('/student/verification');
  await expect(page.getByText('School account:')).toBeVisible();
  await expect(page.getByText(/Verified.*school email code.*2030/)).toBeVisible();
  await expect(page.getByText('Student status:')).toBeVisible();
  await expect(page.getByText(/Pending.*enrollment/)).toBeVisible();
});

test('verification load failure offers a retry that recovers without fake states', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'student');
  const failStatus = { current: true };
  await stubVerificationWithAssurance(page, failStatus);
  await page.goto('/student/verification');
  await expect(page.getByRole('alert').filter({ hasText: /unable to load verification/i })).toBeVisible();
  await expect(page.getByText('Your student eligibility is current.')).toHaveCount(0);
  failStatus.current = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Current status' })).toBeVisible();
  await expect(page.getByText(/Pending.*enrollment/)).toBeVisible();
});

test('profile shows independent school and student status', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'student');
  await page.route(`${apiOrigin}/api/verification/status`, async (route) => {
    await route.fulfill({ headers, json: { success: true, data: { eligibility: { eligible: false }, studentAssurance: pendingAssurance } } });
  });
  await page.goto('/student/profile');
  await expect(page.getByText('School account:')).toBeVisible();
  await expect(page.getByText(/Verified.*school email code.*2030/)).toBeVisible();
  await expect(page.getByText('Student status:')).toBeVisible();
  await expect(page.getByText(/Pending.*enrollment/)).toBeVisible();
  await expect(page.getByText('Verified', { exact: true })).toHaveCount(0);
});

test('profile status failure shows retry without positive state', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'student');
  const failStatus = { current: true };
  await page.route(`${apiOrigin}/api/verification/status`, async (route) => {
    if (failStatus.current) {
      await route.fulfill({ headers, status: 503, json: { success: false, error: { message: 'Down' } } });
    } else {
      await route.fulfill({ headers, json: { success: true, data: { eligibility: { eligible: false }, studentAssurance: pendingAssurance } } });
    }
  });
  await page.goto('/student/profile');
  await expect(page.getByText('Verification unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('Verified', { exact: true })).toHaveCount(0);
  failStatus.current = false;
  await page.getByRole('button', { name: 'Retry verification status' }).click();
  await expect(page.getByText(/Pending.*enrollment/)).toBeVisible();
});
