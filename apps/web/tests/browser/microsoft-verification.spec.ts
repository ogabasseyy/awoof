import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const appOrigin = 'https://app.awoof.test:3443';
const apiOrigin = 'https://api.awoof.test:3444';
const attemptStorageKey = 'awoof.microsoft.verification.attempt.v1';
const sessionStorageKey = 'awoof.session.v1';

function session(sessionId = 'fixture-browser-session', accessToken = 'student-access', refreshToken = 'student-refresh') {
  return JSON.stringify({ v: 1, state: 'active', sessionId, accessToken, refreshToken });
}

async function seedStudent(page: Page, sessionId = 'fixture-browser-session', accessToken = 'student-access', refreshToken = 'student-refresh') {
  const marker = `__awoof_microsoft_https_seed_${sessionId}`;
  await page.addInitScript(({ app, key, value, marker: once }) => {
    // Like the established browser fixture, seed only the first app document.
    // Reloads and callback documents must observe the real resulting state;
    // they must not silently restore the old account.
    if (location.origin !== app || sessionStorage.getItem(once) !== null) return;
    localStorage.setItem(key, value);
    sessionStorage.setItem(once, 'seeded');
  }, { app: appOrigin, key: sessionStorageKey, value: session(sessionId, accessToken, refreshToken), marker });
}

async function seedAdmin(page: Page, sessionId = 'fixture-admin-session', accessToken = 'admin-access', refreshToken = 'admin-refresh') {
  const marker = `__awoof_microsoft_https_admin_seed_${sessionId}`;
  await page.addInitScript(({ app, key, value, marker: once }) => {
    if (location.origin !== app || sessionStorage.getItem(once) !== null) return;
    localStorage.setItem(key, value);
    sessionStorage.setItem(once, 'seeded');
  }, { app: appOrigin, key: sessionStorageKey, value: session(sessionId, accessToken, refreshToken), marker });
}

async function installSyntheticMicrosoftDocument(context: BrowserContext, holdProviderDocument = true) {
  let resolveArrival!: () => void;
  const arrived = new Promise<void>((resolve) => { resolveArrival = resolve; });
  let providerPage: Page | null = null;
  let callbackUrl = '';
  let visits = 0;
  await context.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === appOrigin || requestUrl.origin === apiOrigin) {
      await route.continue(); return;
    }
    if (requestUrl.origin !== 'https://login.microsoftonline.com') {
      await route.abort('blockedbyclient'); return;
    }
    visits += 1;
    resolveArrival();
    const state = requestUrl.searchParams.get('state');
    callbackUrl = `${apiOrigin}/api/verification/microsoft/callback?state=${encodeURIComponent(state ?? '')}`;
    providerPage = route.request().frame().page();
    // This controlled document is fulfilled by Playwright, not continued. It
    // cannot reach the real tenant. It commits a real provider-origin document
    // before the controlled callback. This prevents Awoof's storage listener
    // from racing a cross-tab replacement while the route is merely pending.
    const navigation = holdProviderDocument
      ? `<button id="fixture-continue" type="button">Continue synthetic Microsoft callback</button><script>document.querySelector('#fixture-continue').onclick=()=>location.assign(${JSON.stringify(callbackUrl)})</script>`
      : `<script>location.replace(${JSON.stringify(callbackUrl)})</script>`;
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic Microsoft</title>${navigation}` });
  });
  return {
    arrived,
    release: async () => {
      if (!holdProviderDocument || !providerPage) throw new Error('Synthetic Microsoft provider document is unavailable.');
      await providerPage.getByRole('button', { name: 'Continue synthetic Microsoft callback' }).click();
    },
    visits: () => visits,
    callbackUrl: () => callbackUrl,
  };
}

async function start(page: Page) {
  await loadAuthenticatedVerification(page);
  await page.getByLabel('Accept verification processing consent').check();
  await page.getByLabel('Accept Microsoft provider consent').check();
  // The controlled provider route stays pending so the test can inspect tab
  // storage before the provider document is released. Do not await its full
  // document navigation here.
  void page.getByRole('button', { name: 'Continue with Microsoft' }).click({ noWaitAfter: true }).catch(() => undefined);
}

async function loadAuthenticatedVerification(page: Page) {
  await page.goto('/student/verification');
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), sessionStorageKey)).toContain('student-access');
  await expect.poll(async () => {
    const response = await page.evaluate(async (url) => (await (await fetch(url, { credentials: 'include' })).json()).data, `${apiOrigin}/api/__fixture/evidence`);
    return response.observedPaths.includes('GET /api/auth/me');
  }).toBe(true);
  await expect(page.getByRole('heading', { name: 'Connect a Microsoft school account' })).toBeVisible();
}

type FixtureEvidence = {
  startCalls: number;
  finishCalls: number;
  callbackCookieCalls: number;
  refreshCalls: number;
  logoutCalls: number;
  delayedFinishDeliveries: number;
  diagnosticCalls: number;
  capturedApplicationLogs: string[];
  capturedApplicationErrors: string[];
  capturedProxyLogs: string[];
  observedPaths: string[];
  observedServerSessions: Array<{ path: string; serverSessionId: string; userId: string }>;
  identityReadEvents: Array<{ userId: string | null; received: boolean; delivered: boolean; delayed: boolean }>;
  statusReadEvents: Array<{ userId: string | null; received: boolean; delivered: boolean; delayed: boolean; status: number | null }>;
  historyReadEvents: Array<{ userId: string | null; received: boolean; delivered: boolean; delayed: boolean }>;
  acceptedConsentSnapshots: Array<{ providerPolicyVersion?: number; noticeVersion?: string } | null>;
  revokedServerSessions: string[];
  accounts: Record<string, { emailEvidenceEligible: boolean; microsoftEnrollmentEligible: boolean; finishCalls: number; linkedMicrosoftIdentities: number; providerConsentWithdrawn: boolean; providerWithdrawCalls: number }>;
  attempts: Array<{ attemptId: string; ownerId: string; ready: boolean; callbackUsed: boolean; completed: boolean; callbackCookieCalls: number; finishCalls: number; finishCookieCalls: number; completionWrites: number; transientFailures: number }>;
};

async function evidence(page: Page): Promise<FixtureEvidence> {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'include' });
    return (await response.json()).data;
  }, `${apiOrigin}/api/__fixture/evidence`);
}

async function appEvidence(context: BrowserContext): Promise<FixtureEvidence> {
  const probe = await context.newPage();
  try {
    await probe.goto(`${appOrigin}/__fixture-storage-tab`);
    return await evidence(probe);
  } finally {
    await probe.close();
  }
}

async function fixtureControl(page: Page, path: string) {
  await page.evaluate(async (url) => {
    const response = await fetch(url, { method: 'POST', credentials: 'include' });
    if (!response.ok) throw new Error(`Fixture control failed: ${response.status}`);
  }, `${apiOrigin}${path}`);
}

async function fixtureLogout(page: Page, accessToken: string) {
  await page.evaluate(async ({ url, token }) => {
    const response = await fetch(url, { method: 'POST', credentials: 'include', headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Fixture logout failed: ${response.status}`);
  }, { url: `${apiOrigin}/api/auth/logout`, token: accessToken });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/__fixture-storage-tab');
  await fixtureControl(page, '/api/__fixture/reset');
});

