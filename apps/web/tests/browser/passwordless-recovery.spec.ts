import { expect, test, type Page } from '@playwright/test';
import { apiOrigin, appOrigin, createGate, installSyntheticApi, seedSession } from './fixtures';

const headers = { 'access-control-allow-origin': appOrigin, 'access-control-allow-credentials': 'true' };

test('password method cannot be selected before account recovery status finishes loading', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const statusGate = createGate('current account recovery status');
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, async route => {
        await statusGate.wait();
        return route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null } } });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login');
    await seedSession(page, 'student');
    await page.goto('/student/security');
    await statusGate.waitForArrival();
    await expect(page.getByRole('button', { name: 'Use your password instead' })).toBeDisabled();
    statusGate.release();
    await expect(page.getByRole('button', { name: 'Use your password instead' })).toBeEnabled();
    await page.getByRole('button', { name: 'Use your password instead' }).click();
    await page.getByRole('button', { name: 'Confirm identity to generate a code' }).click();
    await expect(page.getByLabel('Current password')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

async function markFreshSignupForCurrentSession(page: Page, sessionId = 'synthetic-student-session'): Promise<void> {
    await page.evaluate((id) => sessionStorage.setItem('awoof.passwordless-signup-fresh', JSON.stringify({ sessionId: id })), sessionId);
}

test('late security reads from a previous account cannot overwrite the current account state', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const oldStatus = createGate('previous account recovery status');
    const oldIdentities = createGate('previous account identities');
    const newStatus = createGate('current account recovery status');
    const newIdentities = createGate('current account identities');
    const authMe = `${apiOrigin}/api/auth/me`;
    const statusUrl = `${apiOrigin}/api/auth/student/sso/recovery-code`;
    const identitiesUrl = `${apiOrigin}/api/auth/student/sso/identities`;

    await page.route(authMe, route => {
        const token = route.request().headers()['authorization'] ?? '';
        const isNew = token.includes('student-b-access');
        return route.fulfill({ headers, json: { success: true, data: {
            id: isNew ? 'student-account-b' : 'student-account-a',
            email: isNew ? 'b@approved.test' : 'a@approved.test', role: 'student', verificationStatus: 'verified',
        } } });
    });
    await page.route(statusUrl, async route => {
        const isNew = (route.request().headers()['authorization'] ?? '').includes('student-b-access');
        if (isNew) {
            await newStatus.wait();
            return route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null } } });
        }
        await oldStatus.wait();
        return route.fulfill({ headers, json: { success: true, data: { status: 'active', generation: 1 } } });
    });
    await page.route(identitiesUrl, async route => {
        const isNew = (route.request().headers()['authorization'] ?? '').includes('student-b-access');
        if (isNew) {
            await newIdentities.wait();
            return route.fulfill({ headers, json: { success: true, data: { identities: [] } } });
        }
        await oldIdentities.wait();
        return route.fulfill({ headers, json: { success: true, data: { identities: [{
            id: 'identity-a', provider: 'microsoft', universityName: 'Previous Account University', linkedAt: '2026-01-01T00:00:00.000Z',
        }] } } });
    });

    await page.goto('/auth/student/login');
    await seedSession(page, 'student');
    await page.goto('/student/security');
    await oldStatus.waitForArrival();
    await oldIdentities.waitForArrival();
    await page.evaluate(() => {
        const session = JSON.stringify({ v: 1, state: 'active', sessionId: 'student-b-session', accessToken: 'student-b-access', refreshToken: 'student-b-refresh' });
        localStorage.setItem('awoof.session.v1', session);
        // This is a same-window synthetic storage notification; a generic
        // Event with the fields consumed by the listener is sufficient.
        const event = new Event('storage');
        Object.defineProperties(event, {
            key: { value: 'awoof.session.v1' },
            newValue: { value: session },
        });
        window.dispatchEvent(event);
    });
    await newStatus.waitForArrival();
    await newIdentities.waitForArrival();
    newStatus.release(); newIdentities.release();
    await expect(page.getByRole('button', { name: 'Confirm identity to generate a code' })).toBeVisible();
    oldStatus.release(); oldIdentities.release();
    await expect(page.getByText('A recovery code is active. Replacing or removing it requires the current code and fresh confirmation.')).toHaveCount(0);
    await expect(page.getByText(/Previous Account University/)).toHaveCount(0);
    api.assertNoUnexpectedRequests();
});

test('account switch hides displayed recovery secrets and discards late generation responses', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const delayedGeneration = createGate('previous account recovery-code generation');
    let generateCalls = 0;
    await page.route(`${apiOrigin}/api/auth/me`, route => {
        const authorization = route.request().headers().authorization ?? '';
        const account = authorization.includes('student-b-access')
            ? { id: 'student-account-b', email: 'b@approved.test' }
            : authorization.includes('student-c-access')
                ? { id: 'student-account-c', email: 'c@approved.test' }
                : { id: 'student-account-a', email: 'a@approved.test' };
        return route.fulfill({ headers, json: { success: true, data: { ...account, role: 'student', verificationStatus: 'verified' } } });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, route => route.fulfill({ headers, status: 201, json: { success: true, data: { grantId: 'reauth-grant', grantSecret: 'reauth-secret' } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, async route => {
        generateCalls += 1;
        if (generateCalls === 2) await delayedGeneration.wait();
        const isDelayed = generateCalls === 2;
        return route.fulfill({ headers, status: 201, json: { success: true, data: {
            pendingCodeId: isDelayed ? 'pending-b' : 'pending-a',
            code: isDelayed ? 'account-b-one-time-secret' : 'account-a-one-time-secret',
            generation: 1,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            serverNow: new Date().toISOString(),
        } } });
    });

    const switchAccount = async (account: 'b' | 'c') => page.evaluate((which) => {
        const value = JSON.stringify({ v: 1, state: 'active', sessionId: `student-${which}-session`, accessToken: `student-${which}-access`, refreshToken: `student-${which}-refresh` });
        localStorage.setItem('awoof.session.v1', value);
        const event = new Event('storage');
        Object.defineProperties(event, { key: { value: 'awoof.session.v1' }, newValue: { value } });
        window.dispatchEvent(event);
    }, account);

    await page.goto('/auth/student/login');
    await seedSession(page, 'student');
    await page.goto('/student/security');
    await page.getByRole('button', { name: 'Use your password instead' }).click();
    await page.getByRole('button', { name: 'Confirm identity to generate a code' }).click();
    await page.getByLabel('Current password').fill('Synthetic!Pass9');
    await page.getByRole('button', { name: 'Generate code' }).click();
    await expect(page.getByText('account-a-one-time-secret')).toBeVisible();

    await switchAccount('b');
    await expect(page.getByRole('button', { name: 'Confirm identity to generate a code' })).toBeVisible();
    await expect(page.getByText('account-a-one-time-secret')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Save your recovery code' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Use your password instead' }).click();
    await page.getByRole('button', { name: 'Confirm identity to generate a code' }).click();
    await page.getByLabel('Current password').fill('Synthetic!Pass9');
    await page.getByRole('button', { name: 'Generate code' }).click();
    await delayedGeneration.waitForArrival();
    await switchAccount('c');
    await expect(page.getByRole('button', { name: 'Confirm identity to generate a code' })).toBeVisible();
    delayedGeneration.release();
    await expect(page.getByText('account-b-one-time-secret')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Save your recovery code' })).toHaveCount(0);
    api.assertNoUnexpectedRequests();
});

test('security setup keeps the generated recovery code out of URL and web storage and requires a second fresh proof', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ json: { success: true, data: { status: 'unconfigured', generation: null } }, headers }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login');
    await seedSession(page, 'student');
    await page.goto('/student/security');
    await expect(page.getByText('Confirm your identity, save your code, then confirm your identity again to activate it.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm identity to generate a code' })).toBeVisible();
    expect(await page.evaluate(() => `${location.href}|${localStorage.length}|${sessionStorage.length}`)).not.toContain('recovery-code');
    api.assertNoUnexpectedRequests();
});

test('recovery-code activation waits for a confirmed generation after status refresh failure', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '74100000-0000-4000-8000-000000000001';
    let statusReads = 0;
    let activations = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '76100000-0000-4000-8000-000000000001', grantSecret: 'activate-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_activate', pendingCodeId: pendingId, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => {
        statusReads += 1;
        return statusReads === 1
            ? route.fulfill({ status: 503, headers, json: { success: false, error: { message: 'Unavailable', statusCode: 503 } } })
            : route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 3, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString(), serverNow: new Date().toISOString() } } });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => { activations += 1; return route.fulfill({ headers, json: { success: true, data: { active: true } } }); });
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=74100000-0000-4000-8000-000000000002');
    await expect(page.getByRole('button', { name: 'Activate recovery code' })).toBeDisabled();
    await expect(page.getByText('Activation is disabled until the server confirms which code generation is pending.')).toBeVisible();
    await page.getByLabel('Re-enter saved recovery code').fill('saved-code');
    expect(activations).toBe(0);
    await page.getByRole('button', { name: 'Retry status check' }).click();
    await expect(page.getByRole('button', { name: 'Activate recovery code' })).toBeEnabled();
    await page.getByRole('button', { name: 'Activate recovery code' }).click();
    await expect(page.getByRole('heading', { name: 'Recovery code active' })).toBeVisible();
    expect(activations).toBe(1);
    api.assertNoUnexpectedRequests();
});

