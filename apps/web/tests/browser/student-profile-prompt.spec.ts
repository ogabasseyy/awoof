import { expect, test, type Page, type Route } from '@playwright/test';
import { apiOrigin, appOrigin, installSyntheticApi, seedSession } from './fixtures';

const COMPLETE_PATH = '/student/profile/complete';
const STUDENT_ID = '00000000-0000-4000-8000-000000000001';
const CORS = { 'access-control-allow-origin': '*' };
const SESSION_KEY = 'awoof.session.v1';
const DEFER_PREFIX = 'awoof.profile.defer-prompt.v1.';
const ATTEMPT_KEY = 'awoof.sso.attempt.v1.tab';
const ATTEMPT_ID = '60000000-0000-4000-8000-000000000001';
const HANDOFF_KEY = 'awoof.sso.handoff.v1.tab';
const HANDOFF_ID = '60000000-0000-4000-8000-000000000002';

const ssoHeaders = {
    'access-control-allow-origin': appOrigin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type',
};

function baseFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        claimedInstitution: { state: 'unanswered' },
        programme: { state: 'unanswered' },
        entryYear: { state: 'unanswered' },
        entryRoute: { state: 'unanswered' },
        expectedGraduationYear: { state: 'unanswered' },
        graduationYearOrigin: null,
        estimateBasis: null,
        estimateStale: false,
        ...overrides,
    };
}

function pendingAssurance(): Record<string, unknown> {
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

function verifiedAssurance(): Record<string, unknown> {
    return { ...pendingAssurance(), studentStatus: 'verified', enrollmentMethod: 'registration', reason: null };
}

function projection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        revision: 3,
        fields: baseFields(),
        institution: { displayName: null, countryCode: null, binding: 'unbound' },
        institutionConfirmedGraduationYear: null,
        entryYearSuggestion: null,
        optionalUnansweredFields: ['claimedInstitution', 'programme', 'entryYear', 'entryRoute', 'expectedGraduationYear'],
        attentionFields: ['programme'],
        verificationRequirements: [],
        verificationContinuationAvailable: false,
        assuranceState: 'available',
        assurance: pendingAssurance(),
        referenceVersion: 'nuc-v2',
        estimate: null,
        featureEnabled: true,
        promptDecision: 'complete_profile',
        ...overrides,
    };
}

function applyPatch(current: unknown, patch: Record<string, unknown>): unknown {
    const next = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
    next.revision = (next.revision as number) + 1;
    const fields = next.fields as Record<string, unknown>;
    for (const key of ['claimedInstitution', 'programme', 'entryYear', 'entryRoute', 'expectedGraduationYear']) {
        const update = patch[key] as { state: string; value?: unknown } | undefined;
        if (!update) continue;
        if (key === 'expectedGraduationYear' && update.state === 'supplied') {
            const choice = update.value as { kind: string; year: number };
            fields[key] = { state: 'supplied', value: choice.year };
            fields.graduationYearOrigin = choice.kind === 'accept_estimate' ? 'calculated' : 'self_reported';
            continue;
        }
        fields[key] = update.state === 'supplied' ? { state: 'supplied', value: update.value } : { state: update.state };
    }
    return next;
}

type PromptFixture = {
    getCalls: number;
    puts: unknown[];
    putBehavior: 'echo' | 'error';
    getResponder: () => { status: number; body: unknown };
};

async function installPromptApi(page: Page, responder: PromptFixture['getResponder']): Promise<PromptFixture> {
    const fixture: PromptFixture = { getCalls: 0, puts: [], putBehavior: 'echo', getResponder: responder };
    await page.route(`${apiOrigin}/api/students/academic-profile`, async (route: Route) => {
        if (route.request().method() === 'GET') {
            fixture.getCalls += 1;
            const { status, body } = fixture.getResponder();
            await route.fulfill({ status, json: body, headers: CORS });
            return;
        }
        if (route.request().method() === 'PUT') {
            const body = route.request().postDataJSON() as Record<string, unknown>;
            fixture.puts.push(body);
            if (fixture.putBehavior === 'error') {
                await route.fulfill({ status: 500, json: { success: false, error: { message: 'Synthetic save failure' } }, headers: CORS });
                return;
            }
            await route.fulfill({ json: { success: true, data: applyPatch(projection(), body) }, headers: CORS });
            return;
        }
        await route.abort('failed');
    });
    return fixture;
}

