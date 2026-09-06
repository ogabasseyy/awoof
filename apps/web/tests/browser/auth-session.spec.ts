import { expect, test, type BrowserContext, type ConsoleMessage, type Page } from '@playwright/test';
import {
  apiOrigin,
  appOrigin,
  createGate,
  installSessionWriteControl,
  installSyntheticApi,
  replaceSession,
  seedLegacySession,
  seedSession,
  setSignedOutMarkerWriteDenied,
  storageTabPath,
  writeSignedOutMarker,
  type ApiFixture,
  type Gate,
} from './fixtures';

function isExpectedSyntheticHttpFailure(message: ConsoleMessage, api: ApiFixture): boolean {
  const status = /^Failed to load resource: the server responded with a status of (\d{3})\b/.exec(message.text())?.[1];
  const location = message.location().url;
  if (!status || !location) return false;

  try {
    const url = new URL(location);
    if (url.origin !== apiOrigin) return false;
    const path = url.pathname.replace(/^\/api/, '');
    return api.syntheticHttpFailures.some((failure) => failure.path === path && failure.status === Number(status));
  } catch {
    return false;
  }
}

function collectBrowserFaults(page: Page, api: ApiFixture): string[] {
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error' || isExpectedSyntheticHttpFailure(message, api)) return;
    const location = message.location().url;
    faults.push(location ? `${message.text()} (${location})` : message.text());
  });
  return faults;
}

async function assertCleanFixture(api: ApiFixture, faults: string[]): Promise<void> {
  await api.drainPendingHandlers();
  api.assertNoUnexpectedRequests();
  expect(faults).toEqual([]);
}

async function openStorageTab(context: BrowserContext): Promise<Page> {
  const other = await context.newPage();
  await other.goto(`${appOrigin}${storageTabPath}`);
  return other;
}

function storageFailureAlert(page: Page) {
  return page.getByRole('alert').filter({ hasText: /could not save your signed-out state/i });
}

async function expectStudentMarketplaceIdentity(page: Page): Promise<void> {
  await expect(page.getByRole('link', { name: /^open profile$/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /hey student, savings are warming up/i })).toBeVisible();
}

async function expectSignedOutMarker(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => localStorage.getItem('awoof.session.v1'))).toContain('"state":"signed_out"');
}

async function submitStudentLogin(page: Page): Promise<void> {
  await page.getByLabel(/email/i).fill('student@approved.test');
  await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
  await page.getByRole('button', { name: /^login$/i }).click();
}

async function releaseAndDrain(gate: Gate, api: ApiFixture): Promise<void> {
  gate.release();
  await api.drainPendingHandlers();
  api.assertNoUnexpectedRequests();
}

test('student login keeps a safe return destination after the submitted request completes', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page, api);

  await page.goto('/auth/student/login?redirect=%2Fmarketplace%3Ffrom%3Dauth-test');
  await submitStudentLogin(page);
  await api.waitForLoginCompleted(1);

  await expect(page).toHaveURL(/\/marketplace\?from=auth-test$/);
  await expectStudentMarketplaceIdentity(page);
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