function callbackAttemptId(callbackUrl: string) {
  return new URL(callbackUrl).searchParams.get('state')?.replace('fixture-state-', '') ?? '';
}

test('HTTPS fixture forwards the Next development debug stream before authenticated verification loads', async ({ page }) => {
  await seedStudent(page);
  await loadAuthenticatedVerification(page);
});

test('admin redacted diagnostics renders a safe timeline and fixed aggregate through the isolated HTTPS fixture', async ({ page }) => {
  await seedAdmin(page);
  await page.goto('/admin/verification-diagnostics/92d71887-18a0-4c0d-b696-138bc9d54f20');
  await expect(page.getByRole('heading', { name: 'Redacted verification timeline' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Attempt started' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Attempt finished' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Synthetic approved institution' })).toBeVisible();
  await expect(page.getByText('An incomplete attempt is an expired start with no callback; it is not an enrollment denial and does not create eligibility.')).toBeVisible();
  await expect(page.getByText('Review the approved institution permission and retry only after it is corrected.')).toBeVisible();
  for (const forbidden of ['fixture-institution', 'student-a@approved.test', 'TOKEN_CANARY', 'provider-profile']) {
    await expect(page.getByText(forbidden, { exact: false })).toHaveCount(0);
  }
  expect((await evidence(page)).diagnosticCalls).toBeGreaterThan(0);
});

test('admin diagnostics discards a delayed old-session result after a replacement session remount', async ({ page, context }) => {
  await seedAdmin(page, 'fixture-admin-session-a', 'admin-access:delay-diagnostics');
  await page.goto('/admin/verification-diagnostics/92d71887-18a0-4c0d-b696-138bc9d54f20');
  await expect.poll(async () => (await evidence(page)).diagnosticCalls).toBe(1);
  const replacement = await context.newPage();
  await replacement.goto(`${appOrigin}/__fixture-storage-tab`);
  await replacement.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: sessionStorageKey, value: session('fixture-admin-session-b', 'admin-access:admin-b', 'admin-b-refresh'),
  });
  const delayedResponse = page.waitForResponse((response) => response.url().includes('/admin/verification-diagnostics/92d71887-18a0-4c0d-b696-138bc9d54f20'));
  await fixtureControl(page, '/api/__fixture/release-delayed-diagnostics');
  await delayedResponse;
  await expect(page.getByRole('heading', { name: 'Attempt finished' })).toHaveCount(0);
  await expect(page.getByText('Review the approved institution permission and retry only after it is corrected.')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Diagnostic timeline not found' })).toBeVisible();
});

test('admin diagnostics renders a generic unavailable state with a session-fenced retry', async ({ page }) => {
  await seedAdmin(page, 'fixture-admin-session', 'admin-access:unavailable');
  await page.goto('/admin/verification-diagnostics/92d71887-18a0-4c0d-b696-138bc9d54f20');
  await expect(page.getByRole('heading', { name: 'Diagnostic timeline is unavailable' })).toBeVisible();
  await fixtureControl(page, '/api/__fixture/release-diagnostics-unavailable');
  await page.getByRole('button', { name: 'Retry timeline' }).click();
  await expect(page.getByRole('heading', { name: 'Redacted verification timeline' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Attempt finished' })).toBeVisible();
  expect((await evidence(page)).diagnosticCalls).toBeGreaterThanOrEqual(2);
});

test('admin diagnostics renders the intentionally empty safe timeline state', async ({ page }) => {
  await seedAdmin(page, 'fixture-admin-session', 'admin-access:empty-diagnostics');
  await page.goto('/admin/verification-diagnostics/92d71887-18a0-4c0d-b696-138bc9d54f20');
  await expect(page.getByRole('heading', { name: 'No timeline events available' })).toBeVisible();
  await expect(page.getByText('No redacted stages were persisted for this diagnostic.')).toBeVisible();
});

test('local Express error boundary, TLS proxy, and browser outputs mask transport canaries', async ({ page }) => {
  await seedAdmin(page);
  await page.goto('/__fixture-storage-tab');
  const canaries = ['AUTH_CANARY', 'COOKIE_CANARY', 'CALLBACK_QUERY_CANARY', 'CODE_CANARY', 'TOKEN_CANARY', 'ERROR_DESCRIPTION_CANARY', 'PROFILE_CANARY'];
  await page.context().addCookies([{ name: 'synthetic', value: canaries[1]!, domain: 'api.awoof.test', path: '/', secure: true, sameSite: 'Lax' }]);
  const browserConsole: string[] = [];
  const browserErrors: string[] = [];
  page.on('console', (message) => browserConsole.push(message.text()));
  page.on('pageerror', (error) => browserErrors.push(error.message));
  const result = await page.evaluate(async (values) => {
    const response = await fetch(`${location.protocol}//api.awoof.test:3444/api/__fixture/canary-mask?callback=${encodeURIComponent(values[2])}&code=${encodeURIComponent(values[3])}&token=${encodeURIComponent(values[4])}&error_description=${encodeURIComponent(values[5])}`, {
      method: 'POST', credentials: 'include',
      headers: { Authorization: `Bearer ${values[0]}`, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: values[6] }),
    });
    return {
      status: response.status,
      responseBody: await response.text(),
      dom: document.documentElement.outerHTML,
      storage: JSON.stringify([localStorage.getItem('awoof.session.v1'), sessionStorage.getItem('awoof.microsoft.verification.attempt.v1')]),
    };
  }, canaries);
  expect(result.status).toBe(500);
  expect(result.responseBody).toBe(JSON.stringify({ success: false, error: { message: 'Verification diagnostics are temporarily unavailable', code: 'INTERNAL_SERVER_ERROR', statusCode: 500 } }));
  const captured = await evidence(page);
  expect(captured.capturedApplicationErrors).toContain('Verification diagnostics request failed');
  expect(captured.capturedApplicationLogs.some((line) => line.includes('/api/__fixture/canary-mask 500'))).toBe(true);
  expect(captured.capturedProxyLogs.some((line) => line.includes('/api/__fixture/canary-mask 500'))).toBe(true);
  const surfaces = JSON.stringify({ application: captured.capturedApplicationLogs, applicationErrors: captured.capturedApplicationErrors, proxy: captured.capturedProxyLogs, browser: { ...result, browserConsole, browserErrors } });
  for (const canary of canaries) expect(surfaces.includes(canary)).toBe(false);
});

test('genuine HTTPS callback carries and consumes the Secure HttpOnly SameSite cookie before the app redirect', async ({ page, context }) => {
  await seedStudent(page);
  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function captureMicrosoftAttempt(storageKey: string, value: string): void {
      original.call(this, storageKey, value);
      if (this === sessionStorage && storageKey === key) {
        const attempt = JSON.parse(value) as { browserSessionId?: string };
        localStorage.setItem('__fixture_microsoft_attempt_capture', JSON.stringify({ keys: Object.keys(attempt).sort(), browserSessionId: attempt.browserSessionId }));
      }
    };
  }, attemptStorageKey);
  const provider = await installSyntheticMicrosoftDocument(context, false);
  await start(page);

  // The tab record is inspected before the provider document is released: it
  // has exactly the approved four fields and no authorization URL or token.
  await expect(page).toHaveURL(/\/student\/verification\/microsoft\/complete\?attempt=fixture-attempt-/);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('__fixture_microsoft_attempt_capture') ?? '{}'));
  expect(stored.keys).toEqual(['attemptId', 'browserSessionId', 'expiresAt', 'finishSecret']);
  expect(stored.browserSessionId).toBe('fixture-browser-session');
  expect(provider.visits()).toBe(1);

  await expect(page.getByRole('heading', { name: 'University account connected' })).toBeVisible();
  await expect(page.getByText('Current Awoof eligibility:')).toContainText('eligible');
  expect(await page.evaluate((key) => sessionStorage.getItem(key), attemptStorageKey)).toBeNull();
  const observed = await appEvidence(context);
  expect(observed.callbackCookieCalls).toBeGreaterThan(0);
  expect(observed.finishCalls).toBeGreaterThan(0);
  const attempt = observed.attempts.find((item) => item.attemptId === 'fixture-attempt-1');
  expect(attempt).toMatchObject({ ownerId: '00000000-0000-4000-8000-000000000001', ready: true, callbackUsed: true, completed: true, callbackCookieCalls: 1, finishCookieCalls: 0, completionWrites: 1 });
  expect(attempt?.finishCalls).toBeGreaterThanOrEqual(1);
  expect(observed.accounts['00000000-0000-4000-8000-000000000001'].linkedMicrosoftIdentities).toBe(1);
});

