import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  appOrigin,
  createGate,
  installSessionWriteControl,
  installSyntheticApi,
  replaceSession,
  seedLegacySession,
  seedSession,
  setSessionWriteDenied,
  writeSignedOutMarker,
  type ApiFixture,
  type Gate,
} from './fixtures';

function collectBrowserFaults(page: Page): string[] {
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') faults.push(message.text());
  });
  return faults;
}

function assertCleanFixture(api: ApiFixture, faults: string[]): void {
  api.assertNoUnexpectedRequests();
  expect(faults).toEqual([]);
}

async function openStorageTab(context: BrowserContext): Promise<Page> {
  const other = await context.newPage();
  await other.goto(`${appOrigin}/favicon.ico`);
  return other;
}

async function expectSignedOutMarker(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => localStorage.getItem('awoof.session.v1'))).toContain('"state":"signed_out"');
}

async function submitStudentLogin(page: Page): Promise<void> {
  await page.getByLabel(/email/i).fill('student@approved.test');
  await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
  await page.getByRole('button', { name: /^login$/i }).click();
}

async function releaseAndAwait(gate: Gate, completion: Promise<void>): Promise<void> {
  gate.release();
  await completion.catch(() => undefined);
}

test('student login keeps a safe return destination after the submitted request completes', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page);

  await page.goto('/auth/student/login?redirect=%2Fmarketplace%3Ffrom%3Dauth-test');
  await submitStudentLogin(page);
  await api.waitForLoginCompleted(1);

  await expect(page).toHaveURL(/\/marketplace\?from=auth-test$/);
  await expect(page.getByRole('button', { name: /^logout$/i })).toBeVisible();
  expect(api.refreshCalls).toBe(0);
  assertCleanFixture(api, faults);
});

test('invalid credentials render a form error and never start refresh', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page);

  await page.goto('/auth/student/login');
  await page.getByLabel(/email/i).fill('invalid@approved.test');
  await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
  await page.getByRole('button', { name: /^login$/i }).click();
  await api.waitForLoginCompleted(1);

  await expect(page.getByText(/invalid credentials/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /^login$/i })).toBeEnabled();
  await expect(page).toHaveURL(/\/auth\/student\/login$/);
  expect(api.refreshCalls).toBe(0);
  assertCleanFixture(api, faults);
});

test('storage denial renders login failure without authenticated navigation', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function denySessionEnvelope(key: string, value: string): void {
      if (key === 'awoof.session.v1') throw new DOMException('Denied', 'SecurityError');
      original.call(this, key, value);
    };
  });
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page);

  await page.goto('/auth/student/login');
  await submitStudentLogin(page);
  await api.waitForLoginCompleted(1);

  await expect(page.getByText(/login failed/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /^login$/i })).toBeEnabled();
  await expect(page).toHaveURL(/\/auth\/student\/login$/);
  expect(api.meCalls).toBe(0);
  assertCleanFixture(api, faults);
});

test('legacy credentials initialize through current-user authority and render the student profile', async ({ page }) => {
  await seedLegacySession(page, 'student');
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page);

  await page.goto('/student/profile');
  await api.waitForCurrentUserCompleted(1);

  await expect(page.getByText('student@approved.test', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/student\/profile$/);
  assertCleanFixture(api, faults);
});

