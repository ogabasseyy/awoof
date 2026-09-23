import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { apiOrigin, appOrigin, installSyntheticApi, replaceSession, seedSession } from './fixtures';

// Credentialed SSO calls reject a wildcard CORS origin; echo the app origin instead.
const ssoHeaders = {
    'access-control-allow-origin': appOrigin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type',
};

const ATTEMPT_ID = '50000000-0000-4000-8000-000000000001';
const HANDOFF_ID = '50000000-0000-4000-8000-000000000002';
const ATTEMPT_KEY = 'awoof.sso.attempt.v1.tab';
const HANDOFF_KEY = 'awoof.sso.handoff.v1.tab';
const SESSION_KEY = 'awoof.session.v1';

function liveExpiry(): string {
    return new Date(Date.now() + 600_000).toISOString();
}

function expiredExpiry(): string {
    return new Date(Date.now() - 60_000).toISOString();
}

type SeedAttempt = {
    attemptId: string;
    finishSecret: string;
    expiresAt: string;
    generation: number;
    returnPath: string;
};

async function seedTabAttempt(page: Page, record: SeedAttempt): Promise<void> {
    await page.evaluate(({ key, value }) => {
        sessionStorage.setItem(key, JSON.stringify(value));
    }, { key: ATTEMPT_KEY, value: record });
}

async function readTabAttempt(page: Page): Promise<SeedAttempt | null> {
    return page.evaluate((key) => {
        const raw = sessionStorage.getItem(key);
        return raw ? JSON.parse(raw) as SeedAttempt : null;
    }, ATTEMPT_KEY);
}

async function readTabHandoff(page: Page): Promise<{ handoffId: string; handoffSecret: string; expiresAt: string; returnPath: string } | null> {
    return page.evaluate((key) => {
        const raw = sessionStorage.getItem(key);
        return raw ? JSON.parse(raw) as { handoffId: string; handoffSecret: string; expiresAt: string; returnPath: string } : null;
    }, HANDOFF_KEY);
}

async function readSessionEnvelope(page: Page): Promise<string | null> {
    return page.evaluate((key) => localStorage.getItem(key), SESSION_KEY);
}

async function revealPassword(page: Page, email: string): Promise<void> {
    await page.route(`${apiOrigin}/api/auth/student/login-options`, (route) => route.fulfill({
        json: { success: true, data: { password: true, providers: [], registration: true, recovery: true } },
        headers: { 'access-control-allow-origin': appOrigin },
    }));
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
}

function studentJwt(): string {
    const payload = Buffer.from(JSON.stringify({ userId: 'student-1', email: 's@school.example', role: 'student' })).toString('base64');
    return `header.${payload}.signature`;
}

function enrolledAssurance() {
    return {
        schoolAccountStatus: 'verified',
        schoolAccountMethod: 'google_workspace',
        schoolAccountValidUntil: null,
        studentStatus: 'verified',
        enrollmentMethod: 'registration',
        studentValidUntil: null,
        reason: null,
    };
}

function pendingAssurance() {
    return {
        schoolAccountStatus: 'verified',
        schoolAccountMethod: 'email_otp',
        schoolAccountValidUntil: null,
        studentStatus: 'pending',
        enrollmentMethod: null,
        studentValidUntil: null,
        reason: 'awaiting_enrollment',
    };
}