test('a callback without tab-scoped state is rejected before the HTTPS finish request', async ({ page }) => {
  await seedStudent(page);
  await page.goto('/__fixture-storage-tab');
  const before = await evidence(page);
  await page.goto('/student/verification/microsoft/complete?attempt=fixture-attempt-missing');
  await expect(page.getByText('This Microsoft connection cannot be completed in the current Awoof session. Start again from student verification.')).toBeVisible();
  const after = await evidence(page);
  expect(after.finishCalls).toBe(before.finishCalls);
});

test('expired tab state is removed and cannot be replayed through a full callback document', async ({ page }) => {
  await seedStudent(page);
  await page.addInitScript(({ key }) => sessionStorage.setItem(key, JSON.stringify({
    attemptId: 'expired-attempt', finishSecret: 'synthetic-expired', browserSessionId: 'fixture-browser-session', expiresAt: Date.now() - 1,
  })), { key: attemptStorageKey });
  await page.goto('/__fixture-storage-tab');
  const before = await evidence(page);
  await page.goto('/student/verification/microsoft/complete?attempt=expired-attempt');
  await expect(page.getByText('This Microsoft connection cannot be completed in the current Awoof session. Start again from student verification.')).toBeVisible();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), attemptStorageKey)).toBeNull();
  expect((await evidence(page)).finishCalls).toBe(before.finishCalls);
});

test('cross-tab replacement never grants Microsoft evidence to the replacement account', async ({ page, context }) => {
  await seedStudent(page, 'student-a-browser-session');
  const provider = await installSyntheticMicrosoftDocument(context);
  await start(page);
  await provider.arrived;
  const replacement = await context.newPage();
  await replacement.goto(`${appOrigin}/__fixture-storage-tab`);
  await replacement.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: sessionStorageKey, value: session('student-b-browser-session', 'student-access:account-b') });
  await provider.release();
  await expect(page.getByText('This Microsoft connection cannot be completed in the current Awoof session. Start again from student verification.')).toBeVisible();
  await expect(page.getByText('University account connected')).toHaveCount(0);
  expect((await evidence(page)).accounts['00000000-0000-4000-8000-000000000002'].linkedMicrosoftIdentities).toBe(0);
});