test('a JWT-looking stored token with failing current-user authority never exposes protected content', async ({ page }) => {
  await seedSession(page, 'student', {
    accessToken: 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6InN0dWRlbnRAYXBwcm92ZWQudGVzdCIsInJvbGUiOiJzdHVkZW50In0.',
    refreshToken: 'jwt-looking-refresh',
  });
  const api = await installSyntheticApi(page, { failCurrentUser: true });
  const faults = collectBrowserFaults(page);

  await page.goto('/student/profile');
  await api.waitForCurrentUserCompleted(1);

  await expect(page.getByText('student@approved.test', { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/auth\/student\/login/);
  assertCleanFixture(api, faults);
});

test('a successful terminal 401 on an auth page reaches durable signed-out UI state', async ({ page }) => {
  const firstCurrentUser = createGate('first terminal-current-user response');
  await seedSession(page, 'student');
  await installSessionWriteControl(page);
  const api = await installSyntheticApi(page, {
    meGate: firstCurrentUser,
    delayCurrentUserOrdinals: [1],
    unauthorizedCurrentUserCalls: 2,
  });
  const faults = collectBrowserFaults(page);

  try {
    await page.goto('/auth/student/login', { waitUntil: 'domcontentloaded' });
    await api.waitForCurrentUserStarted(1);
    firstCurrentUser.release();
    await api.waitForCurrentUserCompleted(1);
    await api.waitForRefreshCompleted(1);
    await api.waitForCurrentUserCompleted(2);

    await expectSignedOutMarker(page);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByLabel(/email/i)).toBeVisible();
    assertCleanFixture(api, faults);
  } finally {
    await releaseAndAwait(firstCurrentUser, api.waitForCurrentUserCompleted(1));
  }
});

test('failed clear remains visible until Retry sign out durably clears it', async ({ page }) => {
  const firstCurrentUser = createGate('failed-clear first current-user response');
  await seedSession(page, 'student');
  await installSessionWriteControl(page);
  const api = await installSyntheticApi(page, {
    meGate: firstCurrentUser,
    delayCurrentUserOrdinals: [1],
    unauthorizedCurrentUserCalls: 2,
  });
  const faults = collectBrowserFaults(page);

  try {
    await page.goto('/auth/student/login', { waitUntil: 'domcontentloaded' });
    await api.waitForCurrentUserStarted(1);
    await setSessionWriteDenied(page, true);
    firstCurrentUser.release();
    await api.waitForCurrentUserCompleted(1);
    await api.waitForRefreshCompleted(1);
    await api.waitForCurrentUserCompleted(2);

    await expect(page.getByRole('alert')).toContainText(/could not save your signed-out state/i);
    await setSessionWriteDenied(page, false);
    await page.evaluate(() => localStorage.getItem('awoof.session.v1'));
    await expect(page.getByRole('alert')).toContainText(/could not save your signed-out state/i);

    await page.getByRole('button', { name: /retry sign out/i }).click();
    await expect(page).toHaveURL(/\/$/);
    await expectSignedOutMarker(page);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^login$/i })).toBeVisible();
    assertCleanFixture(api, faults);
  } finally {
    await releaseAndAwait(firstCurrentUser, api.waitForCurrentUserCompleted(1));
  }
});