test('invalid credentials render a form error and never start refresh', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page, api);

  await page.goto('/auth/student/login');
  await page.getByLabel(/email/i).fill('invalid@approved.test');
  await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
  await page.getByRole('button', { name: /^login$/i }).click();
  await api.waitForLoginCompleted(1);

  await expect(page.getByText(/invalid credentials/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /^login$/i })).toBeEnabled();
  await expect(page).toHaveURL(/\/auth\/student\/login$/);
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api, faults);
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
  const faults = collectBrowserFaults(page, api);

  await page.goto('/auth/student/login');
  await submitStudentLogin(page);
  await api.waitForLoginCompleted(1);

  await expect(page.getByText(/login failed/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /^login$/i })).toBeEnabled();
  await expect(page).toHaveURL(/\/auth\/student\/login$/);
  expect(api.meCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

test('legacy credentials initialize through current-user authority and render the student profile', async ({ page }) => {
  await seedLegacySession(page, 'student');
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page, api);

  await page.goto('/student/profile');
  await api.waitForCurrentUserCompleted(1);

  await expect(page.getByText('student@approved.test', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/student\/profile$/);
  await assertCleanFixture(api, faults);
});

test('a JWT-looking stored token with failing current-user authority never exposes protected content', async ({ page }) => {
  await seedSession(page, 'student', {
    accessToken: 'eyJhbGciOiJub25lIn0.eyJ1c2VySWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJlbWFpbCI6InN0dWRlbnRAYXBwcm92ZWQudGVzdCIsInJvbGUiOiJzdHVkZW50In0.',
    refreshToken: 'jwt-looking-refresh',
  });
  const api = await installSyntheticApi(page, { failCurrentUser: true });
  const faults = collectBrowserFaults(page, api);

  await page.goto('/student/profile');
  await api.waitForCurrentUserCompleted(1);

  await expect(page.getByText('student@approved.test', { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/auth\/student\/login/);
  await assertCleanFixture(api, faults);
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
  const faults = collectBrowserFaults(page, api);

  try {
    await page.goto('/auth/student/login', { waitUntil: 'domcontentloaded' });
    await api.waitForCurrentUserStarted(1);
    firstCurrentUser.release();
    await api.waitForCurrentUserCompleted(1);
    await api.waitForRefreshCompleted(1);
    await api.waitForCurrentUserCompleted(2);

    await expectSignedOutMarker(page);
    await expect(storageFailureAlert(page)).toHaveCount(0);
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await assertCleanFixture(api, faults);
  } finally {
    await releaseAndDrain(firstCurrentUser, api);
  }
});

test('failed clear remains visible until Retry sign out durably clears it', async ({ page }) => {
  const retryCurrentUser = createGate('failed-clear retry current-user response');
  await seedSession(page, 'student');
  await installSessionWriteControl(page);
  const api = await installSyntheticApi(page, {
    meGate: retryCurrentUser,
    delayCurrentUserOrdinals: [2],
    unauthorizedCurrentUserCalls: 2,
  });
  const faults = collectBrowserFaults(page, api);

  try {
    await page.goto('/auth/student/login', { waitUntil: 'domcontentloaded' });
    await api.waitForCurrentUserStarted(1);
    await api.waitForCurrentUserCompleted(1);
    await api.waitForRefreshCompleted(1);
    await api.waitForCurrentUserStarted(2);
    // The refresh has already persisted its active envelope because this retry
    // cannot dispatch until refresh completion. Deny only the terminal
    // signed-out marker write that follows this second unauthorized response.
    await setSignedOutMarkerWriteDenied(page, true);
    retryCurrentUser.release();
    await api.waitForCurrentUserCompleted(2);

    await expect(storageFailureAlert(page)).toBeVisible();
    await setSignedOutMarkerWriteDenied(page, false);
    await page.evaluate(() => localStorage.getItem('awoof.session.v1'));
    await expect(storageFailureAlert(page)).toBeVisible();

    await page.getByRole('button', { name: /retry sign out/i }).click();
    await expect(page).toHaveURL(/\/$/);
    await expectSignedOutMarker(page);
    await expect(storageFailureAlert(page)).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^login$/i })).toBeVisible();
    await assertCleanFixture(api, faults);
  } finally {
    await releaseAndDrain(retryCurrentUser, api);
  }
});

test('cross-tab signed-out state removes rendered student content after it was established', async ({ page, context }) => {
  await seedSession(page, 'student');
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page, api);
  const other = await openStorageTab(context);

  await page.goto('/student/profile');
  await api.waitForCurrentUserCompleted(1);
  await expect(page.getByText('student@approved.test', { exact: true })).toBeVisible();
  await writeSignedOutMarker(other);

  await expect(page.getByText('student@approved.test', { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/auth\/student\/login/);
  await assertCleanFixture(api, faults);
});

test('rendered student A disappears while vendor B is pending, then the role guard routes B', async ({ page, context }) => {
  const replacementGate = createGate('vendor replacement current-user response');
  await seedSession(page, 'student');
  const api = await installSyntheticApi(page, {
    meGate: replacementGate,
    delayCurrentUserOrdinals: [2],
  });
  const faults = collectBrowserFaults(page, api);
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
    await assertCleanFixture(api, faults);
  } finally {
    await releaseAndDrain(replacementGate, api);
  }
});

test('logout while refresh is pending cannot reauthenticate the rendered student page', async ({ page, context }) => {
  const refreshGate = createGate('student refresh response');
  await seedSession(page, 'student');
  const api = await installSyntheticApi(page, {
    unauthorizedCurrentUserCalls: 1,
    refreshGate,
  });
  const faults = collectBrowserFaults(page, api);
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
    // This is not route.fulfill completion: the fixture waits for the exact
    // browser XHR loadend signal after Axios response settlement, microtasks,
    // and one browser frame before checking the final no-stale-effects state.
    await api.waitForRefreshContinuation(1);
    await expectSignedOutMarker(page);
    await expect(page.getByText('student@approved.test', { exact: true })).toHaveCount(0);
    await assertCleanFixture(api, faults);
  } finally {
    await releaseAndDrain(refreshGate, api);
  }
});