test('an untrusted different completion attempt cannot clear a current-session tab attempt', async ({ page }) => {
  await seedStudent(page, 'current-browser-session');
  await page.addInitScript(({ key }) => sessionStorage.setItem(key, JSON.stringify({
    attemptId: 'current-attempt', finishSecret: 'current-secret', browserSessionId: 'current-browser-session', expiresAt: Date.now() + 60_000,
  })), { key: attemptStorageKey });
  await page.goto('/__fixture-storage-tab');
  await page.goto('/student/verification/microsoft/complete?attempt=untrusted-other-attempt&outcome=connection_not_completed');
  await expect(page.getByText('This Microsoft connection cannot be completed in the current Awoof session. Start again from student verification.')).toBeVisible();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), attemptStorageKey)).toContain('current-attempt');
});

test('a replacement browser session removes its obsolete prior-session tab attempt', async ({ page }) => {
  await seedStudent(page, 'old-browser-session');
  await page.goto('/__fixture-storage-tab');
  await page.evaluate(({ attemptKey, sessionKey, replacement }) => {
    sessionStorage.setItem(attemptKey, JSON.stringify({
      attemptId: 'old-attempt', finishSecret: 'old-secret', browserSessionId: 'old-browser-session', expiresAt: Date.now() + 60_000,
    }));
    localStorage.setItem(sessionKey, replacement);
  }, { attemptKey: attemptStorageKey, sessionKey: sessionStorageKey, replacement: session('replacement-browser-session') });
  await page.goto('/student/verification/microsoft/complete?attempt=old-attempt&outcome=connection_not_completed');
  await expect(page.getByText('This Microsoft connection cannot be completed in the current Awoof session. Start again from student verification.')).toBeVisible();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), attemptStorageKey)).toBeNull();
});

test('invalid callback returns a header-valid rejection without consuming an attempt', async ({ page }) => {
  await seedStudent(page);
  await page.goto('/__fixture-storage-tab');
  const before = await evidence(page);
  const callbackUrl = `${apiOrigin}/api/verification/microsoft/callback?state=unknown-state`;
  const rejected = page.waitForResponse((response) => response.url() === callbackUrl);
  await page.goto(callbackUrl).catch(() => undefined);
  const response = await rejected;
  expect(response.status()).toBe(400);
  expect(response.headers().location).toBeUndefined();
  await page.waitForURL('chrome-error://chromewebdata/');
  await page.goto('/__fixture-storage-tab');
  const after = await evidence(page);
  expect(after.callbackCookieCalls).toBe(before.callbackCookieCalls);
  expect(after.finishCalls).toBe(before.finishCalls);
});

test('callback without the real Secure cookie is rejected before an attempt becomes ready', async ({ page, context }) => {
  await seedStudent(page);
  const provider = await installSyntheticMicrosoftDocument(context);
  await start(page);
  await provider.arrived;
  await context.clearCookies({ name: '__Host-awoof-microsoft-fixture' });
  const rejected = page.waitForResponse((response) => response.url() === provider.callbackUrl());
  await provider.release();
  expect((await rejected).status()).toBe(400);
  await page.goto('/__fixture-storage-tab');
  const observed = await evidence(page);
  const attempt = observed.attempts.find((item) => item.attemptId === callbackAttemptId(provider.callbackUrl()));
  expect(attempt).toMatchObject({ ready: false, callbackUsed: false, callbackCookieCalls: 0, finishCalls: 0 });
});

test('a callback state is accepted once and replay is rejected without a second finish', async ({ page, context }) => {
  await seedStudent(page);
  const provider = await installSyntheticMicrosoftDocument(context);
  await start(page);
  await provider.arrived;
  const callbackUrl = provider.callbackUrl();
  await provider.release();
  await expect(page.getByRole('heading', { name: 'University account connected' })).toBeVisible();
  const afterFirstCallback = await evidence(page);
  const replayResponse = page.waitForResponse((response) => response.url() === callbackUrl);
  await page.goto(callbackUrl).catch(() => undefined);
  expect((await replayResponse).status()).toBe(400);
  await page.waitForURL('chrome-error://chromewebdata/');
  await page.goto('/__fixture-storage-tab');
  const afterReplay = await evidence(page);
  expect(afterReplay.callbackCookieCalls).toBe(afterFirstCallback.callbackCookieCalls);
  expect(afterReplay.finishCalls).toBe(afterFirstCallback.finishCalls);
});

test('a bound provider cancellation returns to the Awoof email alternative without finishing or writing evidence', async ({ page, context }) => {
  await seedStudent(page, 'cancel-browser-session');
  const provider = await installSyntheticMicrosoftDocument(context);
  await start(page);
  await provider.arrived;

  // A provider denial is an untrusted provider claim. It may end only the
  // already state-and-cookie-bound attempt; it must never become a finish.
  await page.goto(`${provider.callbackUrl()}&error=access_denied`);
  await expect(page.getByRole('heading', { name: 'Connection needs attention' })).toBeVisible();
  await expect(page.getByText('The Microsoft connection was not completed. You can still verify using your school email.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Use school email verification' })).toBeVisible();
  const observed = await evidence(page);
  const attempt = observed.attempts.find((item) => item.attemptId === callbackAttemptId(provider.callbackUrl()));
  expect(attempt).toMatchObject({ ready: false, completed: false, completionWrites: 0, finishCalls: 0 });
  expect(await page.evaluate((key) => sessionStorage.getItem(key), attemptStorageKey)).toBeNull();
});

test('terminal finish failure clears the secret and requires restart, not completion retry', async ({ page, context }) => {
  await seedStudent(page, 'terminal-browser-session', 'student-access:terminal');
  const provider = await installSyntheticMicrosoftDocument(context);
  await start(page); await provider.arrived; await provider.release();
  await expect(page.getByRole('link', { name: 'Start again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry completion' })).toHaveCount(0);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), attemptStorageKey)).toBeNull();
});