test('independent password recovery requires an explicit purpose and does not promise school-login recovery', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.goto('/auth/student/recovery');
    await expect(page.getByRole('heading', { name: 'Account recovery' })).toBeVisible();
    await expect(page.getByText('school mailbox and saved recovery code')).toBeVisible();
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByLabel('I think my sign-in was compromised').check();
    await expect(page.getByText('disconnect all linked external sign-in identities')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('recovery start freezes its submitted purpose and email while serializing same-tick duplicate submits', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const start = createGate('recovery start response');
    const bodies: Array<{ email?: string; purpose?: string; idempotencyKey?: string }> = [];
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, async route => {
        bodies.push(JSON.parse(route.request().postData() ?? '{}') as { email?: string; purpose?: string; idempotencyKey?: string });
        await start.wait();
        return route.fulfill({ status: 202, headers, json: { success: true, data: {
            attemptId: '90500000-0000-4000-8000-000000000001', secret: 'recovery-secret',
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
        } } });
    });

    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('snapshot@school.example');
    await page.getByLabel('I think my sign-in was compromised').check();
    await page.locator('form').evaluate((form: HTMLFormElement) => {
        form.requestSubmit();
        form.requestSubmit();
    });
    await start.waitForArrival();
    await expect(page.getByLabel('School email')).toBeDisabled();
    await expect(page.getByLabel('I think my sign-in was compromised')).toBeDisabled();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.email).toBe('snapshot@school.example');
    expect(bodies[0]?.purpose).toBe('compromise');
    expect(bodies[0]?.idempotencyKey).toBeTruthy();
    start.release();
    await expect(page.getByLabel('Saved recovery code')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('ambiguous recovery completion keeps the password and points at sign-in before another recovery', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => route.fulfill({ status: 202, headers, json: { success: true, data: { attemptId: '90000000-0000-4000-8000-000000000001', secret: 'recovery-secret', expiresAt: new Date(Date.now() + 300_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/verify`, route => route.fulfill({ headers, json: { success: true, data: { expiresAt: new Date(Date.now() + 600_000).toISOString(), serverNow: new Date().toISOString() } } }));
    let completionRequests = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/complete`, route => {
        completionRequests += 1;
        if (completionRequests === 1) return route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'boom', code: 'INTERNAL', statusCode: 500 } } });
        return route.fulfill({ status: 409, headers, json: { success: false, error: { message: 'Account recovery is not available', code: 'CONFLICT', statusCode: 409 } } });
    });
    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await page.getByLabel('Saved recovery code').fill('saved-code');
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm recovery proofs' }).click();
    await page.getByLabel('New password').fill('Brand-New-Password-1');
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByText('did not confirm')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try signing in with this password' })).toBeVisible();
    await expect(page.getByLabel('New password')).toHaveValue('Brand-New-Password-1');
    // A retry after a lost response can receive 409 because the first
    // completion consumed the attempt; retain the ambiguous-success advice.
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByText('did not confirm')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try signing in with this password' })).toBeVisible();
    expect(completionRequests).toBe(2);
    api.assertNoUnexpectedRequests();
});

test('recovery completion ignores duplicate submits while the server response is pending', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const completion = createGate('recovery completion response');
    let completionRequests = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => route.fulfill({ status: 202, headers, json: { success: true, data: { attemptId: '91000000-0000-4000-8000-000000000001', secret: 'recovery-secret', expiresAt: new Date(Date.now() + 300_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/verify`, route => route.fulfill({ headers, json: { success: true, data: { expiresAt: new Date(Date.now() + 600_000).toISOString(), serverNow: new Date().toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/complete`, async route => {
        completionRequests += 1;
        await completion.wait();
        return route.fulfill({ status: 204, headers });
    });
    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await page.getByLabel('Saved recovery code').fill('saved-code');
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm recovery proofs' }).click();
    await page.getByLabel('New password').fill('Brand-New-Password-1');
    await page.getByRole('button', { name: 'Set password' }).click();
    await completion.waitForArrival();
    await expect(page.getByRole('button', { name: 'Setting password…' })).toBeDisabled();
    await page.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    await expect.poll(() => completionRequests).toBe(1);
    completion.release();
    await expect(page.getByText('Password set. Sign in with your password to continue.')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('stale recovery completion cannot overwrite an attempt restarted after expiry', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const completion = createGate('stale recovery completion response');
    let startCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => {
        startCalls += 1;
        const attemptId = startCalls === 1 ? '93000000-0000-4000-8000-000000000001' : '93000000-0000-4000-8000-000000000002';
        return route.fulfill({ status: 202, headers, json: { success: true, data: { attemptId, secret: 'recovery-secret', expiresAt: new Date(Date.now() + 300_000).toISOString(), otpExpiresAt: new Date(Date.now() + 300_000).toISOString() } } });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/verify`, route => route.fulfill({ headers, json: { success: true, data: { expiresAt: new Date(Date.now() + 2_000).toISOString(), serverNow: new Date().toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/complete`, async route => {
        await completion.wait();
        return route.fulfill({ status: 204, headers });
    });
    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await page.getByLabel('Saved recovery code').fill('saved-code');
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm recovery proofs' }).click();
    await page.getByLabel('New password').fill('Brand-New-Password-1');
    await page.getByRole('button', { name: 'Set password' }).click();
    await completion.waitForArrival();
    // The short completion window lapses while the request is held, so
    // the page offers a restart; the new attempt must survive the stale
    // success instead of flipping to its completion state.
    await expect(page.getByRole('button', { name: 'Start again' })).toBeVisible();
    await page.getByRole('button', { name: 'Start again' }).click();
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await page.getByLabel('Saved recovery code').fill('saved-code');
    await page.getByLabel('Email confirmation code').fill('123456');
    expect(startCalls).toBe(2);
    completion.release();
    await expect(page.getByLabel('Saved recovery code')).toBeVisible();
    await expect(page.getByText('Password set. Sign in with your password to continue.')).toHaveCount(0);
    await expect(page.getByLabel('New password')).toHaveCount(0);
    api.assertNoUnexpectedRequests();
});

test('recovery proof verification serializes duplicate submits while the OTP request is pending', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const verification = createGate('recovery proof verification response');
    let verificationRequests = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => route.fulfill({ status: 202, headers, json: { success: true, data: { attemptId: '92000000-0000-4000-8000-000000000001', secret: 'recovery-secret', expiresAt: new Date(Date.now() + 300_000).toISOString(), otpExpiresAt: new Date(Date.now() + 300_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/verify`, async route => {
        verificationRequests += 1;
        await verification.wait();
        return route.fulfill({ headers, json: { success: true, data: { expiresAt: new Date(Date.now() + 600_000).toISOString(), serverNow: new Date().toISOString() } } });
    });
    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await page.getByLabel('Saved recovery code').fill('saved-code');
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm recovery proofs' }).click();
    await verification.waitForArrival();
    await expect(page.getByRole('button', { name: 'Confirming…' })).toBeDisabled();
    await page.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    await expect.poll(() => verificationRequests).toBe(1);
    verification.release();
    await expect(page.getByLabel('New password')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('recovery completion surfaces password-policy rejections without sign-in advice', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => route.fulfill({ status: 202, headers, json: { success: true, data: { attemptId: '97000000-0000-4000-8000-000000000001', secret: 'recovery-secret', expiresAt: new Date(Date.now() + 300_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/verify`, route => route.fulfill({ headers, json: { success: true, data: { expiresAt: new Date(Date.now() + 600_000).toISOString(), serverNow: new Date().toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/complete`, route => route.fulfill({ status: 409, headers, json: { success: false, error: { message: 'Password must contain at least one uppercase letter', code: 'CONFLICT', statusCode: 409 } } }));
    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await page.getByLabel('Saved recovery code').fill('saved-code');
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm recovery proofs' }).click();
    // Deterministic rejections save nothing, so the page shows the reason
    // and keeps the form instead of suggesting an unsaved password works.
    await expect(page.getByText('at least 8 characters with an uppercase letter')).toBeVisible();
    await page.getByLabel('New password').fill('all-lowercase-1!');
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByText('Password must contain at least one uppercase letter')).toBeVisible();
    expect(await page.getByRole('link', { name: 'Try signing in with this password' }).count()).toBe(0);
    await expect(page.getByLabel('New password')).toHaveValue('all-lowercase-1!');
    api.assertNoUnexpectedRequests();
});

test('recovery hides the completion deadline until proof then shows the rebound attempt deadline', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => route.fulfill({ status: 202, headers, json: { success: true, data: { attemptId: '98000000-0000-4000-8000-000000000001', secret: 'recovery-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), otpExpiresAt: new Date(Date.now() + 300_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/verify`, route => route.fulfill({ headers, json: { success: true, data: { expiresAt: new Date(Date.now() + 600_000).toISOString(), serverNow: new Date().toISOString() } } }));
    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    // The pre-verification view counts down the five-minute OTP, not the
    // ten-minute attempt window it switches to after verification.
    await expect(page.getByRole('timer')).toContainText(/Confirm both codes within [0-5]:\d\d/);
    await page.getByLabel('Saved recovery code').fill('saved-code');
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm recovery proofs' }).click();
    await expect(page.getByRole('timer')).toContainText(/Complete this recovery within 9:\d\d/);
    api.assertNoUnexpectedRequests();
});

test('expired recovery attempts show an explicit restart state', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => route.fulfill({ status: 202, headers, json: { success: true, data: { attemptId: '99000000-0000-4000-8000-000000000001', secret: 'recovery-secret', expiresAt: new Date(Date.now() - 1_000).toISOString(), otpExpiresAt: new Date(Date.now() - 1_000).toISOString() } } }));
    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await expect(page.getByText('This recovery attempt expired before completion.')).toBeVisible();
    await page.getByRole('button', { name: 'Start again' }).click();
    await expect(page.getByRole('button', { name: 'Start recovery' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('recovery deadlines use the server clock on skewed devices', async ({ page }) => {
    const api = await installSyntheticApi(page);
    // The device clock runs ten minutes fast: the expiry is device-past
    // but the server clock in the same response keeps nine minutes left.
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => route.fulfill({ status: 202, headers, json: { success: true, data: { attemptId: '9a000000-0000-4000-8000-000000000001', secret: 'recovery-secret', expiresAt: new Date(Date.now() - 30_000).toISOString(), otpExpiresAt: new Date(Date.now() - 30_000).toISOString(), serverNow: new Date(Date.now() - 600_000).toISOString() } } }));
    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await expect(page.getByRole('timer')).toContainText(/Confirm both codes within 9:(29|30|31)/);
    await expect(page.getByLabel('Saved recovery code')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('recovery without both proofs points at guidance instead of an unusable support route', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.goto('/auth/student/recovery');
    // Locked-out users cannot use the signed-in support section, so the
    // fallback links the public recovery guidance rather than /contact.
    const guidance = page.getByRole('link', { name: 'how account recovery works' });
    await expect(guidance).toBeVisible();
    await expect(guidance).toHaveAttribute('href', '/help');
    await guidance.click();
    await expect(page.getByText('If you cannot complete a recovery step, recovery cannot continue without the requested proofs. Account-specific help may require a signed-in session to inspect the account state. Receipts on an existing account remain its history.')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('fresh grants drive generation then a second re-entry activation without persisting plaintext', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '74000000-0000-4000-8000-000000000001';
    const activationBodies: unknown[] = [];
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => {
        const attemptId = (JSON.parse(route.request().postData() ?? '{}') as { attemptId?: string }).attemptId;
        return route.fulfill({ status: 201, headers, json: { success: true, data: attemptId === '75000000-0000-4000-8000-000000000002'
            ? { grantId: '76000000-0000-4000-8000-000000000002', grantSecret: 'activate-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_activate', pendingCodeId: pendingId, targetIdentityId: null, activeCodeGeneration: null }
            : { grantId: '76000000-0000-4000-8000-000000000001', grantSecret: 'generate-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: null } } });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: pendingId, code: 'one-time-recovery-code', expiresAt: new Date(Date.now() + 600_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => { activationBodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ headers, json: { success: true, data: { active: true } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 1, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString() } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=75000000-0000-4000-8000-000000000001');
    await expect(page.getByText('one-time-recovery-code')).toBeVisible();
    await expect(page.getByRole('timer')).toContainText(/Activate this code within \d+:\d\d/);
    expect(await page.evaluate(() => `${location.href}|${localStorage.getItem('awoof.session.v1')}|${sessionStorage.getItem('awoof.recovery.intent.v1.tab') ?? ''}`)).not.toContain('one-time-recovery-code');
    await page.getByRole('button', { name: 'I saved my code' }).click();
    await page.goto('/auth/student/sso/complete?reauth=75000000-0000-4000-8000-000000000002');
    await page.getByLabel('Re-enter saved recovery code').fill('one-time-recovery-code');
    await page.getByRole('button', { name: 'Activate recovery code' }).click();
    await expect(page.getByRole('heading', { name: 'Recovery code active' })).toBeVisible();
    expect(activationBodies).toEqual([{ reauthGrant: { grantId: '76000000-0000-4000-8000-000000000002', grantSecret: 'activate-grant' }, pendingCodeId: pendingId, code: 'one-time-recovery-code' }]);
    api.assertNoUnexpectedRequests();
});

test('active code replacement and removal require the old code after fresh callback', async ({ page }) => {
    const api = await installSyntheticApi(page); const bodies: unknown[] = [];
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => {
        const id = (JSON.parse(route.request().postData() ?? '{}') as { attemptId?: string }).attemptId;
        const remove = id === '77000000-0000-4000-8000-000000000002';
        return route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: remove ? '78000000-0000-4000-8000-000000000002' : '78000000-0000-4000-8000-000000000001', grantSecret: remove ? 'remove-grant' : 'replace-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: remove ? 'recovery_code_remove' : 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: 1 } } });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: '79000000-0000-4000-8000-000000000001', code: 'replacement-code' } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/remove`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ status: 204, headers }); });
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=77000000-0000-4000-8000-000000000001');
    await page.getByLabel('Current recovery code').fill('old-code'); await page.getByRole('button', { name: 'Generate replacement code' }).click();
    await expect(page.getByText('replacement-code')).toBeVisible();
    await page.goto('/auth/student/sso/complete?reauth=77000000-0000-4000-8000-000000000002');
    await page.getByLabel('Current recovery code').fill('old-code'); await page.getByRole('button', { name: 'Remove recovery code' }).click();
    await expect(page.getByRole('heading', { name: 'Recovery code removed' })).toBeVisible();
    expect(bodies).toEqual([{ reauthGrant: { grantId: '78000000-0000-4000-8000-000000000001', grantSecret: 'replace-grant' }, oldCode: 'old-code' }, { reauthGrant: { grantId: '78000000-0000-4000-8000-000000000002', grantSecret: 'remove-grant' }, oldCode: 'old-code' }]);
    api.assertNoUnexpectedRequests();
});

test('replacement activation submits the current code alongside the re-entered code', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '7f000000-0000-4000-8000-000000000001';
    const activationBodies: unknown[] = [];
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '80000000-0000-4000-8000-000000000001', grantSecret: 'activate-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_activate', pendingCodeId: pendingId, targetIdentityId: null, activeCodeGeneration: 1 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => { activationBodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ headers, json: { success: true, data: { active: true } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 2, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString() } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=81000000-0000-4000-8000-000000000001');
    await expect(page.getByRole('timer')).toContainText(/Activate this code within \d+:\d\d/);
    await page.getByLabel('Re-enter saved recovery code').fill('replacement-code');
    await page.getByLabel('Current recovery code').fill('old-code');
    await page.getByRole('button', { name: 'Activate recovery code' }).click();
    await expect(page.getByRole('heading', { name: 'Recovery code active' })).toBeVisible();
    expect(activationBodies).toEqual([{ reauthGrant: { grantId: '80000000-0000-4000-8000-000000000001', grantSecret: 'activate-grant' }, pendingCodeId: pendingId, code: 'replacement-code', oldCode: 'old-code' }]);
    api.assertNoUnexpectedRequests();
});

test('password confirmation drives generation then activation without a provider redirect', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '82000000-0000-4000-8000-000000000001';
    const bodies: unknown[] = [];
    let statusCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => { statusCalls++; return route.fulfill({ headers, json: { success: true, data: statusCalls === 1 ? { status: 'unconfigured', generation: null, pendingCodeId: null } : { status: 'active', generation: 1, pendingCodeId: null } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '83000000-0000-4000-8000-000000000001', grantSecret: 'pw-grant', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: pendingId, code: 'password-flow-code', expiresAt: new Date(Date.now() + 600_000).toISOString() } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ headers, json: { success: true, data: { active: true } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await page.getByRole('button', { name: 'Use your password instead' }).click();
    await page.getByRole('button', { name: 'Confirm identity to generate a code' }).click();
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByRole('button', { name: 'Generate code' }).click();
    await expect(page.getByText('password-flow-code')).toBeVisible();
    await expect(page.getByRole('timer')).toContainText(/Activate this code within \d+:\d\d/);
    await page.getByRole('button', { name: 'I saved my code' }).click();
    await expect(page.getByRole('timer')).toContainText(/Activate this code within \d+:\d\d/);
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByLabel('Re-enter saved recovery code').fill('password-flow-code');
    await page.getByRole('button', { name: 'Activate code' }).click();
    await expect(page.getByText('A recovery code is active.')).toBeVisible();
    expect(bodies).toEqual([
        { password: 'Correct!horse-9-battery', purpose: 'recovery_code_generate' },
        { reauthGrant: { grantId: '83000000-0000-4000-8000-000000000001', grantSecret: 'pw-grant' } },
        { password: 'Correct!horse-9-battery', purpose: 'recovery_code_activate', pendingCodeId: pendingId },
        { reauthGrant: { grantId: '83000000-0000-4000-8000-000000000001', grantSecret: 'pw-grant' }, pendingCodeId: pendingId, code: 'password-flow-code' },
    ]);
    api.assertNoUnexpectedRequests();
});

test('ambiguous password activation reconciles against status and renders success', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = 'b0000000-0000-4000-8000-000000000001';
    let statusCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => { statusCalls++; return route.fulfill({ headers, json: { success: true, data: statusCalls === 1 ? { status: 'pending', generation: 1, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString() } : { status: 'active', generation: 1, pendingCodeId: null } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: 'b1000000-0000-4000-8000-000000000001', grantSecret: 'pw-grant', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'boom', statusCode: 500 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await page.getByRole('button', { name: 'Use your password instead' }).click();
    await page.getByRole('button', { name: 'Confirm identity to activate saved code' }).click();
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByLabel('Re-enter saved recovery code').fill('saved-code');
    await page.getByRole('button', { name: 'Activate code' }).click();
    // The activation committed but the response was lost: status shows
    // the flipped code instead of a password failure.
    await expect(page.getByText('A recovery code is active.')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('ambiguous password removal reconciles against status and renders success', async ({ page }) => {
    const api = await installSyntheticApi(page);
    let statusCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => { statusCalls++; return route.fulfill({ headers, json: { success: true, data: statusCalls === 1 ? { status: 'active', generation: 1, pendingCodeId: null } : { status: 'unconfigured', generation: null, pendingCodeId: null } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: 'b2000000-0000-4000-8000-000000000001', grantSecret: 'pw-grant', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/remove`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'boom', statusCode: 500 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await expect(page.getByText('A recovery code is active.')).toBeVisible();
    await page.getByRole('button', { name: 'Use your password instead' }).click();
    await page.getByRole('button', { name: 'Remove recovery code' }).click();
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByLabel('Current recovery code').fill('old-code');
    await page.getByRole('button', { name: 'Remove code' }).click();
    // The removal committed but the response was lost: status shows the
    // cleared setup instead of a password failure.
    await expect(page.getByRole('button', { name: 'Confirm identity to generate a code' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('ambiguous password generation guides cancel-and-regenerate when a new pending appears', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = 'b4000000-0000-4000-8000-000000000001';
    let statusCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => { statusCalls++; return route.fulfill({ headers, json: { success: true, data: statusCalls === 1 ? { status: 'unconfigured', generation: null, pendingCodeId: null } : { status: 'pending', generation: 1, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString() } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: 'b5000000-0000-4000-8000-000000000001', grantSecret: 'pw-grant', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'boom', statusCode: 500 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await page.getByRole('button', { name: 'Use your password instead' }).click();
    await page.getByRole('button', { name: 'Confirm identity to generate a code' }).click();
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByRole('button', { name: 'Generate code' }).click();
    // A code was created but its one-time display is lost: guide back to
    // cancel-and-regenerate instead of a dead activate.
    await expect(page.getByText('cannot be shown again')).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('button', { name: 'Cancel pending code' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('fresh unlink proof continues to identity removal with a last-method escape', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '84000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '85000000-0000-4000-8000-000000000001', grantSecret: 'unlink-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'unlink', pendingCodeId: null, targetIdentityId: targetId, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, route => route.fulfill({ headers, json: { success: true, data: { unlinked: true, sessionRevoked: false } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=86000000-0000-4000-8000-000000000001');
    await expect(page.getByRole('heading', { name: 'Sign-in method removed' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('unlink that revokes the active session clears local tokens and signs out', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '8a000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '8b000000-0000-4000-8000-000000000001', grantSecret: 'unlink-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'unlink', pendingCodeId: null, targetIdentityId: targetId, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, route => route.fulfill({ headers, json: { success: true, data: { unlinked: true, sessionRevoked: true } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=8c000000-0000-4000-8000-000000000001');
    await expect(page.getByText('You have been signed out.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to sign-in' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('awoof.session.v1'))).toContain('"signed_out"');
    api.assertNoUnexpectedRequests();
});

test('late unlink success for the previous browser session cannot clear the replacement session', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const unlink = createGate('previous-session identity unlink');
    const targetId = '8d000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '8e000000-0000-4000-8000-000000000001', grantSecret: 'unlink-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'unlink', pendingCodeId: null, targetIdentityId: targetId, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, async route => {
        await unlink.wait();
        return route.fulfill({ headers, json: { success: true, data: { unlinked: true, sessionRevoked: true } } });
    });

    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=8f000000-0000-4000-8000-000000000001');
    await unlink.waitForArrival();
    await page.evaluate(() => {
        const key = 'awoof.session.v1';
        const value = JSON.stringify({ v: 1, state: 'active', sessionId: 'replacement-vendor-session', accessToken: 'vendor-access', refreshToken: 'vendor-refresh' });
        localStorage.setItem(key, value);
        const event = new Event('storage');
        Object.defineProperties(event, { key: { value: key }, newValue: { value } });
        window.dispatchEvent(event);
    });
    await expect(page.getByRole('heading', { name: 'Security confirmation unavailable' })).toBeVisible();
    unlink.release();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('awoof.session.v1') ?? 'null')?.accessToken)).toBe('vendor-access');
    await expect(page.getByText('You have been signed out.')).toHaveCount(0);
    api.assertNoUnexpectedRequests();
});

test('late link success for the previous browser session cannot clear handoff or redirect the replacement session', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const link = createGate('previous-session provider link');
    const handoffId = '8f000000-0000-4000-8000-000000000002';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '8f000000-0000-4000-8000-000000000003', grantSecret: 'link-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'link', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/link`, async route => {
        await link.wait();
        return route.fulfill({ status: 200, headers, json: { success: true, data: { outcome: 'linked', reactivated: false, schoolAssertion: 'synthetic-assertion' } } });
    });

    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
        key: 'awoof.sso.handoff.v1.tab',
        value: { handoffId, handoffSecret: 'synthetic-handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace' },
    });
    await page.goto('/auth/student/sso/complete?reauth=8f000000-0000-4000-8000-000000000004');
    await link.waitForArrival();
    await page.evaluate(() => {
        const key = 'awoof.session.v1';
        const value = JSON.stringify({ v: 1, state: 'active', sessionId: 'replacement-vendor-session', accessToken: 'vendor-access', refreshToken: 'vendor-refresh' });
        localStorage.setItem(key, value);
        const event = new Event('storage');
        Object.defineProperties(event, { key: { value: key }, newValue: { value } });
        window.dispatchEvent(event);
    });
    await expect(page.getByRole('heading', { name: 'Security confirmation unavailable' })).toBeVisible();
    link.release();
    await expect(page).toHaveURL(/\/auth\/student\/sso\/complete/);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), 'awoof.sso.handoff.v1.tab')).toContain(handoffId);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('awoof.session.v1') ?? 'null')?.accessToken)).toBe('vendor-access');
    api.assertNoUnexpectedRequests();
});

test('fresh unlink proof surfaces the last-method guard instead of failing', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '87000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '88000000-0000-4000-8000-000000000001', grantSecret: 'unlink-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'unlink', pendingCodeId: null, targetIdentityId: targetId, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, route => route.fulfill({ status: 409, headers, json: { success: false, error: { message: 'Removing this sign-in would lock the account.', code: 'SSO_LAST_LOGIN_METHOD', statusCode: 409 } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=89000000-0000-4000-8000-000000000001');
    await expect(page.getByRole('heading', { name: 'Cannot remove the last sign-in method' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('ambiguous provider unlink failure reconciles against the reloaded identity list', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '9a000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '9b000000-0000-4000-8000-000000000001', grantSecret: 'unlink-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'unlink', pendingCodeId: null, targetIdentityId: targetId, activeCodeGeneration: null } } }));
    // The revocation commits but its response is lost: the reconcile
    // reload finds the target gone and renders success, not failure.
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'boom', statusCode: 500 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=9c000000-0000-4000-8000-000000000001');
    await expect(page.getByRole('heading', { name: 'Sign-in method removed' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('provider unlink reconcile treats a cleared session as signed-out removal', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '9d000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '9e000000-0000-4000-8000-000000000001', grantSecret: 'unlink-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'unlink', pendingCodeId: null, targetIdentityId: targetId, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'boom', statusCode: 500 } } }));
    // The revocation committed and cleared this session: the reload 401s
    // (refresh fails too), and the interceptor does not redirect from
    // /auth/ pages, so the page reports the signed-out removal.
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ status: 401, headers, json: { success: false, error: { message: 'gone', statusCode: 401 } } }));
    await page.route(`${apiOrigin}/api/auth/refresh`, route => route.fulfill({ status: 401, headers, json: { success: false, error: { message: 'gone', statusCode: 401 } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=9c000000-0000-4000-8000-000000000002');
    await expect(page.getByText('You have been signed out.')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('late unlink reconciliation 401 cannot clear a replacement browser session', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const identities = createGate('previous-session unlink reconciliation');
    const targetId = '9d000000-0000-4000-8000-000000000002';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '9e000000-0000-4000-8000-000000000003', grantSecret: 'unlink-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'unlink', pendingCodeId: null, targetIdentityId: targetId, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'ambiguous', statusCode: 500 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, async route => {
        await identities.wait();
        return route.fulfill({ status: 401, headers, json: { success: false, error: { message: 'gone', statusCode: 401 } } });
    });
    await page.route(`${apiOrigin}/api/auth/refresh`, route => route.fulfill({ status: 401, headers, json: { success: false, error: { message: 'gone', statusCode: 401 } } }));

    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=9e000000-0000-4000-8000-000000000004');
    await identities.waitForArrival();
    await page.evaluate(() => {
        const key = 'awoof.session.v1';
        const value = JSON.stringify({ v: 1, state: 'active', sessionId: 'replacement-vendor-session', accessToken: 'vendor-access', refreshToken: 'vendor-refresh' });
        localStorage.setItem(key, value);
        const event = new Event('storage');
        Object.defineProperties(event, { key: { value: key }, newValue: { value } });
        window.dispatchEvent(event);
    });
    await expect(page.getByRole('heading', { name: 'Security confirmation unavailable' })).toBeVisible();
    identities.release();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('awoof.session.v1') ?? 'null')?.accessToken)).toBe('vendor-access');
    await expect(page.getByText('You have been signed out.')).toHaveCount(0);
    api.assertNoUnexpectedRequests();
});

test('ambiguous provider link failure renders a link-specific outcome', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const handoffId = '67000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '68000000-0000-4000-8000-000000000001', grantSecret: 'link-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'link', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/link`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'Link is temporarily unavailable', code: 'INTERNAL', statusCode: 500 } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
        key: 'awoof.sso.handoff.v1.tab',
        value: { handoffId, handoffSecret: 'synthetic-handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace' },
    });
    await page.goto('/auth/student/sso/complete?reauth=69000000-0000-4000-8000-000000000001');
    // The link may have committed despite the lost response: report the
    // ambiguous link outcome, not a recovery-code failure.
    await expect(page.getByRole('heading', { name: 'School sign-in link unclear' })).toBeVisible();
    await expect(page.getByText('may already be linked')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('ambiguous fresh-proof link failure retains the handoff for retry', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const handoffId = '61000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '62000000-0000-4000-8000-000000000001', grantSecret: 'link-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'link', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/link`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'Link is temporarily unavailable', code: 'INTERNAL', statusCode: 500 } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
        key: 'awoof.sso.handoff.v1.tab',
        value: { handoffId, handoffSecret: 'synthetic-handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace' },
    });
    await page.goto('/auth/student/sso/complete?reauth=63000000-0000-4000-8000-000000000001');
    // The transient failure leaves no terminal outcome, so the tab keeps
    // its only copy of the live handoff for a retry with a fresh grant.
    await expect(page.getByRole('heading', { name: 'School sign-in link unclear' })).toBeVisible();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), 'awoof.sso.handoff.v1.tab')).toContain(handoffId);
    api.assertNoUnexpectedRequests();
});

test('terminal fresh-proof link mismatch spends the handoff and restarts', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const handoffId = '64000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '65000000-0000-4000-8000-000000000001', grantSecret: 'link-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'link', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/link`, route => route.fulfill({ status: 409, headers, json: { success: false, error: { message: 'Mismatch.', code: 'SSO_LINK_MISMATCH', statusCode: 409 } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
        key: 'awoof.sso.handoff.v1.tab',
        value: { handoffId, handoffSecret: 'synthetic-handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace' },
    });
    await page.goto('/auth/student/sso/complete?reauth=66000000-0000-4000-8000-000000000001');
    await expect(page.getByRole('heading', { name: 'School sign-in link unavailable' })).toBeVisible();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), 'awoof.sso.handoff.v1.tab')).toBeNull();
    api.assertNoUnexpectedRequests();
});

test('expired fresh callback and lost generation response leave no code active in the browser', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 409, headers, json: { success: false, error: { code: 'SSO_RESTART_REQUIRED' } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=7a000000-0000-4000-8000-000000000001');
    await expect(page.getByRole('heading', { name: 'Security confirmation unavailable' })).toBeVisible();
    expect(await page.evaluate(() => `${location.href}|${localStorage.getItem('awoof.session.v1')}|${sessionStorage.getItem('awoof.recovery.intent.v1.tab') ?? ''}`)).not.toContain('recovery-code');
    api.assertNoUnexpectedRequests();
});

test('provider rollback completion reports that no security change was made without replaying a proof', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=7a000000-0000-4000-8000-000000000003&reauthUnavailable=1');
    await expect(page.getByRole('heading', { name: 'School sign-in is unavailable' })).toBeVisible();
    await expect(page.getByText('No security change was made.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to account security' })).toHaveAttribute('href', '/student/security');
    api.assertNoUnexpectedRequests();
});

test('lost fresh-proof finish response offers a safe restart instead of replaying proof', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.abort('failed'));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=7a000000-0000-4000-8000-000000000002');
    await expect(page.getByRole('heading', { name: 'Security confirmation unavailable' })).toBeVisible();
    await expect(page.getByText('No recovery code was activated. Start the optional setup again.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to account security' })).toHaveAttribute('href', '/student/security');
    expect(await page.evaluate(() => `${location.href}|${localStorage.getItem('awoof.session.v1')}|${sessionStorage.getItem('awoof.recovery.intent.v1.tab') ?? ''}`)).not.toContain('recovery-code');
    api.assertNoUnexpectedRequests();
});

test('server callback context does not require a tab intent and never persists generated plaintext', async ({ page }) => {
    const api = await installSyntheticApi(page); const pendingId = '7b000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '7c000000-0000-4000-8000-000000000001', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: pendingId, code: 'display-once-code' } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=7d000000-0000-4000-8000-000000000001');
    await expect(page.getByText('display-once-code')).toBeVisible();
    expect(await page.evaluate(() => `${location.href}|${localStorage.getItem('awoof.session.v1')}`)).not.toContain('display-once-code');
    api.assertNoUnexpectedRequests();
});

test('same-account browser session replacement hides an already displayed recovery code', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '7c000000-0000-4000-8000-000000000002', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: '7b000000-0000-4000-8000-000000000002', code: 'same-account-session-secret' } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=7d000000-0000-4000-8000-000000000002');
    await expect(page.getByText('same-account-session-secret')).toBeVisible();
    await page.evaluate(() => {
        const key = 'awoof.session.v1';
        const value = JSON.parse(localStorage.getItem(key) ?? 'null') as { sessionId: string };
        value.sessionId = 'same-account-new-browser-session';
        const serialized = JSON.stringify(value);
        localStorage.setItem(key, serialized);
        const event = new Event('storage');
        Object.defineProperties(event, { key: { value: key }, newValue: { value: serialized } });
        window.dispatchEvent(event);
    });
    await expect(page.getByRole('heading', { name: 'Security confirmation unavailable' })).toBeVisible();
    await expect(page.getByText('same-account-session-secret')).toHaveCount(0);
    api.assertNoUnexpectedRequests();
});

test('same-account browser session replacement discards a late recovery-code response', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const delayedGeneration = createGate('same-account recovery-code generation');
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '7c000000-0000-4000-8000-000000000003', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, async route => {
        await delayedGeneration.wait();
        return route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: '7b000000-0000-4000-8000-000000000003', code: 'late-same-account-secret' } } });
    });
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=7d000000-0000-4000-8000-000000000003');
    await delayedGeneration.waitForArrival();
    await page.evaluate(() => {
        const key = 'awoof.session.v1';
        const value = JSON.parse(localStorage.getItem(key) ?? 'null') as { sessionId: string };
        value.sessionId = 'same-account-new-browser-session';
        const serialized = JSON.stringify(value);
        localStorage.setItem(key, serialized);
        const event = new Event('storage');
        Object.defineProperties(event, { key: { value: key }, newValue: { value: serialized } });
        window.dispatchEvent(event);
    });
    await expect(page.getByRole('heading', { name: 'Security confirmation unavailable' })).toBeVisible();
    delayedGeneration.release();
    await expect(page.getByText('late-same-account-secret')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Save your recovery code' })).toHaveCount(0);
    api.assertNoUnexpectedRequests();
});

test('lost generation or activation responses recover only through server status and never reveal plaintext', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 1, pendingCodeId: '7e000000-0000-4000-8000-000000000001' } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await expect(page.getByText('A pending code exists')).toBeVisible();
    await expect(page.getByText('one-time-recovery-code')).toHaveCount(0);
    await page.unroute(`${apiOrigin}/api/auth/student/sso/recovery-code`);
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'active', generation: 1, pendingCodeId: null } } }));
    await page.reload();
    await expect(page.getByText('A recovery code is active.')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('replacement generation ignores a second click while the first request is in flight', async ({ page }) => {
    const api = await installSyntheticApi(page); let release!: () => void; let calls = 0; const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '81000000-0000-4000-8000-000000000001', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: 1 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, async route => { calls += 1; await gate; await route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: '82000000-0000-4000-8000-000000000001', code: 'new-code' } } }); });
    await page.goto('/auth/student/login'); await seedSession(page, 'student'); await page.goto('/auth/student/sso/complete?reauth=83000000-0000-4000-8000-000000000001');
    const submit = page.getByRole('button', { name: 'Generate replacement code' }); await submit.click(); await expect(submit).toBeEnabled(); expect(calls).toBe(0); await page.getByLabel('Current recovery code').fill('old-code'); await submit.click(); await expect(submit).toBeDisabled(); await submit.click({ force: true }); expect(calls).toBe(1); release(); await expect(page.getByText('new-code')).toBeVisible(); api.assertNoUnexpectedRequests();
});

test('a dropped generation response resumes only as server pending state without plaintext', async ({ page }) => {
    const api = await installSyntheticApi(page); let serverPending = false; let markServerPending!: () => void;
    const serverWrite = new Promise<void>(resolve => { markServerPending = resolve; });
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '84000000-0000-4000-8000-000000000001', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => { serverPending = true; markServerPending(); return route.abort('failed'); });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: serverPending ? 'pending' : 'unconfigured', generation: 1, pendingCodeId: serverPending ? '85000000-0000-4000-8000-000000000001' : null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student'); await page.goto('/auth/student/sso/complete?reauth=86000000-0000-4000-8000-000000000001'); await expect(page.getByRole('heading', { name: 'Security confirmation unavailable' })).toBeVisible(); await serverWrite; await page.goto('/student/security'); await expect(page.getByText('A pending code exists')).toBeVisible(); await expect(page.getByRole('button', { name: 'Cancel pending code' })).toBeVisible(); expect(await page.content()).not.toContain('new-code'); api.assertNoUnexpectedRequests();
});

test('account security lists school sign-ins and removes one with password confirmation', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '8d000000-0000-4000-8000-000000000001';
    const grantId = '8e000000-0000-4000-8000-000000000001';
    const bodies: unknown[] = [];
    let identitiesCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => { identitiesCalls++; return route.fulfill({ headers, json: { success: true, data: { identities: identitiesCalls === 1 ? [{ id: targetId, provider: 'microsoft', universityName: 'Fixture University', linkedAt: new Date().toISOString() }] : [] } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ status: 201, headers, json: { success: true, data: { grantId, grantSecret: 'unlink-pw-grant', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ headers, json: { success: true, data: { unlinked: true, sessionRevoked: false } } }); });
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await expect(page.getByText('Microsoft · Fixture University')).toBeVisible();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    // The school sign-in path starts a target-bound fresh proof; the
    // password path completes inline below.
    await expect(page.getByRole('button', { name: 'Remove with school sign-in' })).toBeVisible();
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByRole('button', { name: 'Remove with password' }).click();
    await expect(page.getByText('No school sign-ins are linked.')).toBeVisible();
    expect(bodies).toEqual([
        { password: 'Correct!horse-9-battery', purpose: 'unlink', targetIdentityId: targetId },
        { reauthGrant: { grantId, grantSecret: 'unlink-pw-grant' } },
    ]);
    api.assertNoUnexpectedRequests();
});

test('unlink that revokes the session keeps the signed-out notice across the session reset', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '97000000-0000-4000-8000-000000000001';
    const grantId = '97000000-0000-4000-8000-000000000002';
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [{ id: targetId, provider: 'microsoft', universityName: 'Fixture University', linkedAt: new Date().toISOString() }] } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId, grantSecret: 'unlink-pw-grant', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, route => route.fulfill({ headers, json: { success: true, data: { unlinked: true, sessionRevoked: true } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await expect(page.getByText('Microsoft · Fixture University')).toBeVisible();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByRole('button', { name: 'Remove with password' }).click();
    // Clearing tokens resets the page to its signed-out state; the
    // intentional-removal notice must survive that reset rather than
    // flip to the generic unavailable view. The recovery section flips
    // first, so its outage copy proves the reset already ran.
    await expect(page.getByText('Recovery-code setup is unavailable. Sign in again and retry. If school sign-in is unavailable, use recovery only if you already saved a recovery code.')).toBeVisible();
    await expect(page.getByText('The removed sign-in had issued this session, so you were signed out.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to sign-in' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('ambiguous unlink failure reconciles against the reloaded identity list', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '98000000-0000-4000-8000-000000000001';
    const grantId = '99000000-0000-4000-8000-000000000001';
    let identitiesCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => { identitiesCalls++; return route.fulfill({ headers, json: { success: true, data: { identities: identitiesCalls === 1 ? [{ id: targetId, provider: 'microsoft', universityName: 'Fixture University', linkedAt: new Date().toISOString() }] : [] } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId, grantSecret: 'unlink-pw-grant', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }));
    // The revocation commits but its response is lost: the reconcile
    // reload finds the target gone and renders success, not failure.
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'boom', statusCode: 500 } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await expect(page.getByText('Microsoft · Fixture University')).toBeVisible();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByRole('button', { name: 'Remove with password' }).click();
    await expect(page.getByText('No school sign-ins are linked.')).toBeVisible();
    await expect(page.getByText('Removal failed. Try again.')).toHaveCount(0);
    api.assertNoUnexpectedRequests();
});

test('account security surfaces the last-method guard instead of removing', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '8f000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [{ id: targetId, provider: 'google', universityName: 'Fixture University', linkedAt: new Date().toISOString() }] } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '90000000-0000-4000-8000-000000000001', grantSecret: 'unlink-pw-grant', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities/${targetId}/unlink`, route => route.fulfill({ status: 409, headers, json: { success: false, error: { message: 'last', code: 'SSO_LAST_LOGIN_METHOD', statusCode: 409 } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await expect(page.getByText('Google · Fixture University')).toBeVisible();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByRole('button', { name: 'Remove with password' }).click();
    await expect(page.getByText('This is the last sign-in method. Link another school sign-in first.')).toBeVisible();
    await expect(page.getByText('Google · Fixture University')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('identity controls stay available when recovery status is unavailable', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const targetId = '93000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ status: 503, headers, json: { success: false, error: { message: 'Account recovery is unavailable', statusCode: 503 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [{ id: targetId, provider: 'microsoft', universityName: 'Fixture University', linkedAt: new Date().toISOString() }] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    // The recovery section reports its own outage inline while the
    // already-loaded school sign-in stays removable.
    await expect(page.getByText('Recovery-code setup is unavailable.')).toBeVisible();
    await expect(page.getByText('Microsoft · Fixture University')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('pending-code deadlines use the server clock on skewed devices', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '9b000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 1, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() - 30_000).toISOString(), serverNow: new Date(Date.now() - 600_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    // The device-past deadline is server-live, so the pending view and
    // its countdown render instead of the expired restart state.
    await expect(page.getByRole('timer')).toContainText(/Activate this code within 9:(29|30|31)/);
    await expect(page.getByRole('button', { name: 'Confirm identity to activate saved code' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('replacement deadlines use the server clock on skewed devices', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '9c000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '9d000000-0000-4000-8000-000000000001', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: 1 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: pendingId, code: 'skewed-replacement-code', expiresAt: new Date(Date.now() - 30_000).toISOString(), serverNow: new Date(Date.now() - 600_000).toISOString() } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=9e000000-0000-4000-8000-000000000001');
    await page.getByLabel('Current recovery code').fill('old-code');
    await page.getByRole('button', { name: 'Generate replacement code' }).click();
    // The replacement response carries the skew sample, so the fresh
    // code displays with its countdown instead of the expired view.
    await expect(page.getByText('skewed-replacement-code')).toBeVisible();
    await expect(page.getByRole('timer')).toContainText(/Activate this code within 9:(29|30|31)/);
    api.assertNoUnexpectedRequests();
});

test('ambiguous activation reconciles against status and renders success', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '9f000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: 'a0000000-0000-4000-8000-000000000001', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_activate', pendingCodeId: pendingId, targetIdentityId: null, activeCodeGeneration: null } } }));
    let statusCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => {
        statusCalls++;
        return statusCalls === 1
            ? route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 1, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString(), serverNow: new Date().toISOString() } } })
            : route.fulfill({ headers, json: { success: true, data: { status: 'active', generation: 1, pendingCodeId: null, pendingExpiresAt: null, serverNow: new Date().toISOString() } } });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'unavailable' } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=a1000000-0000-4000-8000-000000000001');
    await page.getByLabel('Re-enter saved recovery code').fill('saved-code');
    await page.getByRole('button', { name: 'Activate recovery code' }).click();
    // The activation committed but the response was lost: the consumed
    // grant cannot retry, so status confirms the active code instead.
    await expect(page.getByRole('heading', { name: 'Recovery code active' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('ambiguous activation rejects a stale active generation after replacement expiry', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = 'a5000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: 'a6000000-0000-4000-8000-000000000001', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_activate', pendingCodeId: pendingId, targetIdentityId: null, activeCodeGeneration: 1 } } }));
    let statusCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => {
        statusCalls++;
        return statusCalls === 1
            ? route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 2, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString(), serverNow: new Date().toISOString() } } })
            : route.fulfill({ headers, json: { success: true, data: { status: 'active', generation: 1, pendingCodeId: null, pendingExpiresAt: null, serverNow: new Date().toISOString() } } });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'unavailable' } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=a7000000-0000-4000-8000-000000000001');
    await page.getByLabel('Re-enter saved recovery code').fill('saved-code');
    await page.getByLabel('Current recovery code').fill('old-code');
    await page.getByRole('button', { name: 'Activate recovery code' }).click();
    // The pending replacement never committed and the old generation is
    // still authoritative: an unrelated active code must not read as the
    // newly saved code's success.
    await expect(page.getByText('This confirmation could not be completed.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Activate recovery code' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recovery code active' })).toHaveCount(0);
    api.assertNoUnexpectedRequests();
});

test('ambiguous activation keeps the form when status shows the code still pending', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = 'a2000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: 'a3000000-0000-4000-8000-000000000001', grantSecret: 'grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_activate', pendingCodeId: pendingId, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 1, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString(), serverNow: new Date().toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'unavailable' } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=a4000000-0000-4000-8000-000000000001');
    await page.getByLabel('Re-enter saved recovery code').fill('saved-code');
    await page.getByRole('button', { name: 'Activate recovery code' }).click();
    await expect(page.getByText('This confirmation could not be completed.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Activate recovery code' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('failed school sign-in start keeps the password fallback available', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '91000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/microsoft/start`, route => route.fulfill({ status: 503, headers, json: { success: false, error: { message: 'unavailable', statusCode: 503 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '92000000-0000-4000-8000-000000000001', grantSecret: 'pw-grant', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { pendingCodeId: pendingId, code: 'fallback-code' } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await page.getByRole('button', { name: 'Confirm identity to generate a code' }).click();
    await expect(page.getByText('School sign-in confirmation is unavailable right now.')).toBeVisible();
    // The password toggle survives the school failure: the
    // provider-independent flow still completes generation.
    await page.getByRole('button', { name: 'Use your password instead' }).click();
    await page.getByRole('button', { name: 'Confirm identity to generate a code' }).click();
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByRole('button', { name: 'Generate code' }).click();
    await expect(page.getByText('fallback-code')).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('account security links a new school sign-in through school confirmation', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const bodies: unknown[] = [];
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/microsoft/start`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ status: 503, headers, json: { success: false, error: { message: 'unavailable', statusCode: 503 } } }); });
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await expect(page.getByText('No school sign-ins are linked.')).toBeVisible();
    // Linking confirms against the signed-in account with a Microsoft
    // fresh proof, so passwordless owners are not sent down a password
    // journey. The failure path stays inline with the session intact.
    await page.getByRole('button', { name: 'Link a school sign-in' }).click();
    await expect(page.getByText('School sign-in confirmation could not start.')).toBeVisible();
    expect(bodies).toEqual([{ purpose: 'link' }]);
    expect(api.logoutCalls).toBe(0);
    await expect(page).toHaveURL(/\/student\/security$/);
    api.assertNoUnexpectedRequests();
});

test('an expired pending code shows a restart state instead of a usable activation form', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '93000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: '94000000-0000-4000-8000-000000000001', grantSecret: 'activate-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_activate', pendingCodeId: pendingId, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 1, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 2_000).toISOString() } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=95000000-0000-4000-8000-000000000001');
    await expect(page.getByRole('timer')).toContainText(/Activate this code within \d+:\d\d/);
    await expect(page.getByRole('heading', { name: 'Pending code expired' })).toBeVisible();
    await expect(page.getByText('expired before activation and cannot recover your account')).toBeVisible();
    expect(await page.getByRole('button', { name: 'Activate recovery code' }).count()).toBe(0);
    api.assertNoUnexpectedRequests();
});

test('an expired pending on account security refreshes to current status and restarts', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = '96000000-0000-4000-8000-000000000001';
    let statusCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => { statusCalls++; return route.fulfill({ headers, json: { success: true, data: statusCalls === 1 ? { status: 'pending', generation: 1, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 2_000).toISOString() } : { status: 'unconfigured', generation: 1, pendingCodeId: null, pendingExpiresAt: null } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await expect(page.getByRole('timer')).toContainText(/Activate this code within \d+:\d\d/);
    await expect(page.getByText('expired before activation and cannot recover your account')).toBeVisible();
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(page.getByRole('button', { name: 'Confirm identity to generate a code' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('re-enrollment after account recovery requires the password path on account security', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/me`, route => route.fulfill({ headers, json: { success: true, data: { id: '00000000-0000-4000-8000-000000000001', email: 'student@approved.test', role: 'student', verificationStatus: 'verified', recoveryReenrollmentRequired: true } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    let schoolStartCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/microsoft/start`, route => { schoolStartCalls++; return route.fulfill({ status: 201, headers, json: { success: true, data: { authorizationUrl: 'https://provider.example.invalid/authorize' } } }); });
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    // generate() rejects provider-backed grants while the re-enrollment
    // marker stands, so the page must not offer the school round-trip.
    await expect(page.getByText('School sign-in cannot be used for this enrollment.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use your password instead' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Confirm identity to generate a code' }).click();
    await expect(page.getByRole('heading', { name: 'Confirm with your password' })).toBeVisible();
    expect(schoolStartCalls).toBe(0);
    api.assertNoUnexpectedRequests();
});

test('marketplace surfaces recovery-code re-enrollment after account recovery', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/me`, route => route.fulfill({ headers, json: { success: true, data: { id: '00000000-0000-4000-8000-000000000001', email: 'student@approved.test', role: 'student', verificationStatus: 'verified', recoveryReenrollmentRequired: true } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/marketplace');
    await expect(page.getByText('Account recovery used your only recovery code.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Set up a new code' })).toHaveAttribute('href', '/student/security');
    api.assertNoUnexpectedRequests();
});

test('marketplace offers recovery setup after a fresh passwordless signup', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await markFreshSignupForCurrentSession(page);
    await page.goto('/marketplace');
    // The offer surfaces after the requested continuation, outside the
    // signup journey, and states the stakes before the user can skip it.
    await expect(page.getByText('losing your school sign-in may prevent account access.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Save your recovery code' })).toHaveAttribute('href', '/student/security');
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByText('losing your school sign-in may prevent account access.')).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('awoof.passwordless-signup-fresh'))).toBeNull();
    api.assertNoUnexpectedRequests();
});

test('marketplace hides the signup recovery offer once a code exists', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'active', generation: 1, pendingCodeId: null } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await markFreshSignupForCurrentSession(page);
    await page.goto('/marketplace');
    await expect(page.getByText('losing your school sign-in may prevent account access.')).toHaveCount(0);
    // The marker clears in the status response handler, which can land
    // after the hidden-offer assertion, so poll instead of reading once.
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('awoof.passwordless-signup-fresh'))).toBeNull();
    api.assertNoUnexpectedRequests();
});

test('marketplace drops a late signup recovery response after the browser session changes accounts', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const previousAccountStatus = createGate('previous account signup recovery status');
    await page.route(`${apiOrigin}/api/auth/me`, route => {
        const isCurrentAccount = (route.request().headers().authorization ?? '').includes('student-b-access');
        return route.fulfill({ headers, json: { success: true, data: {
            id: isCurrentAccount ? '00000000-0000-4000-8000-000000000009' : '00000000-0000-4000-8000-000000000001',
            email: isCurrentAccount ? 'student-b@approved.test' : 'student@approved.test',
            role: 'student', verificationStatus: 'verified',
        } } });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, async route => {
        await previousAccountStatus.wait();
        return route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } });
    });
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await markFreshSignupForCurrentSession(page);
    await page.goto('/marketplace');
    await previousAccountStatus.waitForArrival();
    await page.evaluate(() => {
        const value = JSON.stringify({ v: 1, state: 'active', sessionId: 'student-b-session', accessToken: 'student-b-access', refreshToken: 'student-b-refresh' });
        localStorage.setItem('awoof.session.v1', value);
        const event = new Event('storage');
        Object.defineProperties(event, { key: { value: 'awoof.session.v1' }, newValue: { value } });
        window.dispatchEvent(event);
    });
    await expect(page.getByText('Hey student-b, savings are warming up')).toBeVisible();
    previousAccountStatus.release();
    await expect(page.getByText('losing your school sign-in may prevent account access.')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('awoof.passwordless-signup-fresh'))).toBeNull();
    api.assertNoUnexpectedRequests();
});

test('ambiguous provider-backed removal reconciles to the committed removal', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: 'c1000000-0000-4000-8000-000000000001', grantSecret: 'remove-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_remove', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: 1 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/remove`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'boom', statusCode: 500 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=c1000000-0000-4000-8000-000000000002');
    await page.getByLabel('Current recovery code').fill('old-code');
    await page.getByRole('button', { name: 'Remove recovery code' }).click();
    // The removal committed but the response was lost: the reloaded
    // status renders the committed removal instead of a failure.
    await expect(page.getByRole('heading', { name: 'Recovery code removed' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('ambiguous provider-backed replacement guides cancel-and-regenerate', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = 'c2000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: 'c2000000-0000-4000-8000-000000000002', grantSecret: 'replace-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: 1 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'boom', statusCode: 500 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 2, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString() } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=c2000000-0000-4000-8000-000000000003');
    await page.getByLabel('Current recovery code').fill('old-code');
    await page.getByRole('button', { name: 'Generate replacement code' }).click();
    // The replacement committed but its one-time display is lost with the
    // response: guide cancel-and-regenerate instead of reporting failure.
    await expect(page.getByRole('heading', { name: 'Replacement code unclear' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to account security' })).toHaveAttribute('href', '/student/security');
    api.assertNoUnexpectedRequests();
});

test('ambiguous password activation keeps the form when status falls back to the older code', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = 'c3000000-0000-4000-8000-000000000001';
    let statusCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => { statusCalls++; return route.fulfill({ headers, json: { success: true, data: statusCalls === 1 ? { status: 'pending', generation: 2, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString() } : { status: 'active', generation: 1, pendingCodeId: null } } }); });
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: 'c3000000-0000-4000-8000-000000000002', grantSecret: 'pw-grant', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/activate`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'boom', statusCode: 500 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/student/security');
    await page.getByRole('button', { name: 'Use your password instead' }).click();
    await page.getByRole('button', { name: 'Confirm identity to activate saved code' }).click();
    await page.getByLabel('Current password').fill('Correct!horse-9-battery');
    await page.getByLabel('Re-enter saved recovery code').fill('saved-code');
    await page.getByRole('button', { name: 'Activate code' }).click();
    // The pending candidate died before the reload, so status falls back
    // to the older active code: the older generation must not read as the
    // replacement succeeding.
    await expect(page.getByText('Password confirmation failed. Check the entries and try again.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Activate code' })).toBeVisible();
    await expect(page.getByText('A recovery code is active.')).toHaveCount(0);
    api.assertNoUnexpectedRequests();
});

test('ambiguous first generation routes a committed pending to cancel-and-regenerate', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const pendingId = 'c4000000-0000-4000-8000-000000000001';
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: 'c4000000-0000-4000-8000-000000000002', grantSecret: 'first-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_generate', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code/generate`, route => route.fulfill({ status: 500, headers, json: { success: false, error: { message: 'boom', statusCode: 500 } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers, json: { success: true, data: { status: 'pending', generation: 1, pendingCodeId: pendingId, pendingExpiresAt: new Date(Date.now() + 600_000).toISOString() } } }));
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=c4000000-0000-4000-8000-000000000003');
    // The initial generation committed but its one-time display is lost:
    // route to cancel-and-regenerate instead of the generic failed view.
    await expect(page.getByRole('heading', { name: 'Replacement code unclear' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to account security' })).toHaveAttribute('href', '/student/security');
    api.assertNoUnexpectedRequests();
});

test('recovery restarts reuse the tab idempotency binding for cooldown retries', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const bodies: unknown[] = [];
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => { bodies.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ status: 202, headers, json: { success: true, data: { attemptId: 'c5000000-0000-4000-8000-000000000001', secret: 'recovery-secret', expiresAt: new Date(Date.now() + 300_000).toISOString() } } }); });
    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await page.getByLabel('Saved recovery code').fill('saved-code');
    await page.getByRole('button', { name: 'Cancel and restart' }).click();
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await expect(page.getByLabel('Saved recovery code')).toBeVisible();
    // Both submits carry the same tab binding, so the second is a bound
    // cooldown retry instead of an unbound replacement attempt.
    expect(bodies).toHaveLength(2);
    const first = bodies[0] as { email?: unknown; purpose?: unknown; idempotencyKey?: unknown };
    const second = bodies[1] as { email?: unknown; purpose?: unknown; idempotencyKey?: unknown };
    expect(typeof first.idempotencyKey).toBe('string');
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    api.assertNoUnexpectedRequests();
});

test('purpose switch keeps the recovery binding and stale proof failures cannot overwrite a restarted form', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const delayedVerify = createGate('old-purpose recovery proof failure');
    const starts: Array<{ email?: string; purpose?: string; idempotencyKey?: string }> = [];
    let verifyCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => {
        const body = JSON.parse(route.request().postData() ?? '{}') as { email?: string; purpose?: string; idempotencyKey?: string };
        starts.push(body);
        const first = starts.length === 1;
        return route.fulfill({ status: 202, headers, json: { success: true, data: {
            attemptId: first ? 'c5100000-0000-4000-8000-000000000001' : 'c5100000-0000-4000-8000-000000000002',
            secret: first ? 'old-purpose-secret' : 'new-purpose-secret',
            expiresAt: new Date(Date.now() + (first ? 3_000 : 300_000)).toISOString(),
            otpExpiresAt: new Date(Date.now() + (first ? 3_000 : 300_000)).toISOString(),
            serverNow: new Date().toISOString(),
        } } });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/verify`, async route => {
        verifyCalls += 1;
        await delayedVerify.wait();
        return route.fulfill({ status: 400, headers, json: { success: false, error: { message: 'Recovery proof could not be confirmed', code: 'INVALID_PROOF', statusCode: 400 } } });
    });

    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await page.getByLabel('Saved recovery code').fill('saved-code');
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm recovery proofs' }).click();
    await delayedVerify.waitForArrival();

    // Let the OTP deadline expire while verification is pending. Restart
    // is intentionally available from the expiry view; the old request
    // must not restore its former purpose or write an error into the new form.
    await page.getByRole('button', { name: 'Start again' }).click();
    await page.getByLabel('I think my sign-in was compromised').check();
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await expect(page.getByLabel('Saved recovery code')).toBeVisible();
    delayedVerify.release();
    await expect(page.getByLabel('Saved recovery code')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Recovery proof could not be confirmed' })).toHaveCount(0);

    expect(verifyCalls).toBe(1);
    expect(starts).toHaveLength(2);
    expect(starts[0]?.purpose).toBe('lost_access');
    expect(starts[1]?.purpose).toBe('compromise');
    expect(starts[0]?.idempotencyKey).toBeTruthy();
    expect(starts[1]?.idempotencyKey).toBe(starts[0]?.idempotencyKey);
    api.assertNoUnexpectedRequests();
});

test('stale successful recovery proof after expiry restart cannot restore the old purpose completion view', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const delayedVerify = createGate('old-purpose recovery proof success');
    let starts = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/start`, route => {
        starts += 1;
        const first = starts === 1;
        return route.fulfill({ status: 202, headers, json: { success: true, data: {
            attemptId: first ? 'c5200000-0000-4000-8000-000000000001' : 'c5200000-0000-4000-8000-000000000002',
            secret: first ? 'old-purpose-secret' : 'new-purpose-secret',
            expiresAt: new Date(Date.now() + (first ? 3_000 : 300_000)).toISOString(),
            otpExpiresAt: new Date(Date.now() + (first ? 3_000 : 300_000)).toISOString(),
            serverNow: new Date().toISOString(),
        } } });
    });
    await page.route(`${apiOrigin}/api/auth/student/sso/account-recovery/verify`, async route => {
        await delayedVerify.wait();
        return route.fulfill({ headers, json: { success: true, data: { expiresAt: new Date(Date.now() + 600_000).toISOString(), serverNow: new Date().toISOString() } } });
    });

    await page.goto('/auth/student/recovery');
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await page.getByLabel('Saved recovery code').fill('saved-code');
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm recovery proofs' }).click();
    await delayedVerify.waitForArrival();
    await page.getByRole('button', { name: 'Start again' }).click();
    await page.getByLabel('I think my sign-in was compromised').check();
    await page.getByLabel('School email').fill('student@school.example');
    await page.getByRole('button', { name: 'Start recovery' }).click();
    await expect(page.getByLabel('Saved recovery code')).toBeVisible();
    delayedVerify.release();
    await expect(page.getByLabel('Saved recovery code')).toBeVisible();
    await expect(page.getByLabel('New password')).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: 'Recovery proof could not be confirmed' })).toHaveCount(0);
    expect(starts).toBe(2);
    api.assertNoUnexpectedRequests();
});

test('duplicate reauth callback waits instead of failing the in-flight confirmation', async ({ page }) => {
    const api = await installSyntheticApi(page);
    let finishCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => { finishCalls++; return route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: 'c6000000-0000-4000-8000-000000000001', grantSecret: 'remove-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_remove', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: 1 } } }); });
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=c6000000-0000-4000-8000-000000000002&reauthDuplicate=1');
    // No finish is posted on landing: the waiting view holds, then the
    // backoff poll exchanges the winner's proof without any click.
    await expect(page.getByRole('heading', { name: 'Confirmation still completing' })).toBeVisible();
    expect(finishCalls).toBe(0);
    await expect(page.getByRole('heading', { name: 'Remove recovery code' })).toBeVisible();
    expect(finishCalls).toBe(1);
    api.assertNoUnexpectedRequests();
});

test('duplicate manual fresh-proof checks do not race or hide the winning grant', async ({ page }) => {
    const api = await installSyntheticApi(page);
    let finishCalls = 0;
    let releaseWinner!: () => void;
    const winnerGate = new Promise<void>(resolve => { releaseWinner = resolve; });
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, async route => {
        finishCalls += 1;
        if (finishCalls > 1) {
            return route.fulfill({ status: 409, headers, json: { success: false, error: { message: 'Already consumed', code: 'CONFLICT', statusCode: 409 } } });
        }
        await winnerGate;
        return route.fulfill({ status: 201, headers, json: { success: true, data: { grantId: 'c6000000-0000-4000-8000-000000000004', grantSecret: 'remove-grant', expiresAt: new Date(Date.now() + 60_000).toISOString(), purpose: 'recovery_code_remove', pendingCodeId: null, targetIdentityId: null, activeCodeGeneration: 1 } } });
    });
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=c6000000-0000-4000-8000-000000000005&reauthDuplicate=1');
    const checkAgain = page.getByRole('button', { name: 'Check again' });
    await expect(checkAgain).toBeVisible();
    await checkAgain.evaluate(button => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect.poll(() => finishCalls).toBe(1);
    await page.waitForTimeout(100);
    expect(finishCalls).toBe(1);
    releaseWinner();
    await expect(page.getByRole('heading', { name: 'Remove recovery code' })).toBeVisible();
    expect(finishCalls).toBe(1);
    api.assertNoUnexpectedRequests();
});

test('still-redeeming checks stay waiting instead of failing', async ({ page }) => {
    const api = await installSyntheticApi(page);
    let finishCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/reauth/finish`, route => { finishCalls++; return route.fulfill({ status: 409, headers, json: { success: false, error: { message: 'Student SSO reauthentication is still completing', code: 'CONFLICT', statusCode: 409, details: { retryable: true } } } }); });
    await page.goto('/auth/student/login'); await seedSession(page, 'student');
    await page.goto('/auth/student/sso/complete?reauth=c6000000-0000-4000-8000-000000000003&reauthDuplicate=1');
    await expect(page.getByRole('heading', { name: 'Confirmation still completing' })).toBeVisible();
    // Retryable rejections poll on (1s, 2s) without ever converting to
    // the permanent failed view.
    await page.waitForTimeout(3500);
    await expect(page.getByRole('heading', { name: 'Confirmation still completing' })).toBeVisible();
    expect(finishCalls).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});