async function startProviderStub(): Promise<{ baseUrl: string; hits: string[]; close: () => Promise<void> }> {
    const hits: string[] = [];
    const server: Server = createServer((req, res) => {
        hits.push(req.url ?? '');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>Synthetic school provider</body></html>');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Provider stub did not expose a loopback port');
    const port = (address as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        hits,
        close: async () => { server.close(); await once(server, 'close'); },
    };
}

test('the student login starts with only email, then offers the discovered school method', async ({ page }) => {
    let discoveryCalls = 0;
    await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/login-options`, (route) => {
        discoveryCalls += 1;
        return route.fulfill({
            json: { success: true, data: { password: true, providers: ['microsoft'], registration: true, recovery: true } },
            headers: { 'access-control-allow-origin': '*' },
        });
    });

    await page.goto('/auth/student/login');
    const email = page.getByLabel('Email', { exact: true });
    const password = page.getByLabel('Password', { exact: true });
    await expect(email).toBeVisible();
    await expect(password).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
    await expect(email).toHaveAttribute('autocomplete', 'username');

    // Typing alone never triggers discovery or navigation.
    await email.fill('student@school.example');
    await page.waitForTimeout(300);
    expect(discoveryCalls).toBe(0);
    await expect(page).toHaveURL(/\/auth\/student\/login/);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Continue with Microsoft' })).toBeVisible();
    await expect(password).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Use password instead' })).toBeVisible();
    await page.getByRole('button', { name: 'Use password instead' }).click();
    await expect(password).toBeVisible();
    await expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(discoveryCalls).toBe(1);
});

test('school sign-in options appear only after an explicit continue', async ({ page }) => {
    const bodies: unknown[] = [];
    await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/login-options`, async (route) => {
        bodies.push(JSON.parse(route.request().postData() ?? '{}'));
        await route.fulfill({
            json: { success: true, data: { password: true, providers: ['microsoft', 'google'], registration: true, recovery: true } },
            headers: { 'access-control-allow-origin': '*' },
        });
    });

    await page.goto('/auth/student/login');
    await expect(page.getByRole('button', { name: 'Continue with Microsoft' })).toHaveCount(0);
    await page.getByLabel('Email', { exact: true }).fill('student@school.example');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Continue with Microsoft' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({ email: 'student@school.example' });
    await expect(page).toHaveURL(/\/auth\/student\/login/);
});

test('unknown domains fall back to password with honest copy', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/login-options`, (route) => route.fulfill({
        json: { success: true, data: { password: true, providers: [], registration: true, recovery: true } },
        headers: { 'access-control-allow-origin': '*' },
    }));

    await page.goto('/auth/student/login');
    await page.getByLabel('Email', { exact: true }).fill('student@gmail.com');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Microsoft' })).toHaveCount(0);

    // The password path still signs in.
    await page.getByLabel('Password', { exact: true }).fill('Synthetic-Password1!');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.waitForURL('**/marketplace**');
    expect(api.loginCalls).toBe(1);
    api.assertNoUnexpectedRequests();
});

test('starting SSO stores only the tab attempt and redirects to the school provider', async ({ page }) => {
    const stub = await startProviderStub();
    try {
        const startBodies: unknown[] = [];
        await installSyntheticApi(page);
        await page.route(`${stub.baseUrl}/**`, (route) => route.continue());
        await page.route(`${apiOrigin}/api/auth/student/login-options`, (route) => route.fulfill({
            json: { success: true, data: { password: true, providers: ['microsoft'], registration: true, recovery: true } },
            headers: { 'access-control-allow-origin': '*' },
        }));
        await page.route(`${apiOrigin}/api/auth/student/sso/microsoft/start`, async (route) => {
            startBodies.push(JSON.parse(route.request().postData() ?? '{}'));
            await route.fulfill({
                status: 201,
                json: {
                    success: true,
                    data: {
                        attemptId: ATTEMPT_ID,
                        authorizationUrl: `${stub.baseUrl}/provider/auth?state=x`,
                        finishSecret: 'synthetic-finish-secret',
                        expiresAt: liveExpiry(),
                        serverNow: new Date().toISOString(),
                    },
                },
                headers: ssoHeaders,
            });
        });

        await page.goto('/auth/student/login?redirect=%2Fmarketplace%3Ffrom%3Dsso-test');
        await page.getByLabel('Email', { exact: true }).fill('student@school.example');
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByRole('button', { name: 'Continue with Microsoft' }).click();
        await page.waitForURL(`${stub.baseUrl}/**`);
        expect(stub.hits.length).toBeGreaterThan(0);
        expect(startBodies).toEqual([{ email: 'student@school.example', rememberMe: false, returnPath: '/marketplace?from=sso-test' }]);

        await page.goBack();
        await page.waitForURL('**/auth/student/login**');
        const record = await readTabAttempt(page);
        expect(record?.attemptId).toBe(ATTEMPT_ID);
        expect(record?.finishSecret).toBe('synthetic-finish-secret');
        expect(record?.returnPath).toBe('/marketplace?from=sso-test');
        const serialized = JSON.stringify(record);
        expect(serialized).not.toMatch(/accessToken|refreshToken|idToken|Bearer/i);
    } finally {
        await stub.close();
    }
});