test('cross-tab signed-out state removes rendered student content after it was established', async ({ page, context }) => {
  await seedSession(page, 'student');
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page);
  const other = await openStorageTab(context);

  await page.goto('/student/profile');
  await api.waitForCurrentUserCompleted(1);
  await expect(page.getByText('student@approved.test', { exact: true })).toBeVisible();
  await writeSignedOutMarker(other);

  await expect(page.getByText('student@approved.test', { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/auth\/student\/login/);
  assertCleanFixture(api, faults);
});

test('rendered student A disappears while vendor B is pending, then the role guard routes B', async ({ page, context }) => {
  const replacementGate = createGate('vendor replacement current-user response');
  await seedSession(page, 'student');
  const api = await installSyntheticApi(page, {
    meGate: replacementGate,
    delayCurrentUserOrdinals: [2],
  });
  const faults = collectBrowserFaults(page);
  const other = await openStorageTab(context);

  try {
    await page.goto('/student/profile');
    await api.waitForCurrentUserCompleted(1);
    await expect(page.getByText('student@approved.test', { exact: true })).toBeVisible();

    await replaceSession(other, 'vendor', 'replacement-vendor-session');
    await api.waitForCurrentUserStarted(2);
    expect(api.requests.find((request) => request.endpoint === 'current-user' && request.ordinal === 2)?.responseIdentity).toBe('vendor');
    await expect(page.getByText('student@approved.test', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/^loading\.\.\.$/i)).toBeVisible();

    replacementGate.release();
    await api.waitForCurrentUserCompleted(2);
    await expect(page).toHaveURL(/\/vendor\/dashboard$/);
    await expect(page.getByText('vendor@approved.test', { exact: true })).toBeVisible();
    assertCleanFixture(api, faults);
  } finally {
    await releaseAndAwait(replacementGate, api.waitForCurrentUserCompleted(2));
  }
});

test('logout while refresh is pending cannot reauthenticate the rendered student page', async ({ page, context }) => {
  const refreshGate = createGate('student refresh response');
  await seedSession(page, 'student');
  const api = await installSyntheticApi(page, {
    unauthorizedCurrentUserCalls: 1,
    refreshGate,
  });
  const faults = collectBrowserFaults(page);
  const other = await openStorageTab(context);

  try {
    await page.goto('/student/profile', { waitUntil: 'domcontentloaded' });
    await api.waitForCurrentUserCompleted(1);
    await api.waitForRefreshStarted(1);
    await writeSignedOutMarker(other);
    await expect(page.getByText('student@approved.test', { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/\/auth\/student\/login/);

    refreshGate.release();
    await api.waitForRefreshCompleted(1);
    await expectSignedOutMarker(page);
    await expect(page.getByText('student@approved.test', { exact: true })).toHaveCount(0);
    assertCleanFixture(api, faults);
  } finally {
    await releaseAndAwait(refreshGate, api.waitForRefreshCompleted(1));
  }
});

test('external replacement wins a pending public login without inventing an auth-page redirect', async ({ page, context }) => {
  const loginGate = createGate('pending student login');
  const api = await installSyntheticApi(page, { loginGate });
  const faults = collectBrowserFaults(page);
  const other = await openStorageTab(context);

  try {
    await page.goto('/auth/student/login');
    await submitStudentLogin(page);
    await api.waitForLoginStarted(1);
    await replaceSession(other, 'vendor', 'external-login-replacement');
    await api.waitForCurrentUserCompleted(1);
    loginGate.release();
    await api.waitForLoginCompleted(1);

    await expect(page.getByRole('button', { name: /^login$/i })).toBeEnabled();
    await expect(page).toHaveURL(/\/auth\/student\/login$/);
    await expect(page).not.toHaveURL(/\/marketplace/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('awoof.session.v1'))).toContain('"accessToken":"vendor-access"');

    await page.goto('/student/profile');
    await api.waitForCurrentUserCompleted(2);
    await expect(page).toHaveURL(/\/vendor\/dashboard$/);
    await expect(page.getByText('vendor@approved.test', { exact: true })).toBeVisible();
    assertCleanFixture(api, faults);
  } finally {
    await releaseAndAwait(loginGate, api.waitForLoginCompleted(1));
  }
});

test('logout after a pending login starts leaves its form enabled and its stale destination absent', async ({ page, context }) => {
  const loginGate = createGate('pending login then logout');
  const api = await installSyntheticApi(page, { loginGate });
  const faults = collectBrowserFaults(page);
  const other = await openStorageTab(context);

  try {
    await page.goto('/auth/student/login');
    await submitStudentLogin(page);
    await api.waitForLoginStarted(1);
    await writeSignedOutMarker(other);
    loginGate.release();
    await api.waitForLoginCompleted(1);

    await expect(page).toHaveURL(/\/auth\/student\/login$/);
    await expect(page).not.toHaveURL(/\/marketplace/);
    await expect(page.getByRole('button', { name: /^login$/i })).toBeEnabled();
    await expectSignedOutMarker(page);
    assertCleanFixture(api, faults);
  } finally {
    await releaseAndAwait(loginGate, api.waitForLoginCompleted(1));
  }
});

test('a pending login reconciles a same-page replacement before its completion can navigate', async ({ page }) => {
  const loginGate = createGate('same-page replacement pending login');
  const api = await installSyntheticApi(page, { loginGate });
  const faults = collectBrowserFaults(page);

  try {
    await page.goto('/auth/student/login');
    await submitStudentLogin(page);
    await api.waitForLoginStarted(1);
    await replaceSession(page, 'vendor', 'same-page-replacement');
    loginGate.release();
    await api.waitForLoginCompleted(1);
    await api.waitForCurrentUserCompleted(1);

    await expect(page.getByRole('button', { name: /^login$/i })).toBeEnabled();
    await expect(page).toHaveURL(/\/auth\/student\/login$/);
    await expect(page).not.toHaveURL(/\/marketplace/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('awoof.session.v1'))).toContain('"accessToken":"vendor-access"');

    await page.goto('/student/profile');
    await api.waitForCurrentUserCompleted(2);
    await expect(page).toHaveURL(/\/vendor\/dashboard$/);
    assertCleanFixture(api, faults);
  } finally {
    await releaseAndAwait(loginGate, api.waitForLoginCompleted(1));
  }
});

test('vendor registration keeps email-verification onboarding after all modeled downstream calls finish', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page);

  await page.goto('/auth/vendor/register');
  await page.getByLabel(/company.?s name/i).fill('Approved Test Vendor');
  await page.getByLabel(/company.?s email/i).fill('vendor@approved.test');
  await page.getByLabel(/full name/i).fill('Approved Vendor');
  await page.getByLabel(/phone number/i).fill('08000000000');
  await page.getByRole('button', { name: /^continue$/i }).click();
  await page.getByLabel(/business category/i).selectOption('electronics');
  await page.getByLabel(/business website/i).fill('https://approved.test');
  await page.getByLabel(/^password$/i).fill('Synthetic-Password1!');
  await page.getByLabel(/confirm password/i).fill('Synthetic-Password1!');
  await page.getByRole('button', { name: /^continue$/i }).click();
  await page.locator('input[type="file"]').nth(2).setInputFiles({
    name: 'approved-logo.png',
    mimeType: 'image/png',
    buffer: Buffer.from('synthetic logo'),
  });
  await page.getByRole('button', { name: /^continue$/i }).click();
  await api.waitForVendorRegistrationCompleted();
  await api.waitForVendorUploadCompleted();
  await api.waitForCurrentUserCompleted(1);

  await expect(page).toHaveURL(/\/auth\/vendor\/verify-email\?email=vendor%40approved\.test$/);
  await expect(page).not.toHaveURL(/\/vendor\/dashboard/);
  assertCleanFixture(api, faults);
});

