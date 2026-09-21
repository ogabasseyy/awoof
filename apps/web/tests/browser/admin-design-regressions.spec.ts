import { expect, test } from '@playwright/test';
import { apiOrigin, appOrigin, installSyntheticApi, seedSession } from './fixtures';

/**
 * Admin design-regression baseline (Task 1B).
 *
 * Pins authenticated admin navigation, unauthorized redirect behavior, narrow
 * table readability, and absence of public marketing chrome before shared
 * style/layout changes. Task 7 re-runs this suite against the candidate.
 * Session-isolation behavior stays covered by admin-support-session.spec.ts.
 */
const headers = { 'access-control-allow-origin': appOrigin };
const syntheticStudents = [
  {
    id: 'synthetic-student-row-1',
    userId: 'synthetic-user-row-1',
    name: 'Synthetic Row One',
    email: 'row.one@alpha.approved.test',
    university: 'Approved Alpha University',
    registrationNumber: 'SYN-ROW-1',
    phoneNumber: null,
    status: 'verified',
    verificationDate: '2026-09-01T00:00:00Z',
    createdAt: '2026-08-01T00:00:00Z',
    totalSpent: 12500,
    totalSavings: 2500,
  },
];

test('unauthenticated admin dashboard redirects to the admin login', async ({ page }) => {
  await installSyntheticApi(page);
  await page.goto('/admin/dashboard');
  await page.waitForURL('**/auth/admin/login**', { timeout: 10_000 });
  await expect(page.getByRole('heading', { name: /admin/i }).first()).toBeVisible();
});

test('wrong-role admin dashboard redirects a student to the marketplace', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'student');
  await page.goto('/admin/dashboard');
  await page.waitForURL('**/marketplace**', { timeout: 10_000 });
});

test('authenticated admin dashboard navigates to students without public chrome', async ({ page }) => {
  const api = await installSyntheticApi(page);
  await seedSession(page, 'admin');
  await page.route(`${apiOrigin}/api/admin/students*`, async (route) => {
    await route.fulfill({ headers, json: { success: true, data: { students: syntheticStudents, total: 1 } } });
  });
  await page.goto('/admin/dashboard');
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
  await expect(page.getByText("Don't miss the next big Awoof", { exact: false })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Social link' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Students' }).first().click();
  await page.waitForURL('**/admin/students**', { timeout: 10_000 });
  await expect(page.getByText('Synthetic Row One', { exact: true })).toBeVisible();
  await api.drainPendingHandlers();
  api.assertNoUnexpectedRequests();
});

const assuranceStudents = [
  {
    id: 'assurance-row-verified',
    userId: 'assurance-user-verified',
    name: 'Enrolled Ada',
    email: 'enrolled.ada@alpha.approved.test',
    university: 'Approved Alpha University',
    registrationNumber: 'SYN-REG-1',
    phoneNumber: null,
    status: 'active',
    verificationDate: null,
    createdAt: '2026-08-01T00:00:00Z',
    totalSpent: 12500,
    totalSavings: 2500,
    studentAssurance: {
      schoolAccountStatus: 'verified',
      schoolAccountMethod: 'email_otp',
      schoolAccountValidUntil: '2026-12-01T00:00:00.000Z',
      studentStatus: 'verified',
      enrollmentMethod: 'registration',
      studentValidUntil: '2026-11-01T00:00:00.000Z',
      reason: null,
    },
  },
  {
    id: 'assurance-row-pending',
    userId: 'assurance-user-pending',
    name: 'Mailbox Bola',
    email: 'mailbox.bola@alpha.approved.test',
    university: 'Approved Alpha University',
    registrationNumber: null,
    phoneNumber: null,
    status: 'active',
    verificationDate: null,
    createdAt: '2026-08-02T00:00:00Z',
    totalSpent: 0,
    totalSavings: 0,
    studentAssurance: {
      schoolAccountStatus: 'verified',
      schoolAccountMethod: 'email_otp',
      schoolAccountValidUntil: '2026-12-01T00:00:00.000Z',
      studentStatus: 'pending',
      enrollmentMethod: null,
      studentValidUntil: null,
      reason: 'awaiting_enrollment',
    },
  },
  {
    id: 'assurance-row-legacy',
    userId: 'assurance-user-legacy',
    name: 'Legacy Chidi',
    email: 'legacy.chidi@alpha.approved.test',
    university: null,
    registrationNumber: null,
    phoneNumber: null,
    status: 'active',
    verificationDate: null,
    createdAt: '2026-08-03T00:00:00Z',
    totalSpent: 0,
    totalSavings: 0,
  },
];

test('admin students reports school-account and student status independently (A5)', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'admin');
  await page.route(`${apiOrigin}/api/admin/students*`, async (route) => {
    await route.fulfill({ headers, json: { success: true, data: { students: assuranceStudents, total: 3 } } });
  });
  await page.goto('/admin/students');
  await expect(page.getByRole('columnheader', { name: 'School account' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Student status' })).toBeVisible();
  await expect(page.getByText('Enrolled Ada', { exact: true })).toBeVisible();
  await expect(page.getByText('Mailbox Bola', { exact: true })).toBeVisible();
  await expect(page.getByText(/Verified \(school email code\)/).first()).toBeVisible();
  await expect(page.getByText(/Verified \(school registration record\)/)).toBeVisible();
  await expect(page.getByText(/Pending — complete a current enrollment check below/)).toBeVisible();
  // A mailbox proof never reads as enrollment, and legacy rows stay blank.
  await expect(page.getByText('Legacy Chidi', { exact: true })).toBeVisible();
  await expect(page.getByText('—', { exact: true })).toHaveCount(2);
});

test('admin students table stays readable at 390px without page-level sideways scroll', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'admin');
  await page.route(`${apiOrigin}/api/admin/students*`, async (route) => {
    await route.fulfill({ headers, json: { success: true, data: { students: syntheticStudents, total: 1 } } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin/students');
  await expect(page.getByText('Synthetic Row One', { exact: true })).toBeVisible();
  await expect(page.locator('table')).toHaveCount(1);
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});