test('an enrolled student completes SSO at the requested page', async ({ page }) => {
    const finishBodies: unknown[] = [];
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/finish`, async (route) => {
        finishBodies.push(JSON.parse(route.request().postData() ?? '{}'));
        await route.fulfill({
            json: {
                success: true,
                data: {
                    outcome: 'authenticated',
                    user: { id: 'student-1', email: 'student@school.example', role: 'student' },
                    tokens: { accessToken: 'student-access', refreshToken: 'student-refresh' },
                    studentAssurance: enrolledAssurance(),
                    assuranceStatus: 'available',
                },
            },
            headers: ssoHeaders,
        });
    });

    await page.goto('/auth/student/login');
    await seedTabAttempt(page, {
        attemptId: ATTEMPT_ID,
        finishSecret: 'synthetic-finish-secret',
        expiresAt: liveExpiry(),
        generation: 0,
        returnPath: '/marketplace?from=sso-test',
    });
    await page.goto(`/auth/student/sso/complete?attempt=${ATTEMPT_ID}`);
    await page.waitForURL('**/marketplace?from=sso-test');
    expect(finishBodies).toEqual([{ attemptId: ATTEMPT_ID, finishSecret: 'synthetic-finish-secret' }]);
    expect(await readTabAttempt(page)).toBeNull();
    expect(await readSessionEnvelope(page)).toContain('"state":"active"');
    api.assertNoUnexpectedRequests();
});

test('a pending student continues to enrollment verification with independent labels', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/finish`, (route) => route.fulfill({
        json: {
            success: true,
            data: {
                outcome: 'authenticated',
                user: { id: 'student-1', email: 'student@school.example', role: 'student' },
                tokens: { accessToken: 'student-access', refreshToken: 'student-refresh' },
                studentAssurance: pendingAssurance(),
                assuranceStatus: 'available',
            },
        },
        headers: ssoHeaders,
    }));
    await page.route(`${apiOrigin}/api/verification/status`, (route) => route.fulfill({
        json: {
            success: true,
            data: {
                emailDomainApproved: true,
                mailboxConfirmed: true,
                email: 'student@school.example',
                universityId: '10000000-0000-4000-8000-000000000001',
                eligibility: { eligible: false },
                studentAssurance: pendingAssurance(),
                notices: { verification: { version: '2026-09-05.v1', text: 'Synthetic notice.' } },
            },
        },
        headers: { 'access-control-allow-origin': '*' },
    }));
    await page.route(`${apiOrigin}/api/verification/methods/*`, (route) => route.fulfill({
        json: { success: true, data: { methods: [] } },
        headers: { 'access-control-allow-origin': '*' },
    }));
    await page.route(`${apiOrigin}/api/verification/consents`, (route) => route.fulfill({
        json: { success: true, data: { items: [], nextCursor: null } },
        headers: { 'access-control-allow-origin': '*' },
    }));
    await page.route(`${apiOrigin}/api/verification/microsoft/notice`, (route) => route.fulfill({
        json: { success: true, data: { version: '2026-09-05.v1', text: 'Synthetic notice.', snapshot: 'snapshot' } },
        headers: { 'access-control-allow-origin': '*' },
    }));
    await page.route(`${apiOrigin}/api/verification/microsoft/consents`, (route) => route.fulfill({
        json: { success: true, data: { items: [], nextCursor: null } },
        headers: { 'access-control-allow-origin': '*' },
    }));
    await page.route(`${apiOrigin}/api/verification/microsoft/identities`, (route) => route.fulfill({
        json: { success: true, data: { items: [], nextCursor: null } },
        headers: { 'access-control-allow-origin': '*' },
    }));

    await page.goto('/auth/student/login');
    await seedTabAttempt(page, {
        attemptId: ATTEMPT_ID,
        finishSecret: 'synthetic-finish-secret',
        expiresAt: liveExpiry(),
        generation: 0,
        returnPath: '/marketplace',
    });
    await page.goto(`/auth/student/sso/complete?attempt=${ATTEMPT_ID}`);
    await page.waitForURL('**/student/verification');
    await expect(page.getByText('School account:', { exact: true })).toBeVisible();
    await expect(page.getByText('Student status:', { exact: true })).toBeVisible();
    await expect(page.getByText(/The school connection is not yet available for your school/)).toBeVisible();
    await expect(page.getByText(/cannot unlock discounts/)).toBeVisible();
    api.assertNoUnexpectedRequests();
});