test('successful finish with a failed status reload keeps the linked result and retries status only', async ({ page, context }) => {
  await seedStudent(page, 'status-browser-session', 'student-access:status-failure:account-b');
  const provider = await installSyntheticMicrosoftDocument(context);
  await start(page); await provider.arrived; await provider.release();
  await expect(page.getByRole('heading', { name: 'University account connected' })).toBeVisible();
  await expect(page.getByText('Current eligibility could not be reloaded. Visit verification to check it.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry completion' })).toHaveCount(0);
});

test('global Microsoft disablement hides start while owner history and school email remain independently usable', async ({ page }) => {
  await seedStudent(page, 'globally-off-browser-session', 'student-access:account-b:global-off');
  await loadAuthenticatedVerification(page);
  await expect(page.getByRole('button', { name: 'Continue with Microsoft' })).toHaveCount(0);
  await expect(page.getByText('Microsoft connections are temporarily unavailable.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Microsoft consent history' })).toBeVisible();
  await expect(page.getByText('Active — accepted')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Synthetic Awoof processing notice.' }).check();
  await expect(page.getByRole('button', { name: 'Send verification code' })).toBeEnabled();
});

test('off-flag owner can unlink a discovered connection without changing independent email eligibility', async ({ page }) => {
  await seedStudent(page, 'unlink-off-browser-session', 'student-access:account-b:global-off');
  await loadAuthenticatedVerification(page);
  await expect(page.getByRole('heading', { name: 'Microsoft connections' })).toBeVisible();
  await page.getByRole('button', { name: 'Unlink Microsoft connection' }).click();
  await expect(page.getByText(/Remove this Microsoft connection/)).toBeVisible();
  await page.getByRole('button', { name: 'Unlink Microsoft' }).click();
  await expect(page.getByText(/Microsoft connection removed\. Your independent school-email verification was not changed/)).toBeVisible();
  await expect(page.getByText('Removed — Synthetic approved institution')).toBeVisible();
  expect((await evidence(page)).accounts['00000000-0000-4000-8000-000000000002']).toMatchObject({ emailEvidenceEligible: false, microsoftEnrollmentEligible: false, linkedMicrosoftIdentities: 0 });
});

test('an unlink error retains the session-scoped confirmation for an explicit retry', async ({ page }) => {
  await seedStudent(page, 'unlink-error-browser-session', 'student-access:account-b:global-off:unlink-error');
  await loadAuthenticatedVerification(page);
  await page.getByRole('button', { name: 'Unlink Microsoft connection' }).click();
  await page.getByRole('button', { name: 'Unlink Microsoft' }).click();
  await expect(page.getByText('Microsoft connection is unavailable. Please try again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unlink Microsoft' })).toBeVisible();
  expect((await evidence(page)).accounts['00000000-0000-4000-8000-000000000002'].linkedMicrosoftIdentities).toBe(0);
});

test('a successful unlink keeps its result while a failed owner-status refresh can be retried', async ({ page }) => {
  await seedStudent(page, 'unlink-refresh-browser-session', 'student-access:account-b:global-off:status-failure');
  await loadAuthenticatedVerification(page);
  await page.getByRole('button', { name: 'Unlink Microsoft connection' }).click();
  await page.getByRole('button', { name: 'Unlink Microsoft' }).click();
  await expect(page.getByText(/Microsoft connection removed\. Your independent school-email verification was not changed/)).toBeVisible();
  await expect(page.getByText(/The connection was removed, but current eligibility could not be refreshed/)).toBeVisible();
  await page.getByRole('button', { name: 'Retry current eligibility' }).click();
  await expect(page.getByRole('button', { name: 'Retry current eligibility' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send verification code' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry current eligibility' })).toHaveCount(0);
});

