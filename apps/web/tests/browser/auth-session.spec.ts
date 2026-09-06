import { expect, test, type Page } from '@playwright/test';
import {
  createGate,
  installSessionWriteControl,
  installSyntheticApi,
  replaceSession,
  seedSession,
  setSessionWriteDenied,
  writeSignedOutMarker,
} from './fixtures';

function collectBrowserFaults(page: Page): string[] {
  const faults: string[] = [];
  page.on('pageerror', (error) => faults.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') faults.push(message.text());
  });
  return faults;
}

async function expectActiveRole(page: Page, role: 'student' | 'vendor' | 'admin'): Promise<void> {
  await expect.poll(() => page.evaluate(() => localStorage.getItem('awoof.session.v1'))).toContain(`"accessToken":"${role}-access"`);
}

test('student login keeps a safe return destination', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page);

  await page.goto('/auth/student/login?redirect=%2Fmarketplace%3Ffrom%3Dauth-test');
  await page.getByLabel(/email/i).fill('student@approved.test');
  await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
  await page.getByRole('button', { name: /^login$/i }).click();

  await expect(page).toHaveURL(/\/marketplace\?from=auth-test$/);
  expect(api.loginCalls).toBe(1);
  expect(api.refreshCalls).toBe(0);
  expect(faults).toEqual([]);
});

test('invalid credentials stay local and never start refresh', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page);

  await page.goto('/auth/student/login');
  await page.getByLabel(/email/i).fill('invalid@approved.test');
  await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
  await page.getByRole('button', { name: /^login$/i }).click();

  await expect(page.getByText(/invalid credentials/i)).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/student\/login$/);
  expect(api.refreshCalls).toBe(0);
  expect(faults).toEqual([]);
});

test('storage denial never creates an authenticated navigation', async ({ page }) => {
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
  await page.getByLabel(/email/i).fill('student@approved.test');
  await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
  await page.getByRole('button', { name: /^login$/i }).click();

  await expect(page).toHaveURL(/\/auth\/student\/login$/);
  expect(api.meCalls).toBe(0);
  expect(faults).toEqual([]);
});

test('a failing current-user response never exposes a seeded account', async ({ page }) => {
  await seedSession(page, 'student');
  await installSyntheticApi(page, { failCurrentUser: true });
  const faults = collectBrowserFaults(page);

  await page.goto('/student/profile');

  await expect(page).toHaveURL(/\/auth\/student\/login/);
  await expect(page.getByText(/student profile/i)).toHaveCount(0);
  expect(faults).toEqual([]);
});

test('a successful terminal 401 on an auth page clears provider warning and pending state', async ({ page }) => {
  const firstCurrentUser = createGate();
  await seedSession(page, 'student');
  await installSessionWriteControl(page);
  const api = await installSyntheticApi(page, {
    meGate: firstCurrentUser,
    delayCurrentUserCalls: 1,
    unauthorizedCurrentUserCalls: 2,
  });
  const faults = collectBrowserFaults(page);

  try {
    await page.goto('/auth/student/login', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => api.meCalls).toBe(1);
    firstCurrentUser.release();

    await expect.poll(() => api.refreshCalls).toBe(1);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(/^loading\.\.\.$/i)).toHaveCount(0);
    await expect(page.getByLabel(/email/i)).toBeVisible();
    expect(faults).toEqual([]);
  } finally {
    firstCurrentUser.release();
  }
});

test('a failed clear stays quarantined after storage recovery until Retry sign out succeeds', async ({ page }) => {
  const firstCurrentUser = createGate();
  await seedSession(page, 'student');
  await installSessionWriteControl(page);
  const api = await installSyntheticApi(page, {
    meGate: firstCurrentUser,
    delayCurrentUserCalls: 1,
    unauthorizedCurrentUserCalls: 2,
  });
  const faults = collectBrowserFaults(page);

  try {
    await page.goto('/auth/student/login', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => api.meCalls).toBe(1);
    await setSessionWriteDenied(page, true);
    firstCurrentUser.release();

    await expect.poll(() => api.refreshCalls).toBe(1);
    await expect(page.getByRole('alert')).toContainText(/could not save your signed-out state/i);
    await expect(page.getByRole('button', { name: /retry sign out/i })).toBeVisible();

    await setSessionWriteDenied(page, false);
    await page.evaluate(() => localStorage.getItem('awoof.session.v1'));
    await expect(page.getByRole('alert')).toContainText(/could not save your signed-out state/i);

    await page.getByRole('button', { name: /retry sign out/i }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^login$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^logout$/i })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('awoof.session.v1'))).toContain('"state":"signed_out"');
    expect(faults).toEqual([]);
  } finally {
    firstCurrentUser.release();
  }
});

test('cross-tab signed-out state removes protected student content', async ({ page, context }) => {
  await seedSession(page, 'student');
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page);
  const other = await context.newPage();

  await page.goto('/student/profile');
  await expect(page).toHaveURL(/\/student\/profile/);
  await other.goto('/auth/student/login');
  await writeSignedOutMarker(other);

  await expect(page).toHaveURL(/\/auth\/student\/login/);
  expect(api.meCalls).toBeGreaterThan(0);
  expect(faults).toEqual([]);
});