function okProjection(initial: unknown): () => { status: number; body: unknown } {
    return () => ({ status: 200, body: { success: true, data: initial } });
}

async function deferEntries(page: Page): Promise<Record<string, string>> {
    return page.evaluate((prefix) => {
        const entries: Record<string, string> = {};
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key && key.startsWith(prefix)) entries[key] = localStorage.getItem(key) ?? '';
        }
        return entries;
    }, DEFER_PREFIX);
}

async function activeSessionId(page: Page): Promise<string | null> {
    return page.evaluate((key) => {
        try {
            const envelope = JSON.parse(localStorage.getItem(key) ?? 'null') as { state?: unknown; sessionId?: unknown } | null;
            return envelope?.state === 'active' && typeof envelope.sessionId === 'string' ? envelope.sessionId : null;
        } catch {
            return null;
        }
    }, SESSION_KEY);
}

async function mockPasswordLogin(page: Page): Promise<void> {
    await page.route(`${apiOrigin}/api/auth/student/login-options`, (route) => route.fulfill({
        json: { success: true, data: { password: true, providers: [], registration: true, recovery: true } },
        headers: { 'access-control-allow-origin': appOrigin },
    }));
}

async function submitPasswordLogin(page: Page, redirect: string | null): Promise<void> {
    const target = redirect === null ? '/auth/student/login' : `/auth/student/login?redirect=${redirect}`;
    await page.goto(target);
    await page.getByLabel('Email', { exact: true }).fill('student@approved.test');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill('Synthetic-Password1!');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
}

async function mockQuietVerification(page: Page, studentStatus: string): Promise<void> {
    await page.route(`${apiOrigin}/api/verification/**`, async (route: Route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/status')) {
            await route.fulfill({
                json: {
                    data: {
                        mailboxConfirmed: false,
                        emailDomainApproved: true,
                        email: 'student@approved.test',
                        universityId: null,
                        eligibility: { eligible: false },
                        studentAssurance: { ...pendingAssurance(), studentStatus },
                        notices: { verification: { version: 'fixture', text: 'I agree to verification.' } },
                    },
                },
                headers: CORS,
            });
            return;
        }
        await route.fulfill({ json: { data: { items: [], nextCursor: null } }, headers: CORS });
    });
}

async function seedSsoAttempt(page: Page, returnPath: string): Promise<void> {
    await page.evaluate(({ key, value }) => {
        sessionStorage.setItem(key, JSON.stringify(value));
    }, {
        key: ATTEMPT_KEY,
        value: {
            attemptId: ATTEMPT_ID,
            finishSecret: 'synthetic-finish-secret',
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            generation: 0,
            returnPath,
        },
    });
}

async function mockSsoFinish(page: Page, assurance: Record<string, unknown> | null, status: 'available' | 'unavailable'): Promise<void> {
    await page.route(`${apiOrigin}/api/auth/student/sso/finish`, (route) => route.fulfill({
        json: {
            success: true,
            data: {
                outcome: 'authenticated',
                user: { id: STUDENT_ID, email: 'student@approved.test', role: 'student' },
                tokens: { accessToken: 'student-access', refreshToken: 'student-refresh' },
                studentAssurance: assurance,
                assuranceStatus: status,
            },
        },
        headers: ssoHeaders,
    }));
}

async function mockCurrentUser(page: Page): Promise<void> {
    await page.route(`${apiOrigin}/api/auth/me`, (route) => route.fulfill({
        json: { success: true, data: { id: STUDENT_ID, email: 'student@school.example', role: 'student' } },
        headers: CORS,
    }));
}