test('durable provider withdrawal tombstones stale history and clears Microsoft-only eligibility before delayed reads return', async ({ page }) => {
  await seedStudent(page, 'provider-withdrawal-browser-session', 'student-access:account-b:provider-withdrawal');
  await loadAuthenticatedVerification(page);
  await expect(page.getByText('Your student eligibility is current.', { exact: true })).toBeVisible();
  await expect(page.getByText('Active — accepted')).toBeVisible();

  await fixtureControl(page, '/api/__fixture/delay-next-history-read');
  await page.getByRole('button', { name: 'Refresh' }).nth(1).click();
  await expect.poll(async () => (await evidence(page)).historyReadEvents).toContainEqual(expect.objectContaining({ userId: '00000000-0000-4000-8000-000000000002', delayed: true, delivered: false }));
  await fixtureControl(page, '/api/__fixture/delay-next-status-read');
  await page.getByRole('button', { name: 'Withdraw Microsoft consent' }).click();

  await expect(page.getByText(/Microsoft provider consent withdrawn\. Independent email evidence was not changed/)).toBeVisible();
  await expect(page.getByText('Withdrawn — accepted')).toBeVisible();
  await expect(page.getByText('Your student eligibility is current.', { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await evidence(page)).statusReadEvents).toContainEqual(expect.objectContaining({ userId: '00000000-0000-4000-8000-000000000002', delayed: true, delivered: false }));

  await fixtureControl(page, '/api/__fixture/release-delayed-history');
  await expect(page.getByText('Withdrawn — accepted')).toBeVisible();
  await expect(page.getByText('Active — accepted')).toHaveCount(0);
  await fixtureControl(page, '/api/__fixture/release-delayed-status');
  await expect(page.getByRole('button', { name: 'Send verification code' })).toBeVisible();
  expect((await evidence(page)).accounts['00000000-0000-4000-8000-000000000002']).toMatchObject({ emailEvidenceEligible: false, microsoftEnrollmentEligible: false, providerConsentWithdrawn: true, providerWithdrawCalls: 1 });
});

test('provider withdrawal keeps durable success separate from a failed eligibility refresh and does not repeat the mutation on retry', async ({ page }) => {
  await seedStudent(page, 'provider-withdrawal-refresh-browser-session', 'student-access:account-b:provider-withdrawal:status-failure');
  await loadAuthenticatedVerification(page);
  await page.getByRole('button', { name: 'Withdraw Microsoft consent' }).click();
  await expect(page.getByText(/Microsoft provider consent withdrawn\. Independent email evidence was not changed/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry current eligibility' })).toBeVisible();
  expect((await evidence(page)).accounts['00000000-0000-4000-8000-000000000002'].providerWithdrawCalls).toBe(1);
  await page.getByRole('button', { name: 'Retry current eligibility' }).click();
  await expect(page.getByRole('button', { name: 'Retry current eligibility' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send verification code' })).toBeVisible();
  expect((await evidence(page)).accounts['00000000-0000-4000-8000-000000000002'].providerWithdrawCalls).toBe(1);
});

test('provider withdrawal retains its local tombstone when the fresh consent-history read fails', async ({ page }) => {
  await seedStudent(page, 'provider-withdrawal-history-failure', 'student-access:account-b:provider-withdrawal:history-read-failure');
  await loadAuthenticatedVerification(page);
  await page.getByRole('button', { name: 'Withdraw Microsoft consent' }).click();
  await expect(page.getByText('Withdrawn — accepted')).toBeVisible();
  await expect(page.getByText(/Microsoft consent was withdrawn, but consent history could not be refreshed/)).toBeVisible();
  expect((await evidence(page)).accounts['00000000-0000-4000-8000-000000000002'].providerWithdrawCalls).toBe(1);
  await page.getByRole('button', { name: 'Refresh' }).nth(1).click();
  await expect(page.getByText('Withdrawn — accepted')).toBeVisible();
  await expect(page.getByText('Active — accepted')).toHaveCount(0);
  expect((await evidence(page)).accounts['00000000-0000-4000-8000-000000000002'].providerWithdrawCalls).toBe(1);
});

test('provider withdrawal reloads an independent email result without blanket revocation', async ({ page }) => {
  await seedStudent(page, 'provider-withdrawal-email-browser-session', 'student-access:provider-withdrawal');
  await loadAuthenticatedVerification(page);
  await page.getByRole('button', { name: 'Withdraw Microsoft consent' }).click();
  await expect(page.getByText(/Microsoft provider consent withdrawn\. Independent email evidence was not changed/)).toBeVisible();
  await expect(page.getByText('Your student eligibility is current.', { exact: true })).toBeVisible();
  expect((await evidence(page)).accounts['00000000-0000-4000-8000-000000000001']).toMatchObject({ emailEvidenceEligible: true, providerConsentWithdrawn: true, providerWithdrawCalls: 1 });
});

test('a delayed provider-history read cannot restore the old owner consent after session replacement', async ({ page, context }) => {
  const replacement = await context.newPage();
  try {
    await page.goto('/__fixture-storage-tab');
    await seedStudent(page, 'provider-history-old-session', 'student-access:provider-withdrawal');
    await loadAuthenticatedVerification(page);
    await expect(page.getByText('Active — accepted')).toBeVisible();
    await fixtureControl(page, '/api/__fixture/delay-next-history-read');
    await page.getByRole('button', { name: 'Refresh' }).nth(1).click();
    await expect.poll(async () => (await evidence(page)).historyReadEvents).toContainEqual(expect.objectContaining({ userId: '00000000-0000-4000-8000-000000000001', delayed: true, delivered: false }));

    await seedStudent(replacement, 'provider-history-new-session', 'student-access:account-b');
    await loadAuthenticatedVerification(replacement);
    await expect(page.getByText('student-b@approved.test').first()).toBeVisible();
    await fixtureControl(replacement, '/api/__fixture/release-delayed-history');
    await expect.poll(async () => (await evidence(replacement)).historyReadEvents).toContainEqual(expect.objectContaining({ userId: '00000000-0000-4000-8000-000000000001', delayed: true, delivered: true }));
    await expect(page.getByText('Active — accepted')).toHaveCount(0);
  } finally {
    await replacement.close();
  }
});

test('an enabled-policy unlink keeps a successful identity refresh distinct from a delayed failed eligibility refresh', async ({ page }) => {
  await seedStudent(page, 'unlink-enabled-status-browser-session', 'student-access:identity-linked:status-failure');
  await loadAuthenticatedVerification(page);
  await expect(page.getByRole('button', { name: 'Continue with Microsoft' })).toBeVisible();
  await expect(page.getByText('Connected — Synthetic approved institution A')).toBeVisible();
  const identityReadsBeforeUnlink = (await evidence(page)).identityReadEvents
    .filter((event) => event.userId === '00000000-0000-4000-8000-000000000001' && event.delivered).length;
  await page.getByRole('button', { name: 'Unlink Microsoft connection' }).click();
  await fixtureControl(page, '/api/__fixture/delay-next-status-read');
  await page.getByRole('button', { name: 'Unlink Microsoft' }).click();
  await expect.poll(async () => (await evidence(page)).statusReadEvents).toContainEqual(expect.objectContaining({ delayed: true, delivered: false, userId: '00000000-0000-4000-8000-000000000001' }));
  await expect.poll(async () => (await evidence(page)).identityReadEvents.filter((event) => event.userId === '00000000-0000-4000-8000-000000000001' && event.delivered).length).toBe(identityReadsBeforeUnlink + 1);
  await expect(page.getByText(/Microsoft connection removed\. Your independent school-email verification was not changed/)).toBeVisible();
  await fixtureControl(page, '/api/__fixture/release-delayed-status');
  await expect(page.getByText(/The connection was removed, but current eligibility could not be refreshed/)).toBeVisible();
  await expect(page.getByText('Microsoft connections could not be loaded. You can retry.')).toHaveCount(0);
  await expect(page.getByText('The connection was removed, but connection history could not be refreshed. Use Refresh to check it again.')).toHaveCount(0);
  await expect(page.getByText('Removed — Synthetic approved institution A')).toBeVisible();
  await page.getByRole('button', { name: 'Retry current eligibility' }).click();
  await expect(page.getByRole('button', { name: 'Retry current eligibility' })).toHaveCount(0);
  await expect(page.getByText('Removed — Synthetic approved institution A')).toBeVisible();
});

test('a delayed old-owner identity read cannot populate after account replacement while the new owner sees only its own connection', async ({ page, context }) => {
  // Seed only the A page. A page-level init script would otherwise seed B on
  // its first app navigation and mask the cross-tab replacement under test.
  const replacement = await context.newPage();
  try {
    await page.goto('/__fixture-storage-tab');
    await seedStudent(page, 'identity-old-browser-session', 'student-access:global-off');
    await loadAuthenticatedVerification(page);
    await expect(page.getByText('Connected — Synthetic approved institution A')).toBeVisible();
    await page.getByRole('button', { name: 'Unlink Microsoft connection' }).click();
    await expect(page.getByText(/Remove this Microsoft connection/)).toBeVisible();

    await fixtureControl(page, '/api/__fixture/delay-next-identity-read');
    await page.getByRole('button', { name: 'Refresh' }).first().click();
    await expect.poll(async () => (await evidence(page)).identityReadEvents).toContainEqual(expect.objectContaining({ userId: '00000000-0000-4000-8000-000000000001', delayed: true, delivered: false }));

    await seedStudent(replacement, 'identity-new-browser-session', 'student-access:account-b:global-off');
    await loadAuthenticatedVerification(replacement);
    await expect(page.getByText('student-b@approved.test').first()).toBeVisible();
    await expect(page.getByText(/Remove this Microsoft connection/)).toHaveCount(0);

    await fixtureControl(replacement, '/api/__fixture/release-delayed-identities');
    await expect.poll(async () => (await evidence(replacement)).identityReadEvents).toContainEqual(expect.objectContaining({ userId: '00000000-0000-4000-8000-000000000001', delayed: true, delivered: true }));
    await expect(page.getByText('Connected — Synthetic approved institution B')).toBeVisible();
    await expect(page.getByText('Connected — Synthetic approved institution A')).toHaveCount(0);
    await expect(page.getByText(/Remove this Microsoft connection/)).toHaveCount(0);
  } finally {
    await replacement.close();
  }
});

test('notice read failure leaves Microsoft owner history available', async ({ page }) => {
  await seedStudent(page, 'notice-failure-browser-session', 'student-access:notice-failure');
  await loadAuthenticatedVerification(page);
  await expect(page.getByText('The current Microsoft consent notice is unavailable. Your existing connection controls remain available below.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Microsoft consent history' })).toBeVisible();
  await expect(page.getByText('Active — accepted')).toBeVisible();
});

test('owner Microsoft consent history paginates without replacing the earlier page', async ({ page }) => {
  await seedStudent(page, 'history-pagination-browser-session', 'student-access:history-pagination');
  await loadAuthenticatedVerification(page);
  await expect(page.getByText('Active — accepted')).toBeVisible();
  await page.getByRole('button', { name: 'Load more Microsoft consents' }).click();
  await expect(page.getByText('Withdrawn — accepted')).toBeVisible();
  await expect(page.getByText('Active — accepted')).toBeVisible();
});

test('identity-only completion never claims enrollment or turns independent-ineligible account B eligible', async ({ page, context }) => {
  await seedStudent(page, 'identity-only-browser-session', 'student-access:account-b');
  const provider = await installSyntheticMicrosoftDocument(context);
  await start(page); await provider.arrived; await provider.release();
  await expect(page.getByRole('heading', { name: 'University account connected' })).toBeVisible();
  await expect(page.getByText('This connection did not check current enrollment.')).toBeVisible();
  await expect(page.getByText('Current Awoof eligibility:')).toContainText('not currently eligible');
  const observed = await evidence(page);
  expect(observed.accounts['00000000-0000-4000-8000-000000000002']).toMatchObject({ emailEvidenceEligible: false, microsoftEnrollmentEligible: false, linkedMicrosoftIdentities: 1 });
});

test('positive graph-enrollment simulation labels confirmed enrollment and updates effective eligibility', async ({ page, context }) => {
  await seedStudent(page, 'graph-enrollment-browser-session', 'student-access:account-b:graph-enrollment');
  const provider = await installSyntheticMicrosoftDocument(context);
  await start(page); await provider.arrived; await provider.release();
  await expect(page.getByRole('heading', { name: 'University account connected' })).toBeVisible();
  await expect(page.getByText('Current enrollment was confirmed.')).toBeVisible();
  await expect(page.getByText('Current Awoof eligibility:')).toContainText('eligible');
  expect((await evidence(page)).accounts['00000000-0000-4000-8000-000000000002'].microsoftEnrollmentEligible).toBe(true);
});

test('one transient finish failure retains the current tab attempt for one explicit same-session retry', async ({ page, context }) => {
  await seedStudent(page, 'transient-browser-session', 'student-access:transient');
  const provider = await installSyntheticMicrosoftDocument(context);
  await start(page); await provider.arrived; await provider.release();
  await expect(page.getByText('We could not complete the Microsoft connection yet. You can retry while this tab and Awoof session remain active.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry completion' })).toBeVisible();
  expect(await page.evaluate((key) => {
    const attempt = JSON.parse(sessionStorage.getItem(key) ?? 'null') as { attemptId?: unknown; finishSecret?: unknown } | null;
    return attempt?.attemptId === 'fixture-attempt-1' && typeof attempt.finishSecret === 'string' && attempt.finishSecret.length > 0;
  }, attemptStorageKey)).toBe(true);
  await page.getByRole('button', { name: 'Retry completion' }).click();
  await expect(page.getByRole('heading', { name: 'University account connected' })).toBeVisible();
  const attempt = (await evidence(page)).attempts[0];
  expect(attempt).toMatchObject({ transientFailures: 1, finishCalls: 2, completionWrites: 1 });
});

test('a full-document reload during a held finish preserves same-session continuity', async ({ page, context }) => {
  await seedStudent(page, 'reload-browser-session', 'student-access:delay-finish');
  const provider = await installSyntheticMicrosoftDocument(context);
  await start(page); await provider.arrived; await provider.release();
  await expect.poll(async () => (await evidence(page)).finishCalls).toBe(1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(async () => (await evidence(page)).finishCalls).toBeGreaterThanOrEqual(2);
  await fixtureControl(page, '/api/__fixture/release-delayed-finish');
  await expect(page.getByRole('heading', { name: 'University account connected' })).toBeVisible();
  expect((await evidence(page)).attempts[0]).toMatchObject({ ownerId: '00000000-0000-4000-8000-000000000001', completionWrites: 1 });
});

test('a real 401 refresh rotates tokens while preserving browser and fixture-server session identity', async ({ page }) => {
  await seedStudent(page, 'refresh-browser-session', 'student-access:refresh-expired', 'student-refresh-refresh');
  await loadAuthenticatedVerification(page);
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}'), sessionStorageKey);
  expect(stored).toMatchObject({ sessionId: 'refresh-browser-session', accessToken: 'student-access:refresh-fresh', refreshToken: 'student-refresh-fresh' });
  const observed = await evidence(page);
  expect(observed.refreshCalls).toBe(1);
  const statusSessions = observed.observedServerSessions.filter((item) => item.path === '/api/verification/status');
  expect(statusSessions.length).toBeGreaterThanOrEqual(2);
  expect(new Set(statusSessions.map((item) => item.serverSessionId))).toEqual(new Set(['fixture-server-session-a']));
});

test('same-user fixture logout and relogin rotate server session and reject the old tab attempt', async ({ page, context }) => {
  await seedStudent(page, 'same-user-old-browser-session');
  const provider = await installSyntheticMicrosoftDocument(context);
  await start(page); await provider.arrived;
  const replacement = await context.newPage();
  await replacement.goto(`${appOrigin}/__fixture-storage-tab`);
  await replacement.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: sessionStorageKey, value: session('same-user-old-browser-session') });
  await fixtureLogout(replacement, 'student-access');
  await replacement.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: sessionStorageKey, value: session('same-user-new-browser-session', 'student-access:relogin') });
  await provider.release();
  await expect(page.getByText('This Microsoft connection cannot be completed in the current Awoof session. Start again from student verification.')).toBeVisible();
  await expect(page.getByText('University account connected')).toHaveCount(0);
  const attempt = (await evidence(page)).attempts[0];
  expect(attempt).toMatchObject({ completed: false, completionWrites: 0, finishCalls: 0 });
  const observed = await evidence(page);
  expect(observed).toMatchObject({ logoutCalls: 1 });
  expect(observed.revokedServerSessions).toContain('fixture-server-session-a');
});