test('an unlinked provider identity stays signed out with an explicit link-required state', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/finish`, (route) => route.fulfill({
        json: {
            success: true,
            data: {
                outcome: 'link_required',
                handoffId: HANDOFF_ID,
                handoffSecret: 'synthetic-handoff-secret',
                expiresAt: liveExpiry(),
            },
        },
        headers: ssoHeaders,
    }));

    await page.goto('/auth/student/login');
    await seedTabAttempt(page, {
        attemptId: ATTEMPT_ID,
        finishSecret: 'synthetic-finish-secret',
        expiresAt: liveExpiry(),
        generation: 0,
        returnPath: '/marketplace',
    });
    await page.goto(`/auth/student/sso/complete?attempt=${ATTEMPT_ID}`);
    await expect(page.getByRole('heading', { name: 'Link your school account' })).toBeVisible();
    await expect(page.getByText('You are still signed out.')).toBeVisible();
    // The password link carries the user back to the stored handoff so the
    // link step resumes after sign-in instead of orphaning the handoff.
    await expect(page.getByRole('link', { name: 'Sign in with your password' })).toHaveAttribute('href', '/auth/student/login?redirect=%2Fauth%2Fstudent%2Fsso%2Fonboarding');
    await expect(page.getByRole('link', { name: 'Create an account' })).toHaveAttribute('href', '/auth/student/register?redirect=%2Fauth%2Fstudent%2Fsso%2Fonboarding');
    expect(await readSessionEnvelope(page)).toBeNull();
    expect(await readTabAttempt(page)).toBeNull();
    const handoff = await readTabHandoff(page);
    expect(handoff?.handoffId).toBe(HANDOFF_ID);
    // The cleared attempt's return path travels with the handoff so the
    // onboarding page can continue to the initiating destination.
    expect(handoff?.returnPath).toBe('/marketplace');
    expect(page.url()).not.toContain('synthetic-handoff-secret');
    api.assertNoUnexpectedRequests();
});

test('a denied provider returns to login with a safe error only', async ({ page }) => {
    await installSyntheticApi(page);
    await page.goto('/auth/student/login');
    await seedTabAttempt(page, {
        attemptId: ATTEMPT_ID,
        finishSecret: 'synthetic-finish-secret',
        expiresAt: liveExpiry(),
        generation: 0,
        returnPath: '/marketplace',
    });
    await page.goto(`/auth/student/sso/complete?attempt=${ATTEMPT_ID}&outcome=connection_not_completed`);
    await page.waitForURL('**/auth/student/login?error=sso_not_completed**');
    expect(page.url()).not.toContain(ATTEMPT_ID);
    expect(page.url()).not.toContain('synthetic-finish-secret');
    const notice = page.locator('#student-login-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('did not complete');
    await expect(notice).toBeFocused();
    expect(await readTabAttempt(page)).toBeNull();
});

test('unknown login error codes are ignored rather than echoed', async ({ page }) => {
    await installSyntheticApi(page);
    await page.goto('/auth/student/login?error=%3Cscript%3Eevil%3C%2Fscript%3E');
    await expect(page.locator('#student-login-notice')).toHaveCount(0);
    await expect(page.getByText('evil')).toHaveCount(0);
});

test('an expired attempt recovers through a password sign-in', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.goto('/auth/student/login');
    await seedTabAttempt(page, {
        attemptId: ATTEMPT_ID,
        finishSecret: 'synthetic-finish-secret',
        expiresAt: expiredExpiry(),
        generation: 0,
        returnPath: '/marketplace?from=sso-test',
    });
    await page.goto(`/auth/student/sso/complete?attempt=${ATTEMPT_ID}`);
    await page.waitForURL('**/auth/student/login?error=sso_expired**');
    await expect(page.locator('#student-login-notice')).toContainText('expired');

    await revealPassword(page, 'student@approved.test');
    await page.getByLabel('Password', { exact: true }).fill('Synthetic-Password1!');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.waitForURL('**/marketplace?from=sso-test');
    expect(api.loginCalls).toBe(1);
    api.assertNoUnexpectedRequests();
});

test('a late finish never replaces another account signed in on the tab', async ({ page }) => {
    let finishCalls = 0;
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/sso/finish`, (route) => {
        finishCalls += 1;
        return route.fulfill({
            json: {
                success: true,
                data: {
                    outcome: 'authenticated',
                    user: { id: 'student-1', email: 'student@school.example', role: 'student' },
                    tokens: { accessToken: 'student-access', refreshToken: 'student-refresh' },
                    studentAssurance: enrolledAssurance(),
                    assuranceStatus: 'available',
                },
            },
            headers: ssoHeaders,
        });
    });

    await page.goto('/auth/student/login');
    await seedTabAttempt(page, {
        attemptId: ATTEMPT_ID,
        finishSecret: 'synthetic-finish-secret',
        expiresAt: liveExpiry(),
        generation: 0,
        returnPath: '/marketplace',
    });
    const vendorSession = await replaceSession(page, 'vendor');
    await page.goto(`/auth/student/sso/complete?attempt=${ATTEMPT_ID}`);
    await expect(page.getByRole('heading', { name: 'Sign-in discarded' })).toBeVisible();
    await expect(page.getByText('nothing was replaced')).toBeVisible();
    expect(finishCalls).toBe(0);
    expect(await vendorSession.matches(page)).toBe(true);
    api.assertNoUnexpectedRequests();
});

