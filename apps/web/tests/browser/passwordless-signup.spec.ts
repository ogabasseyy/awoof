import { expect, test } from '@playwright/test';
import { apiOrigin, appOrigin, installSyntheticApi, replaceSession } from './fixtures';

const HANDOFF_KEY = 'awoof.sso.handoff.v1.tab';
const HANDOFF_ID = '71000000-0000-4000-8000-000000000001';
const headers = { 'access-control-allow-origin': appOrigin, 'access-control-allow-credentials': 'true' };
const expiresAt = () => new Date(Date.now() + 10 * 60_000).toISOString();

test('an unlinked Microsoft handoff creates a passwordless pending-enrollment account after OTP and separate assent', async ({ page }) => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/signup/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        const body = JSON.parse(route.request().postData() ?? '{}');
        requests.push({ path, body });
        if (path.endsWith('/context')) return route.fulfill({ json: { success: true, data: { email: 'student@school.example', universityId: '72000000-0000-4000-8000-000000000001', termsVersion: '2026-01', noticeVersion: '2026-01', noticeText: 'Synthetic verification processing notice.', expiresAt: expiresAt() } }, headers });
        if (path.endsWith('/send-code')) return route.fulfill({ status: 201, json: { success: true, data: { challengeId: '73000000-0000-4000-8000-000000000001', expiresAt: expiresAt() } }, headers });
        if (path.endsWith('/verify-code')) return route.fulfill({ json: { success: true, data: { verified: true, expiresAt: expiresAt() } }, headers });
        return route.fulfill({ status: 201, json: { success: true, data: { user: { id: 'student-1', email: 'student@school.example', role: 'student' }, tokens: { accessToken: 'signup-access', refreshToken: 'signup-refresh' } } }, headers });
    });
    await page.goto('/auth/student/login');
    await page.evaluate(({ key, handoffId }) => sessionStorage.setItem(key, JSON.stringify({ handoffId, handoffSecret: 'handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace' })), { key: HANDOFF_KEY, handoffId: HANDOFF_ID });
    await page.goto('/auth/student/sso/onboarding?mode=signup');
    await expect(page.getByRole('heading', { name: 'Finish setting up Awoof' })).toBeVisible();
    await expect(page.getByText('Enrollment is pending')).toBeVisible();
    await expect(page.getByRole('timer')).toContainText(/expires in \d+:\d\d/);
    await page.getByRole('button', { name: 'Send confirmation code' }).click();
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm email' }).click();
    await page.getByLabel('Full name').fill('Synthetic Student');
    await expect(page.getByText('Synthetic verification processing notice.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Terms of Service', exact: true })).toHaveAttribute('href', '/terms');
    await expect(page.getByRole('button', { name: 'Create passwordless account' })).toBeDisabled();
    await page.getByLabel('I am at least 18 years old').check();
    await page.getByLabel('I accept the current Terms').check();
    await page.getByLabel('I consent to the processing notice').check();
    await page.getByRole('button', { name: 'Create passwordless account' }).click();
    // Creation routes through the post-signup recovery notice before the
    // continuation, whatever the destination is; continuing consumes the
    // fresh-signup marker so the marketplace backstop stays silent.
    await expect(page.getByRole('heading', { name: 'Account created' })).toBeVisible();
    await expect(page.getByText('losing your school sign-in may prevent account access.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Save your recovery code' })).toHaveAttribute('href', '/student/security');
    expect(await page.evaluate(() => sessionStorage.getItem('awoof.passwordless-signup-fresh'))).toBeNull();
    // Refreshing a token within this same browser session must not dismiss
    // the post-signup recovery notice before the student chooses a path.
    await page.evaluate(() => {
        const current = JSON.parse(localStorage.getItem('awoof.session.v1') ?? '{}');
        current.accessToken = 'signup-access-rotated';
        const value = JSON.stringify(current);
        localStorage.setItem('awoof.session.v1', value);
        const event = new Event('storage');
        Object.defineProperties(event, { key: { value: 'awoof.session.v1' }, newValue: { value } });
        window.dispatchEvent(event);
    });
    await expect(page.getByRole('heading', { name: 'Account created' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/marketplace**');
    expect(requests.map(({ path }) => path)).toEqual([
        '/api/auth/student/sso/signup/context',
        '/api/auth/student/sso/signup/send-code',
        '/api/auth/student/sso/signup/verify-code',
        '/api/auth/student/sso/signup/complete',
    ]);
    expect(JSON.stringify(requests)).not.toContain('password');
    expect(await page.evaluate((key) => sessionStorage.getItem(key), HANDOFF_KEY)).toBeNull();
    expect(await page.evaluate(() => `${location.href}|${localStorage.getItem('awoof.session.v1') ?? ''}`)).not.toContain('handoff-secret');
    api.assertNoUnexpectedRequests();
});

test('an expired setup link shows an explicit restart state instead of usable controls', async ({ page }) => {
    const requests: string[] = [];
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/signup/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        requests.push(path);
        if (path.endsWith('/context')) return route.fulfill({ json: { success: true, data: { email: 'student@school.example', universityId: '72000000-0000-4000-8000-000000000001', termsVersion: '2026-01', noticeVersion: '2026-01', noticeText: 'Synthetic verification processing notice.', expiresAt: new Date(Date.now() + 3_000).toISOString() } }, headers });
        return route.fulfill({ status: 409, json: { success: false, error: { message: 'expired' } }, headers });
    });
    await page.goto('/auth/student/login');
    await page.evaluate(({ key, handoffId }) => sessionStorage.setItem(key, JSON.stringify({ handoffId, handoffSecret: 'handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace' })), { key: HANDOFF_KEY, handoffId: HANDOFF_ID });
    await page.goto('/auth/student/sso/onboarding?mode=signup');
    await expect(page.getByRole('heading', { name: 'Finish setting up Awoof' })).toBeVisible();
    // The countdown names the deadline while the link is live, then the
    // page swaps to a restart state and forgets the spent handoff.
    await expect(page.getByRole('timer')).toContainText(/expires in \d+:\d\d/);
    await expect(page.getByText('This setup link expired before setup finished.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Restart Microsoft sign-in' })).toHaveAttribute('href', '/auth/student/login');
    expect(await page.getByRole('button', { name: 'Send confirmation code' }).count()).toBe(0);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), HANDOFF_KEY)).toBeNull();
    expect(requests).toEqual(['/api/auth/student/sso/signup/context']);
    api.assertNoUnexpectedRequests();
});