for (const scenario of [
  { role: 'vendor', login: '/auth/vendor/login', destination: '/vendor/dashboard' },
  { role: 'admin', login: '/auth/admin/login', destination: '/admin/dashboard' },
] as const) {
  test(`${scenario.role} login reaches only its own rendered destination`, async ({ page }) => {
    const api = await installSyntheticApi(page);
    const faults = collectBrowserFaults(page);

    await page.goto(scenario.login);
    await page.getByLabel(/email/i).fill(`${scenario.role}@approved.test`);
    await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
    await page.getByRole('button', { name: /^login$/i }).click();
    await api.waitForLoginCompleted(1);
    await api.waitForCurrentUserCompleted(1);

    await expect(page).toHaveURL(new RegExp(`${scenario.destination}$`));
    await expect(page.getByText(`${scenario.role}@approved.test`, { exact: true })).toBeVisible();
    assertCleanFixture(api, faults);
  });
}

test.describe('mobile keyboard login', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('submits from the password field and renders the safe return destination', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const faults = collectBrowserFaults(page);

    await page.goto('/auth/student/login?redirect=%2Fmarketplace%3Ffrom%3Dmobile');
    await page.getByLabel(/email/i).fill('student@approved.test');
    await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
    await page.getByLabel(/^password/i).press('Enter');
    await api.waitForLoginCompleted(1);

    await expect(page).toHaveURL(/\/marketplace\?from=mobile$/);
    await expect(page.getByRole('button', { name: /^logout$/i })).toBeVisible();
    assertCleanFixture(api, faults);
  });
});
