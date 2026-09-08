import { expect, test, type Page } from '@playwright/test';
import { assertCleanFixture, collectBrowserFaults } from './browser-assertions';
import {
  appOrigin,
  createGate,
  fixtureUniversities,
  installSessionReadControl,
  installSessionStorageEventSuppression,
  installSessionWriteControl,
  installSyntheticApi,
  replaceSession,
  seedSession,
  setActiveSessionWriteDenied,
  storageTabPath,
  studentSignupTestData,
  writeTaggedSignedOutAction,
  writeUnobservedActiveThenTaggedSignedOutAction,
} from './fixtures';

const {
  notice,
  replacementNotice,
  name,
  changedName,
  email,
  changedEmail,
  betaEmail,
  matricNumber,
  password,
  otp: validOtp,
  invalidOtps,
  challengeId,
  replacementChallengeId,
  accountId,
  accessToken,
  refreshToken,
} = studentSignupTestData;
const universityId = fixtureUniversities[0]!.id;

async function fillDetails(page: Page): Promise<void> {
  await page.getByLabel('Full Name', { exact: true }).fill(name);
  await page.getByLabel('Student Email', { exact: true }).fill(email);
  await page.getByLabel(/^University/).fill('aau');
  await page.getByLabel(/^University/).press('ArrowDown');
  await page.getByLabel(/^University/).press('Enter');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm Password', { exact: true }).fill(password);
}

function preflightResponse(verificationNotice = notice, supported = true) {
  return {
    response: {
      status: 200,
      body: { success: true, data: { supported, verificationNotice } },
    },
  } as const;
}

type SignupRequestBody = {
  email: string;
  name: string;
  universityId: string;
  matricNumber: string | null;
  verificationConsent: true;
  noticeVersion: string;
};

type SignupReceiptOverrides = Partial<{
  email: string;
  challengeId: string;
  expiresAt: string;
  resendAvailableAt: string;
}>;

function signupReceipt(
  challenge = challengeId,
  resendAvailableAt = new Date(Date.now() - 1_000).toISOString(),
  overrides: SignupReceiptOverrides = {},
) {
  return {
    success: true,
    data: {
      email,
      challengeId: challenge,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      resendAvailableAt,
      ...overrides,
    },
  };
}

function requestBody(overrides: Partial<SignupRequestBody> = {}): SignupRequestBody {
  return {
    email,
    name,
    universityId,
    matricNumber: null,
    verificationConsent: true,
    noticeVersion: notice.version,
    ...overrides,
  };
}

function confirmationBody(challenge = challengeId, proof = validOtp, overrides: Partial<SignupRequestBody> = {}) {
  return { ...requestBody(overrides), password, challengeId: challenge, otp: proof };
}

function confirmationResponse() {
  return {
    success: true,
    data: {
      user: { id: accountId, email, role: 'student' },
      tokens: { accessToken, refreshToken },
      redirectTo: 'https://other.test/not-allowed',
    },
  };
}

async function enterOtp(page: Page): Promise<void> {
  await fillDetails(page);
  const consent = page.getByRole('checkbox', { name: 'I agree to student verification processing' });
  await expect(consent).toBeVisible();
  await consent.check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel('Verification Code', { exact: true })).toBeFocused();
}

async function runNextAnimationFrameBeforeReactCommit(page: Page): Promise<void> {
  await page.evaluate(() => {
    const original = window.requestAnimationFrame.bind(window);
    let intercepted = false;
    window.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
      if (intercepted) return original(callback);
      intercepted = true;
      window.requestAnimationFrame = original;
      callback(performance.now());
      return 0;
    }) as typeof window.requestAnimationFrame;
  });
}

async function pasteOtp(page: Page, value = validOtp): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appOrigin });
  await page.evaluate(async (code) => { await navigator.clipboard.writeText(code); }, value);
  const input = page.getByLabel('Verification Code', { exact: true });
  await input.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  await expect(input).toHaveValue(value);
}

async function hasActiveSession(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('awoof.session.v1');
    if (!raw) return false;
    try {
      return JSON.parse(raw).state === 'active';
    } catch {
      return false;
    }
  });
}

function expectSafePublicRequests(api: Awaited<ReturnType<typeof installSyntheticApi>>): void {
  expect(api.signupRequests.every((request) => !request.authorizationPresent)).toBe(true);
  expect(api.signupRequests.filter((request) => request.endpoint === 'request').every((request) => !request.bodyKeys.includes('password'))).toBe(true);
  expect(api.signupRequests.every((request) => request.bodyKeys.every((key) => key !== 'confirmPassword'))).toBe(true);
}