test('external replacement wins a pending public login without inventing an auth-page redirect', async ({ page, context }) => {
  const loginGate = createGate('pending student login');
  const api = await installSyntheticApi(page, { loginGate });
  const faults = collectBrowserFaults(page, api);
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
    await assertCleanFixture(api, faults);
  } finally {
    await releaseAndDrain(loginGate, api);
  }
});

test('a real active-session logout invalidates a pending login before its stale completion can navigate', async ({ page: activePage, context }) => {
  const loginGate = createGate('pending login then logout');
  await seedSession(activePage, 'vendor');
  const api = await installSyntheticApi(activePage, { loginGate });
  const activeFaults = collectBrowserFaults(activePage, api);
  const pendingPage = await context.newPage();
  const pendingFaults = collectBrowserFaults(pendingPage, api);

  try {
    await activePage.goto('/vendor/orders');
    await api.waitForCurrentUserCompleted(1);
    await expect(activePage.getByRole('button', { name: /^log out$/i }).first()).toBeVisible();

    await pendingPage.goto('/auth/student/login');
    await api.waitForCurrentUserCompleted(2);
    await submitStudentLogin(pendingPage);
    await api.waitForLoginStarted(1);

    // This is the rendered vendor dashboard's real AuthProvider.logout path,
    // not a synthetic signed-out marker written into an initially signed-out tab.
    await activePage.getByRole('button', { name: /^log out$/i }).first().click();
    await expect.poll(() => api.logoutCalls).toBe(1);
    await expect(activePage).toHaveURL(/\/auth\/vendor\/login$/);
    await expectSignedOutMarker(pendingPage);

    loginGate.release();
    await api.waitForLoginCompleted(1);

    await expect(pendingPage).toHaveURL(/\/auth\/student\/login$/);
    await expect(pendingPage).not.toHaveURL(/\/marketplace/);
    await expect(pendingPage.getByRole('button', { name: /^login$/i })).toBeEnabled();
    await expectSignedOutMarker(pendingPage);
    await assertCleanFixture(api, [...activeFaults, ...pendingFaults]);
  } finally {
    await releaseAndDrain(loginGate, api);
  }
});

test('a pending login reconciles a same-page replacement before its completion can navigate', async ({ page }) => {
  const loginGate = createGate('same-page replacement pending login');
  const api = await installSyntheticApi(page, { loginGate });
  const faults = collectBrowserFaults(page, api);

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
    await assertCleanFixture(api, faults);
  } finally {
    await releaseAndDrain(loginGate, api);
  }
});

test('vendor registration keeps email-verification onboarding after all modeled downstream calls finish', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page, api);

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
  await assertCleanFixture(api, faults);
});

for (const scenario of [
  {
    role: 'vendor',
    login: '/auth/vendor/login',
    destination: '/vendor/dashboard',
    greeting: /hey there, here’s your storefront/i,
    userControl: /vendor@approved\.test vendor/i,
  },
  {
    role: 'admin',
    login: '/auth/admin/login',
    destination: '/admin/dashboard',
    greeting: /hey admin, here’s the pulse/i,
    userControl: /admin admin/i,
  },
] as const) {
  test(`${scenario.role} login reaches only its own rendered destination`, async ({ page }) => {
    const api = await installSyntheticApi(page);
    const faults = collectBrowserFaults(page, api);

    await page.goto(scenario.login);
    await page.getByLabel(/email/i).fill(`${scenario.role}@approved.test`);
    await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
    await page.getByRole('button', { name: /^login$/i }).click();
    await api.waitForLoginCompleted(1);
    await api.waitForCurrentUserCompleted(1);

    await expect(page).toHaveURL(new RegExp(`${scenario.destination}$`));
    await expect(page.getByRole('heading', { name: scenario.greeting })).toBeVisible();
    await expect(page.getByRole('button', { name: scenario.userControl })).toBeVisible();
    await assertCleanFixture(api, faults);
  });
}

test.describe('mobile keyboard login', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('submits from the password field and renders the safe return destination', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const faults = collectBrowserFaults(page, api);

    await page.goto('/auth/student/login?redirect=%2Fmarketplace%3Ffrom%3Dmobile');
    await page.getByLabel(/email/i).fill('student@approved.test');
    await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
    await page.getByLabel(/^password/i).press('Enter');
    await api.waitForLoginCompleted(1);

    await expect(page).toHaveURL(/\/marketplace\?from=mobile$/);
    await expectStudentMarketplaceIdentity(page);
    await assertCleanFixture(api, faults);
  });
});