test('a delayed finish response after account replacement cannot render its old success or write B evidence', async ({ page, context }) => {
  await seedStudent(page, 'delayed-a-browser-session', 'student-access:delay-finish');
  const provider = await installSyntheticMicrosoftDocument(context);
  await start(page); await provider.arrived; await provider.release();
  await expect.poll(async () => (await evidence(page)).finishCalls).toBe(1);
  const replacement = await context.newPage();
  await replacement.goto(`${appOrigin}/__fixture-storage-tab`);
  await replacement.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: sessionStorageKey, value: session('delayed-b-browser-session', 'student-access:account-b') });
  await fixtureControl(replacement, '/api/__fixture/release-delayed-finish');
  await expect.poll(async () => (await evidence(page)).delayedFinishDeliveries).toBe(1);
  await expect(page.getByText('This Microsoft connection cannot be completed in the current Awoof session. Start again from student verification.')).toBeVisible();
  await expect(page.getByText('University account connected')).toHaveCount(0);
  const observed = await evidence(page);
  expect(observed.attempts[0]).toMatchObject({ completed: true, completionWrites: 1 });
  expect(observed.accounts['00000000-0000-4000-8000-000000000002'].linkedMicrosoftIdentities).toBe(0);
});

test('a stale notice conflict renders new copy, unticks provider acceptance, and requires one reaccepted updated snapshot', async ({ page, context }) => {
  await seedStudent(page, 'notice-changed-browser-session', 'student-access:notice-changed');
  await loadAuthenticatedVerification(page);
  await page.getByLabel('Accept verification processing consent').check();
  await page.getByLabel('Accept Microsoft provider consent').check();
  await page.getByRole('button', { name: 'Continue with Microsoft' }).click();
  await expect(page.getByText('The Microsoft notice changed. Please read the updated notice and accept it again.')).toBeVisible();
  await expect(page.getByText('Updated synthetic provider consent. Please accept this new notice.')).toBeVisible();
  await expect(page.getByLabel('Accept Microsoft provider consent')).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Continue with Microsoft' })).toBeDisabled();
  const provider = await installSyntheticMicrosoftDocument(context);
  await page.getByLabel('Accept Microsoft provider consent').check();
  await page.getByRole('button', { name: 'Continue with Microsoft' }).click({ noWaitAfter: true });
  await provider.arrived;
  await expect(page.getByRole('button', { name: 'Continue synthetic Microsoft callback' })).toBeVisible();
  const observed = await appEvidence(context);
  expect(observed.startCalls).toBe(1);
  expect(observed.acceptedConsentSnapshots).toEqual([
    expect.objectContaining({ providerPolicyVersion: 1, noticeVersion: 'fixture-provider-v1' }),
    expect.objectContaining({ providerPolicyVersion: 2, noticeVersion: 'fixture-provider-v2' }),
  ]);
});

test('an unchanged notice snapshot remains explicitly acceptable and starts exactly one bound attempt', async ({ page, context }) => {
  await seedStudent(page, 'unchanged-notice-browser-session');
  const provider = await installSyntheticMicrosoftDocument(context);
  await start(page); await provider.arrived;
  await expect(page.getByRole('button', { name: 'Continue synthetic Microsoft callback' })).toBeVisible();
  expect((await appEvidence(context)).startCalls).toBe(1);
});