test('signup deadlines use the recorded server skew on fast devices', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/signup/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        // The device clock runs ten minutes fast: the context expiry is
        // device-past but server-live, matching the handoff skew sample.
        if (path.endsWith('/context')) return route.fulfill({ json: { success: true, data: { email: 'student@school.example', universityId: '72000000-0000-4000-8000-000000000001', termsVersion: '2026-01', noticeVersion: '2026-01', noticeText: 'Synthetic verification processing notice.', expiresAt: new Date(Date.now() - 30_000).toISOString() } }, headers });
        return route.fulfill({ status: 409, json: { success: false, error: { message: 'expired' } }, headers });
    });
    await page.goto('/auth/student/login');
    await page.evaluate(({ key, handoffId }) => sessionStorage.setItem(key, JSON.stringify({ handoffId, handoffSecret: 'handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace', serverSkewMs: -600_000 })), { key: HANDOFF_KEY, handoffId: HANDOFF_ID });
    await page.goto('/auth/student/sso/onboarding?mode=signup');
    await expect(page.getByRole('heading', { name: 'Finish setting up Awoof' })).toBeVisible();
    await expect(page.getByRole('timer')).toContainText(/expires in 9:(29|30|31)/);
    await expect(page.getByRole('button', { name: 'Send confirmation code' })).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('stale assent versions refetch the new text instead of retrying rejected versions', async ({ page }) => {
    const requests: string[] = [];
    const api = await installSyntheticApi(page);
    let contextCalls = 0; let completeCalls = 0;
    await page.route(`${apiOrigin}/api/auth/student/sso/signup/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        requests.push(path);
        if (path.endsWith('/context')) { contextCalls++; const v = contextCalls === 1 ? '2026-01' : '2026-02'; return route.fulfill({ json: { success: true, data: { email: 'student@school.example', universityId: '72000000-0000-4000-8000-000000000001', termsVersion: v, noticeVersion: v, noticeText: `Synthetic notice ${v}.`, expiresAt: expiresAt() } }, headers }); }
        if (path.endsWith('/send-code')) return route.fulfill({ status: 201, json: { success: true, data: { challengeId: '73000000-0000-4000-8000-000000000001', expiresAt: expiresAt() } }, headers });
        if (path.endsWith('/verify-code')) return route.fulfill({ json: { success: true, data: { verified: true, expiresAt: expiresAt() } }, headers });
        completeCalls++;
        if (completeCalls === 1) return route.fulfill({ status: 400, json: { success: false, error: { message: 'assent', statusCode: 400 } }, headers });
        return route.fulfill({ status: 201, json: { success: true, data: { user: { id: 'student-1', email: 'student@school.example', role: 'student' }, tokens: { accessToken: 'signup-access', refreshToken: 'signup-refresh' } } }, headers });
    });
    await page.goto('/auth/student/login');
    await page.evaluate(({ key, handoffId }) => sessionStorage.setItem(key, JSON.stringify({ handoffId, handoffSecret: 'handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace' })), { key: HANDOFF_KEY, handoffId: HANDOFF_ID });
    await page.goto('/auth/student/sso/onboarding?mode=signup');
    await page.getByRole('button', { name: 'Send confirmation code' }).click();
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm email' }).click();
    await expect(page.getByText('Synthetic notice 2026-01.')).toBeVisible();
    await page.getByLabel('Full name').fill('Synthetic Student');
    await page.getByLabel('I am at least 18 years old').check();
    await page.getByLabel('I accept the current Terms').check();
    await page.getByLabel('I consent to the processing notice').check();
    await page.getByRole('button', { name: 'Create passwordless account' }).click();
    // The version-mismatch 400 refetches the new text, resets assent, and
    // keeps the entered name; the retry then completes the account.
    await expect(page.getByText('changed while you were signing up')).toBeVisible();
    await expect(page.getByText('Synthetic notice 2026-02.')).toBeVisible();
    await expect(page.getByLabel('I accept the current Terms')).not.toBeChecked();
    await expect(page.getByLabel('Full name')).toHaveValue('Synthetic Student');
    await page.getByLabel('I am at least 18 years old').check();
    await page.getByLabel('I accept the current Terms').check();
    await page.getByLabel('I consent to the processing notice').check();
    await page.getByRole('button', { name: 'Create passwordless account' }).click();
    await expect(page.getByRole('heading', { name: 'Account created' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/marketplace**');
    expect(requests).toEqual([
        '/api/auth/student/sso/signup/context',
        '/api/auth/student/sso/signup/send-code',
        '/api/auth/student/sso/signup/verify-code',
        '/api/auth/student/sso/signup/complete',
        '/api/auth/student/sso/signup/context',
        '/api/auth/student/sso/signup/complete',
    ]);
    api.assertNoUnexpectedRequests();
});

test('passwordless-session reload keeps security setup separate from enrollment benefits', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/recovery-code`, route => route.fulfill({ headers: { 'access-control-allow-origin': appOrigin, 'access-control-allow-credentials': 'true' }, json: { success: true, data: { status: 'unconfigured', generation: null, pendingCodeId: null } } }));
    await page.route(`${apiOrigin}/api/auth/student/sso/identities`, route => route.fulfill({ headers: { 'access-control-allow-origin': appOrigin, 'access-control-allow-credentials': 'true' }, json: { success: true, data: { identities: [] } } }));
    await page.goto('/auth/student/login');
    await page.evaluate(() => localStorage.setItem('awoof.session.v1', JSON.stringify({ v: 1, state: 'active', sessionId: 'signup-session', accessToken: 'signup-access', refreshToken: 'signup-refresh' })));
    await page.goto('/student/security'); await page.reload();
    await expect(page.getByRole('heading', { name: 'Account security' })).toBeVisible();
    await expect(page.getByText(/does not promise permanent access/i)).toBeVisible();
    expect(await page.getByText(/enrollment is pending/i).count()).toBe(0);
    api.assertNoUnexpectedRequests();
});

