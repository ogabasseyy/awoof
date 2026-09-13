import { expect, test, type Page } from '@playwright/test';
import { appOrigin, createGate, installSyntheticApi, seedSession, storageTabPath } from './fixtures';

const diagnosticId = '92d71887-18a0-4c0d-b696-138bc9d54f20';
const diagnosticPath = `/admin/verification-diagnostics/${diagnosticId}`;
const headers = { 'access-control-allow-origin': appOrigin };
const safeDiagnostics = {
  timeline: [
    { stage: 'started', outcome: 'success', reason: 'none', httpStatus: null, durationMs: 2, recordedAt: '2026-09-13T09:00:00.000Z' },
    { stage: 'finished', outcome: 'failure', reason: 'permission_required', httpStatus: 403, durationMs: 18, recordedAt: '2026-09-13T09:01:00.000Z' },
  ],
  aggregateWindow: 'last_30_days',
  measuredAt: '2026-09-13T10:00:00.000Z',
  windowStartedAt: '2026-08-14T10:00:00.000Z',
  aggregates: [{
    institutionId: '80dcaee5-d77e-4eb2-bc35-a54d83b5ade4',
    institutionName: 'Approved Alpha University',
    finishedAttemptCount: 1,
    averageFinishedRequestDurationMs: 18,
    p95FinishedRequestDurationMs: 18,
    incompleteAttempts: 1,
    failureCategories: [{ category: 'permission_required', eventCount: 1 }],
  }],
};

async function replaceAdminSession(other: Page) {
  await other.evaluate(() => {
    const key = 'awoof.session.v1';
    const current = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ ...current, sessionId: 'admin-b-session', accessToken: 'admin-b-access', refreshToken: 'admin-b-refresh' }));
  });
}

test('admin diagnostics shows only safe stages, a fixed bounded aggregate, and the incomplete label', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'admin');
  await page.route(`**/admin/verification-diagnostics/${diagnosticId}`, async (route) => {
    await route.fulfill({ headers, json: { success: true, data: safeDiagnostics } });
  });
  await page.goto(diagnosticPath);
  await expect(page.getByRole('heading', { name: 'Redacted verification timeline' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Attempt started' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Attempt finished' })).toBeVisible();
  await expect(page.getByText('An incomplete attempt is an expired start with no callback; it is not an enrollment denial and does not create eligibility.')).toBeVisible();
  await expect(page.getByText('Finished attempts')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Approved Alpha University' })).toBeVisible();
  await expect(page.getByText('No administrator action is required.')).toBeVisible();
  await expect(page.getByText('Review the approved institution permission and retry only after it is corrected.')).toBeVisible();
  for (const forbidden of [diagnosticId, 'student@example.invalid', 'TOKEN_CANARY', 'provider-profile']) {
    await expect(page.getByText(forbidden, { exact: false })).toHaveCount(0);
  }
});

test('admin diagnostics has a generic unavailable state for a missing correlation', async ({ page }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'admin');
  await page.route(`**/admin/verification-diagnostics/${diagnosticId}`, async (route) => {
    await route.fulfill({ status: 404, headers, json: { success: false, error: { message: 'Verification diagnostic not found' } } });
  });
  await page.goto(diagnosticPath);
  await expect(page.getByRole('heading', { name: 'Diagnostic timeline not found' })).toBeVisible();
  await expect(page.getByText('The requested diagnostic is unavailable. No student or provider details are shown.')).toBeVisible();
});

test('a delayed diagnostics response cannot populate the replacement admin session', async ({ page, context }) => {
  await installSyntheticApi(page);
  await seedSession(page, 'admin');
  const delayed = createGate();
  const replacement = createGate();
  await page.route('**/auth/me', async (route) => {
    if (route.request().headers().authorization !== 'Bearer admin-b-access') return route.fallback();
    await replacement.wait();
    await route.fulfill({ headers, json: { success: true, data: { id: 'admin-b', email: 'admin-b@approved.test', role: 'admin' } } });
  });
  await page.route(`**/admin/verification-diagnostics/${diagnosticId}`, async (route) => {
    if (route.request().headers().authorization === 'Bearer admin-b-access') {
      await route.fulfill({ status: 404, headers, json: { success: false, error: { message: 'Verification diagnostic not found' } } });
      return;
    }
    await delayed.wait();
    await route.fulfill({ headers, json: { success: true, data: safeDiagnostics } });
  });
  await page.goto(diagnosticPath);
  const other = await context.newPage();
  await other.goto(`${appOrigin}${storageTabPath}`);
  try {
    await delayed.waitForArrival();
    await replaceAdminSession(other);
    await replacement.waitForArrival();
    delayed.release();
    replacement.release();
    await expect(page.getByRole('heading', { name: 'Diagnostic timeline not found' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Attempt finished' })).toHaveCount(0);
    await expect(page.getByText('Review the approved institution permission and retry only after it is corrected.')).toHaveCount(0);
  } finally {
    delayed.release();
    replacement.release();
  }
});