test('supported school email still requires affirmative processing consent', async ({ page }) => {
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [{
        response: {
          status: 200,
          body: { success: true, data: { supported: true, verificationNotice: notice } },
        },
      }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register');
  await fillDetails(page);
  await expect(page.getByText(notice.text, { exact: true })).toBeVisible();
  const consent = page.getByRole('checkbox', { name: 'I agree to student verification processing' });
  await expect(consent).not.toBeChecked();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('#consent-error')).toContainText('consent');
  await expect(consent).toBeFocused();
  expect(api.signupRequests.filter((request) => request.endpoint === 'request')).toHaveLength(0);
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

test('invalid details fields expose their live associated errors', async ({ page }) => {
  const api = await installSyntheticApi(page);
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register');
  await page.getByLabel('Full Name', { exact: true }).fill(name.slice(0, 1));
  await page.getByLabel('Student Email', { exact: true }).fill(email.slice(0, 1));
  await page.getByLabel(/^Matric Number/).fill(matricNumber.repeat(101));
  await page.getByLabel('Password', { exact: true }).fill(password.slice(0, 1));
  await page.getByLabel('Confirm Password', { exact: true }).fill(password.slice(1, 2));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  const associatedErrors = [
    { field: page.getByLabel('Full Name', { exact: true }), id: 'student-signup-name-error' },
    { field: page.getByLabel('Student Email', { exact: true }), id: 'student-signup-email-error' },
    { field: page.getByLabel(/^Matric Number/), id: 'student-signup-matric-error' },
    { field: page.getByLabel('Password', { exact: true }), id: 'student-signup-password-error' },
    { field: page.getByLabel('Confirm Password', { exact: true }), id: 'student-signup-confirm-password-error' },
  ];
  for (const { field, id } of associatedErrors) {
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveAttribute('aria-describedby', id);
    await expect(page.locator('#' + id)).toBeVisible();
  }
  expect(api.signupRequests).toHaveLength(0);
  await assertCleanFixture(api, faults);
});

test('unsupported school email reports support separately without beginning proof', async ({ page }) => {
  const api = await installSyntheticApi(page, { signup: { preflight: [preflightResponse(notice, false)] } });
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register');
  await fillDetails(page);
  await expect(page.getByRole('status')).toContainText(/not supported/i);
  await expect(page.getByText(/Email verified/i)).toHaveCount(0);
  expect(api.signupRequests.filter((request) => request.endpoint === 'request' || request.endpoint === 'confirm')).toHaveLength(0);
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

test('preflight infrastructure failure keeps proof idle and exposes explicit retry', async ({ page }) => {
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [{ response: { status: 503, body: { success: false, error: { code: 'SERVICE_UNAVAILABLE' } } } }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register');
  await fillDetails(page);
  await expect(page.locator('#signup-support-error')).toContainText(/unable to check/i);
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  expect(api.signupRequests.filter((request) => request.endpoint !== 'preflight')).toHaveLength(0);
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

test('request freezes canonical claims, enters the proof step, and keeps the browser signed out', async ({ page }) => {
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse()],
      request: [{ response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register');
  await enterOtp(page);
  expect(api.signupRequests.filter((request) => request.endpoint === 'request')).toHaveLength(1);
  expect(api.signupRequests.filter((request) => request.endpoint === 'request').every((request) => request.matchesExpectedBody)).toBe(true);
  expect(await hasActiveSession(page)).toBe(false);
  expect(api.refreshCalls).toBe(0);
  expectSafePublicRequests(api);
  await assertCleanFixture(api, faults);
});

test('committed OTP input receives focus when the original animation frame arrives before React commits', async ({ page }) => {
  const heldRequest = createGate('precommit student OTP focus');
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse()],
      request: [{ response: { status: 200, body: signupReceipt() }, gate: heldRequest, expectedBody: requestBody() }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  try {
    await page.goto('/auth/student/register');
    await fillDetails(page);
    await page.getByRole('checkbox', { name: 'I agree to student verification processing' }).check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await api.waitForSignupStarted('request', 1);
    await runNextAnimationFrameBeforeReactCommit(page);
    heldRequest.release();
    await expect(page.getByLabel('Verification Code', { exact: true })).toBeFocused();
  } finally {
    heldRequest.release();
  }
  expect(api.signupRequests.filter((request) => request.endpoint === 'request').every((request) => request.matchesExpectedBody)).toBe(true);
  expect(await hasActiveSession(page)).toBe(false);
  expect(api.refreshCalls).toBe(0);
  expectSafePublicRequests(api);
  await assertCleanFixture(api, faults);
});

test('Back focuses the committed email input when the original animation frame arrives before details remount', async ({ page }) => {
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse()],
      request: [{ response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register');
  await enterOtp(page);
  await runNextAnimationFrameBeforeReactCommit(page);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByLabel('Student Email', { exact: true })).toBeFocused();
  expect(api.signupRequests.filter((request) => request.endpoint === 'request')).toHaveLength(1);
  expect(await hasActiveSession(page)).toBe(false);
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

test('initial details support updates do not steal focus without a focus intent', async ({ page }) => {
  const heldPreflight = createGate('initial details support');
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [{ ...preflightResponse(), gate: heldPreflight }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  try {
    await page.goto('/auth/student/register');
    await fillDetails(page);
    await api.waitForSignupStarted('preflight', 1);
    const passwordField = page.getByLabel('Password', { exact: true });
    await passwordField.focus();
    heldPreflight.release();
    await expect(page.getByText(notice.text, { exact: true })).toBeVisible();
    await expect(passwordField).toBeFocused();
  } finally {
    heldPreflight.release();
  }
  expect(api.signupRequests.filter((request) => request.endpoint !== 'preflight')).toHaveLength(0);
  await assertCleanFixture(api, faults);
});

for (const scenario of [
  { name: 'malformed challenge UUID', receipt: () => signupReceipt('not-a-uuid') },
  { name: 'wrong mailbox', receipt: () => signupReceipt(challengeId, undefined, { email: changedEmail }) },
  { name: 'invalid expiry date', receipt: () => signupReceipt(challengeId, undefined, { expiresAt: 'not-a-date' }) },
  { name: 'invalid resend date', receipt: () => signupReceipt(challengeId, undefined, { resendAvailableAt: 'not-a-date' }) },
] as const) {
  test(`${scenario.name} receipt keeps the editable details phase and never starts confirmation`, async ({ page }) => {
    const api = await installSyntheticApi(page, {
      signup: {
        preflight: [preflightResponse()],
        request: [{ response: { status: 200, body: scenario.receipt() }, expectedBody: requestBody() }],
      },
    });
    const faults = collectBrowserFaults(page, api);
    await page.goto('/auth/student/register');
    await fillDetails(page);
    await page.getByRole('checkbox', { name: 'I agree to student verification processing' }).check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.locator('#signup-flow-error')).toContainText(/could not start/i);
    await expect(page.getByLabel('Student Email', { exact: true })).toBeVisible();
    expect(api.signupRequests.filter((request) => request.endpoint === 'confirm')).toHaveLength(0);
    expect(api.signupRequests.every((request) => request.matchesExpectedBody)).toBe(true);
    expect(await hasActiveSession(page)).toBe(false);
    expect(api.refreshCalls).toBe(0);
    expectSafePublicRequests(api);
    await assertCleanFixture(api, faults);
  });
}

test('a pasted six-digit rejected proof stays local without refresh', async ({ page }) => {
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse()],
      request: [{ response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() }],
      confirm: [{ response: { status: 401, body: { success: false, error: { code: 'INVALID_PROOF' } } }, expectedBody: confirmationBody() }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register');
  await enterOtp(page);
  await pasteOtp(page);
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  await expect(page.locator('#otp-error')).toContainText(/code|proof/i);
  await expect(page.getByLabel('Verification Code', { exact: true })).toBeVisible();
  expect(api.signupRequests.filter((request) => request.endpoint === 'confirm')).toHaveLength(1);
  expect(api.refreshCalls).toBe(0);
  expect(await hasActiveSession(page)).toBe(false);
  expectSafePublicRequests(api);
  await assertCleanFixture(api, faults);
});

for (const [invalidOtpIndex, invalidOtp] of invalidOtps.entries()) {
  test('invalid OTP case ' + (invalidOtpIndex + 1) + ' never dispatches confirmation', async ({ page }) => {
    const api = await installSyntheticApi(page, {
      signup: {
        preflight: [preflightResponse()],
        request: [{ response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() }],
      },
    });
    const faults = collectBrowserFaults(page, api);
    await page.goto('/auth/student/register');
    await enterOtp(page);
    await page.getByLabel('Verification Code', { exact: true }).fill(invalidOtp);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await expect(page.locator('#otp-error')).toContainText(/six-digit/i);
    expect(api.signupRequests.filter((request) => request.endpoint === 'confirm')).toHaveLength(0);
    expect(api.refreshCalls).toBe(0);
    await assertCleanFixture(api, faults);
  });
}

test('valid student completion follows only the safe requested return path', async ({ page }) => {
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse()],
      request: [{ response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() }],
      confirm: [{ response: { status: 201, body: confirmationResponse() }, expectedBody: confirmationBody() }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register?redirect=%2Fmarketplace%3Fsource%3Dwidget');
  await enterOtp(page);
  await page.getByLabel('Verification Code', { exact: true }).fill(validOtp);
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  await expect(page).toHaveURL(/\/marketplace\?source=widget$/);
  await expect.poll(() => api.requests.some((request) => request.endpoint === 'current-user' && request.responseIdentity === 'signup-student')).toBe(true);
  const profile = page.getByRole('link', { name: 'Open profile', exact: true });
  await expect(profile).toBeVisible();
  await expect(profile).toHaveAttribute('href', '/student/profile');
  expect(await hasActiveSession(page)).toBe(true);
  expect(new URL(page.url()).search).toBe('?source=widget');
  expect(api.refreshCalls).toBe(0);
  expectSafePublicRequests(api);
  await assertCleanFixture(api, faults);
});

for (const scenario of [
  {
    name: 'known committed issuance failure',
    response: { status: 503, body: { success: false, error: { code: 'SESSION_ISSUANCE_UNAVAILABLE' } } },
    copy: /account was created/i,
  },
  {
    name: 'unknown generic server failure',
    response: { status: 503, body: { success: false, error: { code: 'SERVICE_UNAVAILABLE' } } },
    copy: /could not confirm whether/i,
  },
]) {
  test(scenario.name, async ({ page }) => {
    const api = await installSyntheticApi(page, {
      signup: {
        preflight: [preflightResponse()],
        request: [{ response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() }],
        confirm: [{ response: scenario.response, expectedBody: confirmationBody() }],
      },
    });
    const faults = collectBrowserFaults(page, api);
    await page.goto('/auth/student/register?redirect=%2Fmarketplace%3Fsource%3Dwidget');
    await enterOtp(page);
    await page.getByLabel('Verification Code', { exact: true }).fill(validOtp);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await expect(page.locator('#signup-recovery-error')).toContainText(scenario.copy);
    await expect(page.getByRole('link', { name: 'Sign in', exact: true }).last())
      .toHaveAttribute('href', '/auth/student/login?redirect=%2Fmarketplace%3Fsource%3Dwidget');
    expect(await hasActiveSession(page)).toBe(false);
    expect(api.signupRequests.filter((request) => request.endpoint === 'confirm')).toHaveLength(1);
    expect(api.refreshCalls).toBe(0);
    expectSafePublicRequests(api);
    await assertCleanFixture(api, faults);
  });
}

for (const scenario of [
  {
    name: 'malformed201 confirmation',
    response: { status: 201, body: { success: true, data: {} } },
  },
  {
    name: 'outer-success-false201 confirmation',
    response: { status: 201, body: { ...confirmationResponse(), success: false } },
  },
  {
    name: 'wrong-role201 confirmation',
    response: (() => {
      const response = confirmationResponse();
      return {
        status: 201,
        body: { ...response, data: { ...response.data, user: { ...response.data.user, role: 'vendor' } } },
      };
    })(),
  },
  {
    name: 'wrong-mailbox201 confirmation',
    response: (() => {
      const response = confirmationResponse();
      return {
        status: 201,
        body: { ...response, data: { ...response.data, user: { ...response.data.user, email: changedEmail } } },
      };
    })(),
  },
  {
    name: 'transport-failed confirmation',
    response: { transportFailure: true },
  },
] as const) {
  test(`${scenario.name} offers only uncertain signup recovery`, async ({ page }) => {
    const api = await installSyntheticApi(page, {
      signup: {
        preflight: [preflightResponse()],
        request: [{ response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() }],
        confirm: [{ response: scenario.response, expectedBody: confirmationBody() }],
      },
    });
    const faults = collectBrowserFaults(page, api);
    await page.goto('/auth/student/register?redirect=%2Fmarketplace%3Fsource%3Dwidget');
    await enterOtp(page);
    await page.getByLabel('Verification Code', { exact: true }).fill(validOtp);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await expect(page.locator('#signup-recovery-error')).toContainText(/could not confirm whether/i);
    await expect(page.getByRole('link', { name: 'Sign in', exact: true }).last())
      .toHaveAttribute('href', '/auth/student/login?redirect=%2Fmarketplace%3Fsource%3Dwidget');
    await expect(page).toHaveURL(/\/auth\/student\/register\?redirect=%2Fmarketplace%3Fsource%3Dwidget$/);
    expect(await hasActiveSession(page)).toBe(false);
    expect(api.signupRequests.filter((request) => request.endpoint === 'request')).toHaveLength(1);
    expect(api.signupRequests.filter((request) => request.endpoint === 'confirm')).toHaveLength(1);
    expect(api.signupRequests.every((request) => request.matchesExpectedBody)).toBe(true);
    expect(api.refreshCalls).toBe(0);
    expectSafePublicRequests(api);
    await assertCleanFixture(api, faults);
  });
}

test('a valid committed response with local session persistence failure offers account recovery', async ({ page }) => {
  await installSessionWriteControl(page);
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse()],
      request: [{ response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() }],
      confirm: [{ response: { status: 201, body: confirmationResponse() }, expectedBody: confirmationBody() }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register');
  await enterOtp(page);
  await setActiveSessionWriteDenied(page, true);
  await page.getByLabel('Verification Code', { exact: true }).fill(validOtp);
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  await expect(page.locator('#signup-recovery-error')).toContainText(/account was created/i);
  expect(await hasActiveSession(page)).toBe(false);
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

test('an active vendor session survives a later student confirmation attempt unchanged', async ({ page }) => {
  await seedSession(page, 'vendor');
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse()],
      request: [{ response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  await page.goto(`${appOrigin}${storageTabPath}`);
  const before = await page.evaluate(() => localStorage.getItem('awoof.session.v1'));
  await page.goto('/auth/student/register');
  await enterOtp(page);
  await page.getByLabel('Verification Code', { exact: true }).fill(validOtp);
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  await expect(page.locator('#signup-flow-error')).toContainText(/already signed in/i);
  expect(api.signupRequests.filter((request) => request.endpoint === 'confirm')).toHaveLength(0);
  expect(await page.evaluate(() => localStorage.getItem('awoof.session.v1')) === before).toBe(true);
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

test('storage read denial cannot start a persistent authenticated signup session', async ({ page }) => {
  await installSessionReadControl(page, true);
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse()],
      request: [{ response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register');
  await enterOtp(page);
  await page.getByLabel('Verification Code', { exact: true }).fill(validOtp);
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  await expect(page.locator('#signup-flow-error')).toContainText(/storage|device/i);
  expect(api.signupRequests.filter((request) => request.endpoint === 'confirm')).toHaveLength(0);
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

test('resend replaces the receipt, clears old proof, and honors the server cooldown', async ({ page }) => {
  const futureCooldown = new Date(Date.now() + 600_000).toISOString();
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse()],
      request: [
        { response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() },
        { response: { status: 200, body: signupReceipt(replacementChallengeId, futureCooldown) }, expectedBody: requestBody() },
      ],
      confirm: [{ response: { status: 401, body: { success: false, error: { code: 'INVALID_PROOF' } } }, expectedBody: confirmationBody(replacementChallengeId) }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register');
  await enterOtp(page);
  const otp = page.getByLabel('Verification Code', { exact: true });
  await otp.fill(validOtp);
  await page.getByRole('button', { name: 'Resend code', exact: true }).click();
  await expect.poll(async () => (await otp.inputValue()) === '').toBe(true);
  await expect(page.getByRole('button', { name: 'Resend code', exact: true })).toBeDisabled();
  await otp.fill(validOtp);
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  await expect(page.locator('#otp-error')).toContainText(/code|proof/i);
  expect(api.signupRequests.filter((request) => request.endpoint === 'request')).toHaveLength(2);
  expect(api.signupRequests.filter((request) => request.endpoint === 'request').every((request) => request.matchesExpectedBody)).toBe(true);
  expect(api.signupRequests.filter((request) => request.endpoint === 'confirm').every((request) => request.matchesExpectedBody)).toBe(true);
  expect(api.refreshCalls).toBe(0);
  expectSafePublicRequests(api);
  await assertCleanFixture(api, faults);
});

test('a server-provided resend deadline re-enables the control without another interaction', async ({ page }) => {
  const serverCooldown = new Date(Date.now() + 4_000).toISOString();
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse()],
      request: [{ response: { status: 200, body: signupReceipt(challengeId, serverCooldown) }, expectedBody: requestBody() }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  await page.goto('/auth/student/register');
  await enterOtp(page);
  const resend = page.getByRole('button', { name: 'Resend code', exact: true });
  await expect(resend).toBeDisabled();
  await expect(resend).toBeEnabled({ timeout: 7_000 });
  expect(api.signupRequests.filter((request) => request.endpoint === 'request')).toHaveLength(1);
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

for (const scenario of [
  {
    name: 'rate-limit response',
    failedResponse: () => ({
      status: 429,
      body: { success: false, error: { details: { retryAt: new Date(Date.now() + 2_000).toISOString() } } },
    }),
    waitsForServerDeadline: true,
  },
  {
    name: 'ambiguous server failure',
    failedResponse: () => ({ status: 503, body: { success: false, error: { code: 'SERVICE_UNAVAILABLE' } } }),
    waitsForServerDeadline: false,
  },
  {
    name: 'transport failure',
    failedResponse: () => ({ transportFailure: true } as const),
    waitsForServerDeadline: false,
  },
] as const) {
  test(`failed resend after ${scenario.name} discards proof and recovers only through an explicit new request`, async ({ page }) => {
    const failedResponse = scenario.failedResponse();
    const api = await installSyntheticApi(page, {
      signup: {
        preflight: [preflightResponse()],
        request: [
          { response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() },
          { response: failedResponse, expectedBody: requestBody() },
          { response: { status: 200, body: signupReceipt(replacementChallengeId) }, expectedBody: requestBody() },
        ],
        confirm: [{ response: { status: 401, body: { success: false, error: { code: 'INVALID_PROOF' } } }, expectedBody: confirmationBody(replacementChallengeId) }],
      },
    });
    const faults = collectBrowserFaults(page, api);
    await page.goto('/auth/student/register');
    await enterOtp(page);
    const otp = page.getByLabel('Verification Code', { exact: true });
    const resend = page.getByRole('button', { name: 'Resend code', exact: true });
    const confirmation = page.getByRole('button', { name: 'Create Account', exact: true });
    await otp.fill(validOtp);
    await resend.click();
    await expect(page.locator('#signup-flow-error')).toContainText(/could not|wait/i);
    await expect.poll(async () => (await otp.inputValue()) === '').toBe(true);
    await expect(confirmation).toBeDisabled();
    await expect(page.getByText('A new verification code was sent. Check your email.', { exact: true })).toHaveCount(0);
    await expect(page.locator('#signup-recovery-error')).toHaveCount(0);
    expect(api.signupRequests.filter((request) => request.endpoint === 'request')).toHaveLength(2);
    if (scenario.waitsForServerDeadline) {
      await expect(resend).toBeDisabled();
      await expect(resend).toBeEnabled({ timeout: 5_000 });
    } else {
      await expect(resend).toBeEnabled();
    }
    expect(api.signupRequests.filter((request) => request.endpoint === 'confirm')).toHaveLength(0);
    await resend.click();
    await expect(page.getByText('A new verification code was sent. Check your email.', { exact: true })).toBeVisible();
    await expect(confirmation).toBeEnabled();
    await otp.fill(validOtp);
    await confirmation.click();
    await expect(page.locator('#otp-error')).toContainText(/code|proof/i);
    expect(api.signupRequests.filter((request) => request.endpoint === 'request')).toHaveLength(3);
    expect(api.signupRequests.filter((request) => request.endpoint === 'request').every((request) => request.matchesExpectedBody)).toBe(true);
    expect(api.signupRequests.filter((request) => request.endpoint === 'confirm').every((request) => request.matchesExpectedBody)).toBe(true);
    expect(api.refreshCalls).toBe(0);
    expect(await hasActiveSession(page)).toBe(false);
    expectSafePublicRequests(api);
    await assertCleanFixture(api, faults);
  });
}

for (const change of [
  { name: 'name', label: 'Full Name', next: changedName },
  { name: 'matric number', label: /^Matric Number/, next: matricNumber },
  { name: 'email', label: 'Student Email', next: changedEmail },
]) {
  test(`editing ${change.name} invalidates affirmative processing consent`, async ({ page }) => {
    const api = await installSyntheticApi(page, {
      signup: {
        preflight: change.name === 'email' ? [preflightResponse(), preflightResponse()] : [preflightResponse()],
      },
    });
    const faults = collectBrowserFaults(page, api);
    await page.goto('/auth/student/register');
    await fillDetails(page);
    const consent = page.getByRole('checkbox', { name: 'I agree to student verification processing' });
    await expect(consent).toBeVisible();
    await consent.check();
    await page.getByLabel(change.label).fill(change.next);
    await expect(consent).not.toBeChecked();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.locator('#consent-error')).toContainText(/consent/i);
    expect(api.signupRequests.filter((request) => request.endpoint === 'request')).toHaveLength(0);
    await assertCleanFixture(api, faults);
  });
}

test('a stale supported preflight cannot restore consent for a changed identity', async ({ page }) => {
  const stale = createGate('stale student support preflight');
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [
        { ...preflightResponse(notice), gate: stale, expectCancellation: true },
        preflightResponse(replacementNotice),
      ],
    },
  });
  const faults = collectBrowserFaults(page, api);
  try {
    await page.goto('/auth/student/register');
    await fillDetails(page);
    await api.waitForSignupStarted('preflight', 1);
    await page.getByLabel('Student Email', { exact: true }).fill(betaEmail);
    const university = page.getByLabel(/^University/);
    await university.fill('abu');
    await university.press('ArrowDown');
    await university.press('Enter');
    await api.waitForSignupStarted('preflight', 2);
    await expect(page.getByText(replacementNotice.text, { exact: true })).toBeVisible();
    const consent = page.getByRole('checkbox', { name: 'I agree to student verification processing' });
    await expect(consent).not.toBeChecked();
    await api.waitForSignupNetworkFailed('preflight', 1);
    stale.release();
    await api.waitForSignupRouteSettled('preflight', 1);
    await expect(page.getByText(replacementNotice.text, { exact: true })).toBeVisible();
    await expect(consent).not.toBeChecked();
  } finally {
    stale.release();
  }
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

test('Back cancels a held initial proof request and restores editable identity focus', async ({ page }) => {
  const heldRequest = createGate('held initial student signup request');
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse(), preflightResponse()],
      request: [
        { response: { status: 200, body: signupReceipt() }, gate: heldRequest, expectCancellation: true, expectedBody: requestBody() },
        { response: { status: 200, body: signupReceipt(replacementChallengeId) }, expectedBody: requestBody() },
      ],
    },
  });
  const faults = collectBrowserFaults(page, api);
  try {
    await page.goto('/auth/student/register');
    await fillDetails(page);
    await page.getByRole('checkbox', { name: 'I agree to student verification processing' }).check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await api.waitForSignupStarted('request', 1);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await api.waitForSignupNetworkFailed('request', 1);
    heldRequest.release();
    await api.waitForSignupRouteSettled('request', 1);
    const emailField = page.getByLabel('Student Email', { exact: true });
    await expect(emailField).toBeFocused();
    const consent = page.getByRole('checkbox', { name: 'I agree to student verification processing' });
    await expect(consent).toBeVisible();
    await expect(consent).not.toBeChecked();
    await consent.check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByLabel('Verification Code', { exact: true })).toBeFocused();
    expect(api.signupRequests.filter((request) => request.endpoint === 'request')).toHaveLength(2);
  } finally {
    heldRequest.release();
  }
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

test('Back edit and retry keeps an old request from replacing newer canonical proof claims', async ({ page }) => {
  const heldRequest = createGate('held old student request before edited retry');
  const changedClaims = {
    email: changedEmail,
    name: changedName,
    noticeVersion: replacementNotice.version,
  };
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse(notice), preflightResponse(replacementNotice)],
      request: [
        { response: { status: 200, body: signupReceipt() }, gate: heldRequest, expectCancellation: true, expectedBody: requestBody() },
        { response: { status: 200, body: signupReceipt(replacementChallengeId, undefined, { email: changedEmail }) }, expectedBody: requestBody(changedClaims) },
      ],
      confirm: [{ response: { status: 401, body: { success: false, error: { code: 'INVALID_PROOF' } } }, expectedBody: confirmationBody(replacementChallengeId, validOtp, changedClaims) }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  try {
    await page.goto('/auth/student/register');
    await fillDetails(page);
    await page.getByRole('checkbox', { name: 'I agree to student verification processing' }).check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await api.waitForSignupStarted('request', 1);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await api.waitForSignupNetworkFailed('request', 1);

    await page.getByLabel('Full Name', { exact: true }).fill(changedName);
    await page.getByLabel('Student Email', { exact: true }).fill(changedEmail);
    await expect(page.getByText(replacementNotice.text, { exact: true })).toBeVisible();
    const consent = page.getByRole('checkbox', { name: 'I agree to student verification processing' });
    await expect(consent).not.toBeChecked();
    await consent.check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await api.waitForSignupStarted('request', 2);
    const otp = page.getByLabel('Verification Code', { exact: true });
    await expect(otp).toBeFocused();

    heldRequest.release();
    await api.waitForSignupRouteSettled('request', 1);
    await expect(otp).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/student\/register$/);
    await otp.fill(validOtp);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await expect(page.locator('#otp-error')).toContainText(/code|proof/i);
  } finally {
    heldRequest.release();
  }
  expect(api.signupRequests.filter((request) => request.endpoint === 'request')).toHaveLength(2);
  expect(api.signupRequests.filter((request) => request.endpoint === 'request').every((request) => request.matchesExpectedBody)).toBe(true);
  expect(api.signupRequests.filter((request) => request.endpoint === 'confirm').every((request) => request.matchesExpectedBody)).toBe(true);
  expect(await hasActiveSession(page)).toBe(false);
  expect(api.refreshCalls).toBe(0);
  expectSafePublicRequests(api);
  await assertCleanFixture(api, faults);
});

test('leaving through Sign in cancels a held initial proof request', async ({ page }) => {
  const heldRequest = createGate('held initial request before student sign in');
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse()],
      request: [{ response: { status: 200, body: signupReceipt() }, gate: heldRequest, expectCancellation: true, expectedBody: requestBody() }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  try {
    await page.goto('/auth/student/register?redirect=%2Fmarketplace%3Fsource%3Dwidget');
    await fillDetails(page);
    await page.getByRole('checkbox', { name: 'I agree to student verification processing' }).check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await api.waitForSignupStarted('request', 1);
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/auth\/student\/login\?redirect=%2Fmarketplace%3Fsource%3Dwidget$/);
    await api.waitForSignupNetworkFailed('request', 1);
    heldRequest.release();
    await api.waitForSignupRouteSettled('request', 1);
    expect(await hasActiveSession(page)).toBe(false);
  } finally {
    heldRequest.release();
  }
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

test('Back cancels a held confirmation and restores a fresh details phase', async ({ page }) => {
  const heldConfirmation = createGate('held student confirmation before Back');
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse(), preflightResponse()],
      request: [{ response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() }],
      confirm: [{ response: { status: 201, body: confirmationResponse() }, gate: heldConfirmation, expectCancellation: true, expectedBody: confirmationBody() }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  try {
    await page.goto('/auth/student/register');
    await enterOtp(page);
    await page.getByLabel('Verification Code', { exact: true }).fill(validOtp);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await api.waitForSignupStarted('confirm', 1);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await api.waitForSignupNetworkFailed('confirm', 1);
    heldConfirmation.release();
    await api.waitForSignupRouteSettled('confirm', 1);
    await expect(page.getByLabel('Student Email', { exact: true })).toBeFocused();
    const consent = page.getByRole('checkbox', { name: 'I agree to student verification processing' });
    await expect(consent).toBeVisible();
    await expect(consent).not.toBeChecked();
    expect(await hasActiveSession(page)).toBe(false);
  } finally {
    heldConfirmation.release();
  }
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

test('leaving the route cancels a held confirmation without asserting server rollback', async ({ page }) => {
  const heldConfirmation = createGate('held student signup confirmation');
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse()],
      request: [{ response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() }],
      confirm: [{ response: { status: 201, body: confirmationResponse() }, gate: heldConfirmation, expectCancellation: true, expectedBody: confirmationBody() }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  try {
    await page.goto('/auth/student/register?redirect=%2Fmarketplace%3Fsource%3Dwidget');
    await enterOtp(page);
    await page.getByLabel('Verification Code', { exact: true }).fill(validOtp);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await api.waitForSignupStarted('confirm', 1);
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/auth\/student\/login\?redirect=%2Fmarketplace%3Fsource%3Dwidget$/);
    await api.waitForSignupNetworkFailed('confirm', 1);
    heldConfirmation.release();
    await api.waitForSignupRouteSettled('confirm', 1);
    await expect(page).toHaveURL(/\/auth\/student\/login\?redirect=%2Fmarketplace%3Fsource%3Dwidget$/);
    expect(await hasActiveSession(page)).toBe(false);
  } finally {
    heldConfirmation.release();
  }
  expect(api.refreshCalls).toBe(0);
  await assertCleanFixture(api, faults);
});

for (const replacement of [
  {
    name: 'vendor account replacement',
    apply: async (other: Page) => replaceSession(other, 'vendor'),
    activeAfter: true,
  },
  {
    name: 'tagged remote signed-out action',
    apply: async (other: Page) => writeTaggedSignedOutAction(other, 'synthetic-replacement-action'),
    activeAfter: false,
  },
]) {
  test(`a held confirmation preserves a newer ${replacement.name}`, async ({ page, context }) => {
    const heldConfirmation = createGate(`held confirmation before ${replacement.name}`);
    const api = await installSyntheticApi(page, {
      signup: {
        preflight: [preflightResponse()],
        request: [{ response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() }],
        confirm: [{ response: { status: 201, body: confirmationResponse() }, gate: heldConfirmation, expectedBody: confirmationBody() }],
      },
    });
    const faults = collectBrowserFaults(page, api);
    const other = await context.newPage();
    try {
      await page.goto('/auth/student/register?redirect=%2Fmarketplace%3Fsource%3Dwidget');
      await enterOtp(page);
      await page.getByLabel('Verification Code', { exact: true }).fill(validOtp);
      await page.getByRole('button', { name: 'Create Account', exact: true }).click();
      await api.waitForSignupStarted('confirm', 1);
      await other.goto(storageTabPath);
      const newerEnvelope = await replacement.apply(other);
      heldConfirmation.release();
      await api.waitForSignupRouteSettled('confirm', 1);
      await expect(page.locator('#signup-flow-error')).toContainText(/signup stopped/i);
      await expect(page).toHaveURL(/\/auth\/student\/register/);
      expect(await newerEnvelope.matches(page)).toBe(true);
      expect(await hasActiveSession(page)).toBe(replacement.activeAfter);
      expect(api.refreshCalls).toBe(0);
      expectSafePublicRequests(api);
    } finally {
      heldConfirmation.release();
      await other.close();
    }
    await assertCleanFixture(api, faults);
  });
}

test('a held confirmation fresh-reconciles an unobserved active-to-tagged signed-out replacement', async ({ page, context }) => {
  await installSessionStorageEventSuppression(page);
  const heldConfirmation = createGate('held confirmation before unobserved remote sign-out');
  const api = await installSyntheticApi(page, {
    signup: {
      preflight: [preflightResponse()],
      request: [{ response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() }],
      confirm: [{ response: { status: 201, body: confirmationResponse() }, gate: heldConfirmation, expectedBody: confirmationBody() }],
    },
  });
  const faults = collectBrowserFaults(page, api);
  const other = await context.newPage();
  try {
    await page.goto('/auth/student/register?redirect=%2Fmarketplace%3Fsource%3Dwidget');
    await enterOtp(page);
    await page.getByLabel('Verification Code', { exact: true }).fill(validOtp);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await api.waitForSignupStarted('confirm', 1);
    await other.goto(storageTabPath);
    const newerEnvelope = await writeUnobservedActiveThenTaggedSignedOutAction(other);
    await expect(page.getByLabel('Verification Code', { exact: true })).toBeVisible();
    heldConfirmation.release();
    await api.waitForSignupRouteSettled('confirm', 1);
    await expect(page.locator('#signup-flow-error')).toContainText(/signup stopped/i);
    await expect(page).toHaveURL(/\/auth\/student\/register/);
    expect(await newerEnvelope.matches(page)).toBe(true);
    expect(await hasActiveSession(page)).toBe(false);
    expect(api.refreshCalls).toBe(0);
    expectSafePublicRequests(api);
  } finally {
    heldConfirmation.release();
    await other.close();
  }
  await assertCleanFixture(api, faults);
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`student proof keyboard flow is accessible on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const api = await installSyntheticApi(page, {
      signup: {
        preflight: [preflightResponse()],
        request: [{ response: { status: 200, body: signupReceipt() }, expectedBody: requestBody() }],
        confirm: [{ response: { status: 401, body: { success: false, error: { code: 'INVALID_PROOF' } } }, expectedBody: confirmationBody() }],
      },
    });
    const faults = collectBrowserFaults(page, api);
    await page.goto('/auth/student/register');
    await fillDetails(page);
    const consent = page.getByRole('checkbox', { name: 'I agree to student verification processing' });
    await consent.focus();
    await consent.press('Space');
    await expect(consent).toBeChecked();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const otp = page.getByLabel('Verification Code', { exact: true });
    await expect(otp).toHaveAttribute('inputmode', 'numeric');
    await expect(otp).toHaveAttribute('autocomplete', 'one-time-code');
    await pasteOtp(page);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await expect(page.locator('#otp-error')).toContainText(/code|proof/i);
    const back = page.getByRole('button', { name: 'Back', exact: true });
    const backBox = await back.boundingBox();
    expect(backBox).not.toBeNull();
    expect(backBox!.y + backBox!.height).toBeLessThanOrEqual(viewport.height);
    await back.click();
    await expect(page.getByLabel('Student Email', { exact: true })).toBeFocused();
    await assertCleanFixture(api, faults);
  });
}