test('a delayed current-user response cannot resurrect the previous account after replacement', async ({ page, context }) => {
  const gate = createGate();
  await seedSession(page, 'student');
  const api = await installSyntheticApi(page, { meGate: gate, delayCurrentUserCalls: 1 });
  const faults = collectBrowserFaults(page);
  const other = await context.newPage();

  try {
    await page.goto('/student/profile', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => api.meCalls).toBeGreaterThan(0);
    await other.goto('/auth/student/login');
    await replaceSession(other, 'vendor', 'replacement-vendor-session');

    await expect(page).toHaveURL(/\/vendor\/dashboard/);
    gate.release();

    await expect(page).not.toHaveURL(/\/student\/profile/);
    expect(faults).toEqual([]);
  } finally {
    gate.release();
  }
});

test('logout while refresh is pending cannot reauthenticate the tab', async ({ page, context }) => {
  const refreshGate = createGate();
  await seedSession(page, 'student');
  const api = await installSyntheticApi(page, {
    unauthorizedCurrentUserCalls: 1,
    refreshGate,
  });
  const faults = collectBrowserFaults(page);
  const other = await context.newPage();

  try {
    await page.goto('/student/profile', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => api.refreshCalls).toBe(1);
    await other.goto('/auth/student/login');
    await writeSignedOutMarker(other);
    await expect(page).toHaveURL(/\/auth\/student\/login/);

    refreshGate.release();
    await expect(page).toHaveURL(/\/auth\/student\/login/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('awoof.session.v1'))).toContain('"state":"signed_out"');
    expect(faults).toEqual([]);
  } finally {
    refreshGate.release();
  }
});

test('an external replacement during pending login wins over the old completion', async ({ page, context }) => {
  const loginGate = createGate();
  const api = await installSyntheticApi(page, { loginGate });
  const faults = collectBrowserFaults(page);
  const other = await context.newPage();

  try {
    await page.goto('/auth/student/login');
    await page.getByLabel(/email/i).fill('student@approved.test');
    await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
    await page.getByRole('button', { name: /^login$/i }).click();
    await expect.poll(() => api.loginCalls).toBe(1);

    await other.goto('/auth/student/login');
    await replaceSession(other, 'vendor', 'external-login-replacement');
    loginGate.release();

    await expect(page).toHaveURL(/\/vendor\/dashboard/);
    await expectActiveRole(page, 'vendor');
    expect(faults).toEqual([]);
  } finally {
    loginGate.release();
  }
});

test('logout after login starts prevents the old login from restoring a session', async ({ page, context }) => {
  const loginGate = createGate();
  const api = await installSyntheticApi(page, { loginGate });
  const faults = collectBrowserFaults(page);
  const other = await context.newPage();

  try {
    await page.goto('/auth/student/login');
    await page.getByLabel(/email/i).fill('student@approved.test');
    await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
    await page.getByRole('button', { name: /^login$/i }).click();
    await expect.poll(() => api.loginCalls).toBe(1);

    await other.goto('/auth/student/login');
    await writeSignedOutMarker(other);
    loginGate.release();

    await expect(page).toHaveURL(/\/auth\/student\/login/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('awoof.session.v1'))).toContain('"state":"signed_out"');
    expect(faults).toEqual([]);
  } finally {
    loginGate.release();
  }
});

test('a completion observes a same-page replacement even before a storage event is delivered', async ({ page }) => {
  const loginGate = createGate();
  const api = await installSyntheticApi(page, { loginGate });
  const faults = collectBrowserFaults(page);

  try {
    await page.goto('/auth/student/login');
    await page.getByLabel(/email/i).fill('student@approved.test');
    await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
    await page.getByRole('button', { name: /^login$/i }).click();
    await expect.poll(() => api.loginCalls).toBe(1);

    // Same-document writes intentionally do not dispatch StorageEvent. The
    // completion must reconcile localStorage itself before it commits.
    await replaceSession(page, 'vendor', 'same-page-replacement');
    loginGate.release();

    await expect(page).toHaveURL(/\/vendor\/dashboard/);
    await expectActiveRole(page, 'vendor');
    expect(faults).toEqual([]);
  } finally {
    loginGate.release();
  }
});

test('vendor registration retains email-verification onboarding instead of navigating to a dashboard', async ({ page }) => {
  await installSyntheticApi(page);
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

  await expect(page).toHaveURL(/\/auth\/vendor\/verify-email\?email=vendor%40approved\.test$/);
  await expect(page).not.toHaveURL(/\/vendor\/dashboard/);
  expect(faults).toEqual([]);
});

for (const scenario of [
  { role: 'vendor', login: '/auth/vendor/login', destination: '/vendor/dashboard' },
  { role: 'admin', login: '/auth/admin/login', destination: '/admin/dashboard' },
] as const) {
  test(`${scenario.role} login reaches only its own role destination`, async ({ page }) => {
    await installSyntheticApi(page);

    await page.goto(scenario.login);
    await page.getByLabel(/email/i).fill(`${scenario.role}@approved.test`);
    await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
    await page.getByRole('button', { name: /^login$/i }).click();

    await expect(page).toHaveURL(new RegExp(`${scenario.destination}$`));
    await expectActiveRole(page, scenario.role);
  });
}

test.describe('mobile keyboard login', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('submits from the password field without losing a safe return path', async ({ page }) => {
    await installSyntheticApi(page);
    const faults = collectBrowserFaults(page);

    await page.goto('/auth/student/login?redirect=%2Fmarketplace%3Ffrom%3Dmobile');
    await page.getByLabel(/email/i).fill('student@approved.test');
    await page.getByLabel(/^password/i).fill('Synthetic-Password1!');
    await page.getByLabel(/^password/i).press('Enter');

    await expect(page).toHaveURL(/\/marketplace\?from=mobile$/);
    expect(faults).toEqual([]);
  });
});