async function driveSignupToRecoveryNotice(page: Page, returnPath: string): Promise<void> {
    await page.route(`${apiOrigin}/api/auth/student/sso/signup/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        const expiresAt = new Date(Date.now() + 600_000).toISOString();
        if (path.endsWith('/context')) return route.fulfill({ json: { success: true, data: { email: 'student@school.example', universityId: '72000000-0000-4000-8000-000000000001', termsVersion: '2026-01', noticeVersion: '2026-01', noticeText: 'Synthetic verification processing notice.', expiresAt } }, headers: ssoHeaders });
        if (path.endsWith('/send-code')) return route.fulfill({ status: 201, json: { success: true, data: { challengeId: '73000000-0000-4000-8000-000000000001', expiresAt } }, headers: ssoHeaders });
        if (path.endsWith('/verify-code')) return route.fulfill({ json: { success: true, data: { verified: true, expiresAt } }, headers: ssoHeaders });
        return route.fulfill({ status: 201, json: { success: true, data: { user: { id: STUDENT_ID, email: 'student@school.example', role: 'student' }, tokens: { accessToken: 'signup-access', refreshToken: 'signup-refresh' } } }, headers: ssoHeaders });
    });
    await page.goto('/auth/student/login');
    await page.evaluate(({ key, handoffId, handoffReturnPath }) => sessionStorage.setItem(key, JSON.stringify({ handoffId, handoffSecret: 'handoff-secret', expiresAt: new Date(Date.now() + 600_000).toISOString(), returnPath: handoffReturnPath })), { key: HANDOFF_KEY, handoffId: HANDOFF_ID, handoffReturnPath: returnPath });
    await page.goto('/auth/student/sso/onboarding?mode=signup');
    await page.getByRole('button', { name: 'Send confirmation code' }).click();
    await page.getByLabel('Email confirmation code').fill('123456');
    await page.getByRole('button', { name: 'Confirm email' }).click();
    await page.getByLabel('Full name').fill('Synthetic Student');
    await page.getByLabel('I am at least 18 years old').check();
    await page.getByLabel('I accept the current Terms').check();
    await page.getByLabel('I consent to the processing notice').check();
    await page.getByRole('button', { name: 'Create passwordless account' }).click();
    await expect(page.getByRole('heading', { name: 'Account created' })).toBeVisible();
}

test('password login routes eligible pending browse to the completion screen', async ({ page }) => {
    await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection()));
    await mockPasswordLogin(page);
    await submitPasswordLogin(page, null);
    await page.waitForURL('**/student/profile/complete?redirect=%2Fmarketplace');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hi there');
    await expect(page.getByText('Complete your student profile').first()).toBeVisible();
    expect(prompt.getCalls).toBeGreaterThanOrEqual(1);
});

test('password login with an explicit profile continuation skips the projection read', async ({ page }) => {
    await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection()));
    await mockPasswordLogin(page);
    await submitPasswordLogin(page, '%2Fstudent%2Fprofile');
    await page.waitForURL('**/student/profile');
    expect(prompt.getCalls).toBe(0);
    await expect(page.getByRole('link', { name: 'Complete your student profile' })).toBeVisible();
});

test('password login bypasses completion for verified enrollment', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection({
        assurance: verifiedAssurance(),
        attentionFields: [],
        optionalUnansweredFields: [],
        promptDecision: 'continue',
    })));
    await mockPasswordLogin(page);
    await submitPasswordLogin(page, null);
    await page.waitForURL('**/marketplace');
    expect(prompt.getCalls).toBeGreaterThanOrEqual(1);
    api.assertNoUnexpectedRequests();
});

test('password login never prompts expired enrollment into completion', async ({ page }) => {
    await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection({
        assurance: { ...pendingAssurance(), studentStatus: 'expired', reason: 'evidence_expired' },
        promptDecision: 'continue',
    })));
    await mockPasswordLogin(page);
    await submitPasswordLogin(page, null);
    await page.waitForURL('**/marketplace');
    expect(prompt.getCalls).toBeGreaterThanOrEqual(1);
});

test('an available verification continuation takes priority over completion', async ({ page }) => {
    await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection({
        verificationRequirements: ['registration_number'],
        verificationContinuationAvailable: true,
        promptDecision: 'continue',
    })));
    await mockPasswordLogin(page);
    await submitPasswordLogin(page, null);
    await page.waitForURL('**/marketplace');
    expect(prompt.getCalls).toBeGreaterThanOrEqual(1);
});

test('a disabled feature continues to browse without prompting', async ({ page }) => {
    await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection({
        featureEnabled: false,
        promptDecision: 'continue',
    })));
    await mockPasswordLogin(page);
    await submitPasswordLogin(page, null);
    await page.waitForURL('**/marketplace');
    expect(prompt.getCalls).toBeGreaterThanOrEqual(1);
});

test('unavailable assurance fails open to browse without assuming pending', async ({ page }) => {
    await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection({
        assuranceState: 'unavailable',
        assurance: null,
        promptDecision: 'continue',
    })));
    await mockPasswordLogin(page);
    await submitPasswordLogin(page, null);
    await page.waitForURL('**/marketplace');
    expect(prompt.getCalls).toBeGreaterThanOrEqual(1);
});

test('a projection read failure fails open and keeps the profile call to action', async ({ page }) => {
    await installSyntheticApi(page);
    const prompt = await installPromptApi(page, () => ({
        status: 500,
        body: { success: false, error: { message: 'Synthetic projection failure' } },
    }));
    await mockPasswordLogin(page);
    await submitPasswordLogin(page, null);
    await page.waitForURL('**/marketplace');
    expect(prompt.getCalls).toBe(1);
    await page.goto('/student/profile');
    await expect(page.getByRole('link', { name: 'Complete your student profile' })).toBeVisible();
});

test('merchant, verification, security, and consent continuations bypass completion', async ({ page }) => {
    await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection()));
    await mockPasswordLogin(page);
    const destinations: Array<{ redirect: string; url: string }> = [
        { redirect: '%2Fmarketplace%2Fsynthetic-offer', url: '**/marketplace/synthetic-offer' },
        { redirect: '%2Fstudent%2Fverification', url: '**/student/verification' },
        { redirect: '%2Fstudent%2Fsecurity', url: '**/student/security' },
        { redirect: '%2Fstudent%2Fprofile', url: '**/student/profile' },
    ];
    for (const destination of destinations) {
        await submitPasswordLogin(page, destination.redirect);
        await page.waitForURL(destination.url);
    }
    expect(prompt.getCalls).toBe(0);
});

test('the onboarding link continuation is preserved without a projection read', async ({ page }) => {
    await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection()));
    await mockPasswordLogin(page);
    await submitPasswordLogin(page, '%2Fauth%2Fstudent%2Fsso%2Fonboarding');
    await page.waitForURL('**/auth/student/sso/onboarding');
    expect(prompt.getCalls).toBe(0);
});

test('explicit unknown and skipped answers do not re-prompt', async ({ page }) => {
    await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection({
        fields: baseFields({
            claimedInstitution: { state: 'unknown' },
            programme: { state: 'skipped' },
            entryYear: { state: 'unknown' },
            entryRoute: { state: 'skipped' },
            expectedGraduationYear: { state: 'unknown' },
        }),
        optionalUnansweredFields: [],
        attentionFields: [],
        promptDecision: 'continue',
    })));
    await mockPasswordLogin(page);
    await submitPasswordLogin(page, null);
    await page.waitForURL('**/marketplace');
    expect(prompt.getCalls).toBeGreaterThanOrEqual(1);
});

test('SSO re-login bypasses completion for verified enrollment', async ({ page }) => {
    const api = await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection({
        assurance: verifiedAssurance(),
        attentionFields: [],
        optionalUnansweredFields: [],
        promptDecision: 'continue',
    })));
    await mockSsoFinish(page, verifiedAssurance(), 'available');
    await page.goto('/auth/student/login');
    await seedSsoAttempt(page, '/marketplace');
    await page.goto(`/auth/student/sso/complete?attempt=${ATTEMPT_ID}`);
    await page.waitForURL('**/marketplace');
    expect(prompt.getCalls).toBeGreaterThanOrEqual(1);
    api.assertNoUnexpectedRequests();
});

test('SSO re-login keeps an explicit continuation without a projection read', async ({ page }) => {
    await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection()));
    await mockSsoFinish(page, verifiedAssurance(), 'available');
    await page.goto('/auth/student/login');
    await seedSsoAttempt(page, '/student/profile');
    await page.goto(`/auth/student/sso/complete?attempt=${ATTEMPT_ID}`);
    await page.waitForURL('**/student/profile');
    expect(prompt.getCalls).toBe(0);
});

test('SSO re-login sends pending enrollment to verification, not completion', async ({ page }) => {
    await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection()));
    await mockQuietVerification(page, 'pending');
    await mockSsoFinish(page, pendingAssurance(), 'available');
    await page.goto('/auth/student/login');
    await seedSsoAttempt(page, '/marketplace');
    await page.goto(`/auth/student/sso/complete?attempt=${ATTEMPT_ID}`);
    await page.waitForURL('**/student/verification');
    expect(prompt.getCalls).toBe(0);
});

test('SSO signup continues from the recovery warning to completion when eligible', async ({ page }) => {
    await installSyntheticApi(page);
    await mockCurrentUser(page);
    const prompt = await installPromptApi(page, okProjection(projection()));
    await driveSignupToRecoveryNotice(page, '/marketplace');
    expect(prompt.getCalls).toBe(0);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/student/profile/complete?redirect=%2Fmarketplace');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hi there');
    expect(prompt.getCalls).toBeGreaterThanOrEqual(1);
});

test('SSO signup continues from the recovery warning to an explicit destination', async ({ page }) => {
    await installSyntheticApi(page);
    await mockCurrentUser(page);
    const prompt = await installPromptApi(page, okProjection(projection()));
    await driveSignupToRecoveryNotice(page, '/student/profile');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('**/student/profile');
    expect(prompt.getCalls).toBe(0);
});

test('a verified status on fresh load keeps the voluntary experience after routing', async ({ page }) => {
    await installSyntheticApi(page);
    let calls = 0;
    const prompt = await installPromptApi(page, () => {
        calls += 1;
        if (calls === 1) return { status: 200, body: { success: true, data: projection() } };
        return {
            status: 200,
            body: {
                success: true,
                data: projection({
                    assurance: verifiedAssurance(),
                    attentionFields: [],
                    optionalUnansweredFields: [],
                    promptDecision: 'continue',
                }),
            },
        };
    });
    await mockPasswordLogin(page);
    await submitPasswordLogin(page, null);
    await page.waitForURL('**/student/profile/complete**');
    await expect(page.getByText('Add optional academic details')).toBeVisible();
    expect(prompt.getCalls).toBeGreaterThanOrEqual(2);
});

test('an expired status on fresh load returns to the verification journey', async ({ page }) => {
    await installSyntheticApi(page);
    await mockQuietVerification(page, 'expired');
    let calls = 0;
    const prompt = await installPromptApi(page, () => {
        calls += 1;
        if (calls === 1) return { status: 200, body: { success: true, data: projection() } };
        return {
            status: 200,
            body: {
                success: true,
                data: projection({
                    assurance: { ...pendingAssurance(), studentStatus: 'expired', reason: 'evidence_expired' },
                    promptDecision: 'continue',
                }),
            },
        };
    });
    await mockPasswordLogin(page);
    await submitPasswordLogin(page, null);
    await page.waitForURL('**/student/profile/complete**');
    await expect(page.getByText('Your verification needs attention before you continue.')).toBeVisible();
    await page.getByRole('link', { name: 'Continue verification' }).click();
    await page.waitForURL('**/student/verification');
    expect(prompt.getCalls).toBeGreaterThanOrEqual(2);
});

test('completing later records a session-namespaced marker and returns exactly', async ({ page }) => {
    await installSyntheticApi(page);
    await installPromptApi(page, okProjection(projection()));
    await seedSession(page, 'student');
    await page.goto(`${COMPLETE_PATH}?redirect=%2Fstudent%2Fprofile`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hi there');
    expect(await deferEntries(page)).toEqual({});
    await page.getByRole('button', { name: 'Complete later' }).click();
    await page.waitForURL('**/student/profile');
    const sessionId = await activeSessionId(page);
    expect(sessionId).toBe('synthetic-student-session');
    expect(await deferEntries(page)).toEqual({ [`${DEFER_PREFIX}${sessionId}`]: STUDENT_ID });
});

test('a dirty form offers save, discard, and stay without silent loss', async ({ page }) => {
    await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection()));
    await seedSession(page, 'student');
    await page.goto(COMPLETE_PATH);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hi there');
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2022');
    await page.getByRole('button', { name: 'Complete later' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Stay on this page' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Entry year' })).toHaveValue('2022');
    expect(await deferEntries(page)).toEqual({});
    expect(prompt.puts).toHaveLength(0);
    await page.getByRole('button', { name: 'Complete later' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard and continue' }).click();
    await page.waitForURL('**/marketplace');
    const sessionId = await activeSessionId(page);
    expect(await deferEntries(page)).toEqual({ [`${DEFER_PREFIX}${sessionId}`]: STUDENT_ID });
    expect(prompt.puts).toHaveLength(0);
});

test('saving from the leave confirmation defers only after the save commits', async ({ page }) => {
    await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection()));
    await seedSession(page, 'student');
    await page.goto(`${COMPLETE_PATH}?redirect=%2Fstudent%2Fprofile`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hi there');
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2022');
    await page.getByRole('button', { name: 'Complete later' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Save and continue' }).click();
    await page.waitForURL('**/student/profile');
    expect(prompt.puts).toHaveLength(1);
    const sessionId = await activeSessionId(page);
    expect(await deferEntries(page)).toEqual({ [`${DEFER_PREFIX}${sessionId}`]: STUDENT_ID });
});

test('a failed save from the leave confirmation stays without deferring', async ({ page }) => {
    await installSyntheticApi(page);
    const prompt = await installPromptApi(page, okProjection(projection()));
    prompt.putBehavior = 'error';
    await seedSession(page, 'student');
    await page.goto(COMPLETE_PATH);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hi there');
    await page.getByRole('textbox', { name: 'Entry year' }).fill('2022');
    await page.getByRole('button', { name: 'Complete later' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByText('Synthetic save failure')).toBeVisible();
    await expect(page).toHaveURL(/\/student\/profile\/complete/);
    expect(prompt.puts).toHaveLength(1);
    expect(await deferEntries(page)).toEqual({});
});

test('a deferral in one tab is visible in another without disturbing its dirty form', async ({ page }) => {
    await installSyntheticApi(page);
    const responder = okProjection(projection());
    await installPromptApi(page, responder);
    await mockPasswordLogin(page);
    await submitPasswordLogin(page, null);
    await page.waitForURL('**/student/profile/complete**');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hi there');

    const second = await page.context().newPage();
    await installPromptApi(second, responder);
    await second.goto(COMPLETE_PATH);
    await expect(second.getByRole('heading', { level: 1 })).toHaveText('Hi there');
    await second.getByRole('textbox', { name: 'Entry year' }).fill('2021');

    await page.getByRole('button', { name: 'Complete later' }).click();
    await page.waitForURL('**/marketplace');
    const sessionId = await activeSessionId(page);
    expect(sessionId).not.toBeNull();
    await expect.poll(() => deferEntries(second)).toEqual({ [`${DEFER_PREFIX}${sessionId}`]: STUDENT_ID });
    await second.waitForTimeout(500);
    await expect(second).toHaveURL(/\/student\/profile\/complete/);
    await expect(second.getByRole('textbox', { name: 'Entry year' })).toHaveValue('2021');
    await second.close();
});

test('a deferral survives reload within the same session', async ({ page }) => {
    await installSyntheticApi(page);
    await installPromptApi(page, okProjection(projection()));
    await seedSession(page, 'student');
    await page.goto(COMPLETE_PATH);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hi there');
    await page.getByRole('button', { name: 'Complete later' }).click();
    await page.waitForURL('**/marketplace');
    const before = await deferEntries(page);
    expect(Object.keys(before)).toHaveLength(1);
    await page.reload();
    await page.waitForURL('**/marketplace');
    expect(await deferEntries(page)).toEqual(before);
});

test('logout clears the marker and a new login prompts again', async ({ page }) => {
    await installSyntheticApi(page);
    await installPromptApi(page, okProjection(projection()));
    await mockPasswordLogin(page);
    await submitPasswordLogin(page, null);
    await page.waitForURL('**/student/profile/complete**');
    const firstSession = await activeSessionId(page);
    expect(firstSession).not.toBeNull();
    await page.getByRole('button', { name: 'Complete later' }).click();
    await page.waitForURL('**/marketplace');
    expect(await deferEntries(page)).toEqual({ [`${DEFER_PREFIX}${firstSession}`]: STUDENT_ID });

    await page.goto('/student/profile');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/auth/student/login**');
    expect(await deferEntries(page)).toEqual({});

    await submitPasswordLogin(page, null);
    await page.waitForURL('**/student/profile/complete?redirect=%2Fmarketplace');
    const secondSession = await activeSessionId(page);
    expect(secondSession).not.toBeNull();
    expect(secondSession).not.toBe(firstSession);
    expect(await deferEntries(page)).toEqual({});
});

test('the profile call to action retries completion after a fail-open login', async ({ page }) => {
    await installSyntheticApi(page);
    let calls = 0;
    const prompt = await installPromptApi(page, () => {
        calls += 1;
        if (calls === 1) {
            return { status: 500, body: { success: false, error: { message: 'Synthetic projection failure' } } };
        }
        return { status: 200, body: { success: true, data: projection() } };
    });
    await mockPasswordLogin(page);
    await submitPasswordLogin(page, null);
    await page.waitForURL('**/marketplace');
    expect(prompt.getCalls).toBe(1);
    await page.goto('/student/profile');
    await page.getByRole('link', { name: 'Complete your student profile' }).click();
    await page.waitForURL('**/student/profile/complete?redirect=%2Fstudent%2Fprofile');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hi there');
});