test('an expired student session recovers through the current password login', async ({ page }) => {
    const api = await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/refresh`, (route) => route.fulfill({
        json: { success: true, data: { accessToken: studentJwt() } },
        headers: { 'access-control-allow-origin': '*' },
    }));
    await seedSession(page, 'student', { accessToken: studentJwt() });

    await page.goto('/marketplace');
    await page.waitForURL('**/auth/student/login?error=session_expired**');
    await expect(page.locator('#student-login-notice')).toContainText('Sign in again with your password');

    await revealPassword(page, 'student@approved.test');
    await page.getByLabel('Password', { exact: true }).fill('Synthetic-Password1!');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.waitForURL('**/marketplace');
    expect(await readSessionEnvelope(page)).toContain('"state":"active"');
    api.assertNoUnexpectedRequests();
});

test('discovery errors keep the typed email and stay usable at mobile width with keyboard input', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    let discoveryCalls = 0;
    await installSyntheticApi(page);
    await page.route(`${apiOrigin}/api/auth/student/login-options`, (route) => {
        discoveryCalls += 1;
        if (discoveryCalls === 1) {
            return route.fulfill({
                status: 503,
                json: { success: false, error: { message: 'Synthetic discovery outage' } },
                headers: { 'access-control-allow-origin': '*' },
            });
        }
        return route.fulfill({
            json: { success: true, data: { password: true, providers: ['google'], registration: true, recovery: true } },
            headers: { 'access-control-allow-origin': '*' },
        });
    });

    await page.goto('/auth/student/login');
    const email = page.getByLabel('Email', { exact: true });
    await email.fill('student@school.example');
    const find = page.getByRole('button', { name: 'Continue', exact: true });
    await find.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('temporarily unavailable')).toBeVisible();
    await expect(email).toHaveValue('student@school.example');

    await page.getByRole('button', { name: 'Try again' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    expect(discoveryCalls).toBe(2);
});