test('signup countdown switches from the OTP deadline to the handoff deadline after verification', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/signup/**`, async route => {
        const path = new URL(route.request().url()).pathname;
        const headers = { 'access-control-allow-origin': appOrigin, 'access-control-allow-credentials': 'true' };
        if (path.endsWith('/context')) return route.fulfill({ headers, json: { success: true, data: { email: 'student@school.example', universityId: '72000000-0000-4000-8000-000000000001', termsVersion: '2026-01', noticeVersion: '2026-01', noticeText: 'Synthetic processing notice.', expiresAt: expiresAt() } } });
        if (path.endsWith('/send-code')) return route.fulfill({ status: 201, headers, json: { success: true, data: { challengeId: '73000000-0000-4000-8000-000000000001', expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } } });
        if (path.endsWith('/verify-code')) return route.fulfill({ headers, json: { success: true, data: { verified: true, expiresAt: expiresAt() } } });
        return route.fulfill({ status: 409, headers, json: { success: false, error: { message: 'unexpected' } } });
    });
    await page.goto('/auth/student/login');
    await page.evaluate(({ key, handoffId }) => sessionStorage.setItem(key, JSON.stringify({ handoffId, handoffSecret: 'handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace' })), { key: HANDOFF_KEY, handoffId: HANDOFF_ID });
    await page.goto('/auth/student/sso/onboarding?mode=signup');
    await page.getByRole('button', { name: 'Send confirmation code' }).click();
    await expect(page.getByRole('timer')).toContainText(/This email confirmation code expires in [45]:\d\d\./);
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm email' }).click();
    await expect(page.getByRole('timer')).toContainText('This setup link expires in');
    api.assertNoUnexpectedRequests();
});

test('ambiguous signup completion sends a fresh sign-in restart instead of an unrepeatable retry', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/signup/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/context')) return route.fulfill({ json: { success: true, data: { email: 'student@school.example', universityId: '72000000-0000-4000-8000-000000000001', termsVersion: '2026-01', noticeVersion: '2026-01', noticeText: 'Synthetic verification processing notice.', expiresAt: expiresAt() } }, headers });
        if (path.endsWith('/send-code')) return route.fulfill({ status: 201, json: { success: true, data: { challengeId: '73000000-0000-4000-8000-000000000001', expiresAt: expiresAt() } }, headers });
        if (path.endsWith('/verify-code')) return route.fulfill({ json: { success: true, data: { verified: true, expiresAt: expiresAt() } }, headers });
        // Account creation may have committed with the response lost: the
        // consumed handoff makes every form retry fail, so the page sends
        // a fresh Microsoft sign-in that discovers the new identity.
        return route.fulfill({ status: 500, json: { success: false, error: { message: 'unavailable' } }, headers });
    });
    await page.goto('/auth/student/login');
    await page.evaluate(({ key, handoffId }) => sessionStorage.setItem(key, JSON.stringify({ handoffId, handoffSecret: 'handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace' })), { key: HANDOFF_KEY, handoffId: HANDOFF_ID });
    await page.goto('/auth/student/sso/onboarding?mode=signup');
    await page.getByRole('button', { name: 'Send confirmation code' }).click();
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm email' }).click();
    await page.getByLabel('Full name').fill('Synthetic Student');
    await page.getByLabel('I am at least 18 years old').check();
    await page.getByLabel('I accept the current Terms').check();
    await page.getByLabel('I consent to the processing notice').check();
    await page.getByRole('button', { name: 'Create passwordless account' }).click();
    await expect(page.getByText('Setup may have finished but the confirmation was lost.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in with Microsoft' })).toHaveAttribute('href', '/auth/student/login');
    expect(await page.getByRole('button', { name: 'Create passwordless account' }).count()).toBe(0);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), HANDOFF_KEY)).toBeNull();
    api.assertNoUnexpectedRequests();
});

test('a signup conflict routes to linked sign-in or recovery before security-page linking', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/signup/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/context')) return route.fulfill({ json: { success: true, data: { email: 'student@school.example', universityId: '72000000-0000-4000-8000-000000000001', termsVersion: '2026-01', noticeVersion: '2026-01', noticeText: 'Synthetic verification processing notice.', expiresAt: expiresAt() } }, headers });
        if (path.endsWith('/send-code')) return route.fulfill({ status: 201, json: { success: true, data: { challengeId: '73000000-0000-4000-8000-000000000001', expiresAt: expiresAt() } }, headers });
        if (path.endsWith('/verify-code')) return route.fulfill({ json: { success: true, data: { verified: true, expiresAt: expiresAt() } }, headers });
        // The school email already belongs to an Awoof account: signup can
        // never succeed and this proof cannot authorize linking it.
        return route.fulfill({ status: 409, json: { success: false, error: { message: 'Use existing-account sign-in or recovery.', code: 'SSO_SIGNUP_EXISTING_ACCOUNT', statusCode: 409 } }, headers });
    });
    await page.goto('/auth/student/login');
    await page.evaluate(({ key, handoffId }) => sessionStorage.setItem(key, JSON.stringify({ handoffId, handoffSecret: 'handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace' })), { key: HANDOFF_KEY, handoffId: HANDOFF_ID });
    await page.goto('/auth/student/sso/onboarding?mode=signup');
    await page.getByRole('button', { name: 'Send confirmation code' }).click();
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm email' }).click();
    await page.getByLabel('Full name').fill('Synthetic Student');
    await page.getByLabel('I am at least 18 years old').check();
    await page.getByLabel('I accept the current Terms').check();
    await page.getByLabel('I consent to the processing notice').check();
    await page.getByRole('button', { name: 'Create passwordless account' }).click();
    await expect(page.getByText('An Awoof account already uses this school email')).toBeVisible();
    await expect(page.getByText(/Sign in using a method already linked to that account/)).toBeVisible();
    await expect(page.getByText(/this email alone does not authorize it/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in to account security' })).toHaveAttribute('href', '/auth/student/login?redirect=%2Fstudent%2Fsecurity');
    await expect(page.getByRole('link', { name: 'Recover account access' })).toHaveAttribute('href', '/auth/student/recovery');
    expect(await page.getByRole('button', { name: 'Create passwordless account' }).count()).toBe(0);
    // Signup proof cannot authorize linking an existing account; the next
    // step is an already-linked login/recovery and the independent fresh-proof
    // flow from Account security.
    expect(await page.evaluate((key) => sessionStorage.getItem(key), HANDOFF_KEY)).toBeNull();
    api.assertNoUnexpectedRequests();
});

test('a generic signup conflict keeps the retry form instead of the linking journey', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/signup/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/context')) return route.fulfill({ json: { success: true, data: { email: 'student@school.example', universityId: '72000000-0000-4000-8000-000000000001', termsVersion: '2026-01', noticeVersion: '2026-01', noticeText: 'Synthetic verification processing notice.', expiresAt: expiresAt() } }, headers });
        if (path.endsWith('/send-code')) return route.fulfill({ status: 201, json: { success: true, data: { challengeId: '73000000-0000-4000-8000-000000000001', expiresAt: expiresAt() } }, headers });
        if (path.endsWith('/verify-code')) return route.fulfill({ json: { success: true, data: { verified: true, expiresAt: expiresAt() } }, headers });
        // An expired handoff or withdrawn policy shares the 409 status
        // without the existing-account code: the page must not claim an
        // account exists or direct the unusable handoff into linking.
        return route.fulfill({ status: 409, json: { success: false, error: { message: 'Passwordless student signup is not available. Restart Microsoft sign-in.', code: 'CONFLICT', statusCode: 409 } }, headers });
    });
    await page.goto('/auth/student/login');
    await page.evaluate(({ key, handoffId }) => sessionStorage.setItem(key, JSON.stringify({ handoffId, handoffSecret: 'handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace' })), { key: HANDOFF_KEY, handoffId: HANDOFF_ID });
    await page.goto('/auth/student/sso/onboarding?mode=signup');
    await page.getByRole('button', { name: 'Send confirmation code' }).click();
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm email' }).click();
    await page.getByLabel('Full name').fill('Synthetic Student');
    await page.getByLabel('I am at least 18 years old').check();
    await page.getByLabel('I accept the current Terms').check();
    await page.getByLabel('I consent to the processing notice').check();
    await page.getByRole('button', { name: 'Create passwordless account' }).click();
    await expect(page.getByText('We could not finish setup.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create passwordless account' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in to link instead' })).toHaveCount(0);
    api.assertNoUnexpectedRequests();
});

test('a session switch while passwordless completion is in flight cannot replace the newer session', async ({ page }) => {
    let release!: () => void; let started!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); const begun = new Promise<void>(resolve => { started = resolve; });
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/signup/**`, async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/context')) return route.fulfill({ headers: { 'access-control-allow-origin': appOrigin, 'access-control-allow-credentials': 'true' }, json: { success: true, data: { email: 'student@school.example', universityId: '72000000-0000-4000-8000-000000000001', termsVersion: '2026-01', noticeVersion: '2026-01', noticeText: 'Synthetic verification processing notice.', expiresAt: expiresAt() } } });
        if (path.endsWith('/send-code')) return route.fulfill({ status: 201, headers: { 'access-control-allow-origin': appOrigin, 'access-control-allow-credentials': 'true' }, json: { success: true, data: { challengeId: '73000000-0000-4000-8000-000000000001', expiresAt: expiresAt() } } });
        if (path.endsWith('/verify-code')) return route.fulfill({ headers: { 'access-control-allow-origin': appOrigin, 'access-control-allow-credentials': 'true' }, json: { success: true, data: { verified: true, expiresAt: expiresAt() } } });
        started(); await held; return route.fulfill({ status: 201, headers: { 'access-control-allow-origin': appOrigin, 'access-control-allow-credentials': 'true' }, json: { success: true, data: { user: { id: 'old', email: 'student@school.example', role: 'student' }, tokens: { accessToken: 'old-access', refreshToken: 'old-refresh' } } } });
    });
    await page.goto('/auth/student/login');
    await page.evaluate(({ key, handoffId, expiry }) => sessionStorage.setItem(key, JSON.stringify({ handoffId, handoffSecret: 'handoff-secret', expiresAt: expiry, returnPath: '/marketplace' })), { key: HANDOFF_KEY, handoffId: HANDOFF_ID, expiry: expiresAt() });
    await page.goto('/auth/student/sso/onboarding?mode=signup'); await page.getByRole('button', { name: 'Send confirmation code' }).click(); await page.getByLabel('Email confirmation code').fill('123456'); await page.getByRole('button', { name: 'Confirm email' }).click(); await page.getByLabel('Full name').fill('Synthetic Student'); await page.getByLabel('I am at least 18 years old').check(); await page.getByLabel('I accept the current Terms').check(); await page.getByLabel('I consent to the processing notice').check(); await page.getByRole('button', { name: 'Create passwordless account' }).click();
    await begun; await replaceSession(page, 'vendor'); release();
    // The 201 committed the account, so the newer session is preserved
    // and the created outcome shows instead of a retryable form; the
    // spent handoff is cleared.
    await expect(page.getByText('Setup may have finished but the confirmation was lost.')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('awoof.session.v1'))).toContain('vendor-access');
    expect(await page.evaluate(() => localStorage.getItem('awoof.session.v1'))).not.toContain('old-access');
    expect(await page.evaluate((key) => sessionStorage.getItem(key), HANDOFF_KEY)).toBeNull();
    api.assertNoUnexpectedRequests();
});

test('unavailable token storage after account creation reports the created outcome', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/signup/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/context')) return route.fulfill({ json: { success: true, data: { email: 'student@school.example', universityId: '72000000-0000-4000-8000-000000000001', termsVersion: '2026-01', noticeVersion: '2026-01', noticeText: 'Synthetic verification processing notice.', expiresAt: expiresAt() } }, headers });
        if (path.endsWith('/send-code')) return route.fulfill({ status: 201, json: { success: true, data: { challengeId: '73000000-0000-4000-8000-000000000001', expiresAt: expiresAt() } }, headers });
        if (path.endsWith('/verify-code')) return route.fulfill({ json: { success: true, data: { verified: true, expiresAt: expiresAt() } }, headers });
        return route.fulfill({ status: 201, json: { success: true, data: { user: { id: 'u1', email: 'student@school.example', role: 'student' }, tokens: { accessToken: 'new-access', refreshToken: 'new-refresh' } } }, headers });
    });
    await page.goto('/auth/student/login');
    await page.evaluate(({ key, handoffId }) => sessionStorage.setItem(key, JSON.stringify({ handoffId, handoffSecret: 'handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: '/marketplace' })), { key: HANDOFF_KEY, handoffId: HANDOFF_ID });
    await page.goto('/auth/student/sso/onboarding?mode=signup');
    await page.getByRole('button', { name: 'Send confirmation code' }).click();
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm email' }).click();
    await page.getByLabel('Full name').fill('Synthetic Student');
    await page.getByLabel('I am at least 18 years old').check();
    await page.getByLabel('I accept the current Terms').check();
    await page.getByLabel('I consent to the processing notice').check();
    // Storage breaks after the form is ready: the 201 still commits the
    // account, so the page must report creation (not non-acceptance),
    // clear the spent handoff, and offer Microsoft sign-in.
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('storage denied'); }; });
    await page.getByRole('button', { name: 'Create passwordless account' }).click();
    await expect(page.getByText('Setup may have finished but the confirmation was lost.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in with Microsoft' })).toBeVisible();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), HANDOFF_KEY)).toBeNull();
    api.assertNoUnexpectedRequests();
});
