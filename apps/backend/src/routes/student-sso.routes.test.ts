import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { errorHandler } from '../common/middleware/errorHandler.js';
import { ConflictError, RateLimitError, ServiceUnavailableError } from '../common/errors/AppError.js';
import { createStudentSsoRouter, isStudentSsoCallbackPath, isStudentSsoRoute, type StudentSsoLink } from './student-sso.routes.js';
import type { StudentSsoFlowService } from '../services/auth/student-sso-flow.service.js';
import { StudentOidcOperationalError } from '../services/auth/student-google-oidc.js';
import { jwtService } from '../services/auth/jwt.service.js';
import { swaggerSpec } from '../config/swagger.js';
import { config } from '../config/env.js';
import { db } from '../config/database.js';

type Flow = Pick<StudentSsoFlowService, 'start' | 'callback' | 'finish' | 'callbackCookieNameForState'>;

const COMPLETION_ORIGIN = 'https://app.example.invalid';
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const COOKIE_NAME = `awoof_sso_${ATTEMPT_ID}`;

function stubFlow(overrides: Partial<Flow> = {}): Flow {
    return {
        start: async () => ({
            publicResult: {
                attemptId: ATTEMPT_ID,
                authorizationUrl: 'https://provider.example.invalid/authorize',
                finishSecret: 'finish-secret',
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
                serverNow: new Date().toISOString(),
            },
            callbackCookie: {
                name: COOKIE_NAME,
                value: 'browser-secret',
                maxAgeSeconds: 600,
                path: '/api/auth/student/sso',
                httpOnly: true,
                secure: true,
                sameSite: 'lax',
            },
        }),
        callback: async () => ({
            attemptId: ATTEMPT_ID,
            completionUrl: new URL(`${COMPLETION_ORIGIN}/auth/student/sso/complete?attempt=${ATTEMPT_ID}`),
        }),
        finish: async () => ({ outcome: 'restart_required' as const }),
        callbackCookieNameForState: async () => COOKIE_NAME,
        ...overrides,
    };
}

async function withServer(
    router: ReturnType<typeof createStudentSsoRouter>,
    operation: (baseUrl: string) => Promise<void>,
): Promise<void> {
    const originalGetPool = db.getPool;
    // Route fixtures exercise authorization shape, not a live database. The
    // session-aware middleware still receives a current ordinary-student row
    // whose live session matches the fixture token's session id.
    db.getPool = () => ({
        query: async () => ({ rows: [{
            password_setup_requires_recovery_code: false,
            recovery_reenrollment_requires_password: false,
            active_session_id: LINK_SID,
            deleted_at: null,
        }], rowCount: 1 }),
    } as never);
    const app = express();
    // Permit primitive JSON here so route schema tests exercise the router's
    // own strict validators rather than body-parser's default strict gate.
    app.use(express.json({ strict: false }));
    app.use('/sso', router);
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not expose a loopback port');
    try {
        await operation(`http://127.0.0.1:${address.port}/sso`);
    } finally {
        server.close();
        await once(server, 'close');
        db.getPool = originalGetPool;
    }
}

function routerWith(flow: Flow, overrides: Parameters<typeof createStudentSsoRouter>[1] = {}) {
    return createStudentSsoRouter(() => flow, {
        isIssuanceEnabled: () => true,
        enabledProviders: () => ['google', 'microsoft'],
        completionOrigin: COMPLETION_ORIGIN,
        recoveryOrigin: COMPLETION_ORIGIN,
        isSignupEnabled: () => true,
        isEmailConfigured: () => true,
        checkStartQuota: async () => undefined,
        pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
        ...overrides,
    });
}

function parseSetCookies(response: Response): string[] {
    const header = response.headers.get('set-cookie');
    return header ? [header] : [];
}

test('start sets the exact per-attempt handoff cookie and no-store headers', async () => {
    const seen: unknown[] = [];
    const flow = stubFlow({
        start: async (input) => {
            seen.push(input);
            return stubFlow().start(input);
        },
    });
    await withServer(routerWith(flow), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/google/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN },
            body: JSON.stringify({ email: 'ada@students.school.example', rememberMe: true, returnPath: '/marketplace' }),
        });
        assert.equal(response.status, 201);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
        const body = await response.json();
        assert.equal(body.success, true);
        assert.equal(body.data.attemptId, ATTEMPT_ID);
        assert.deepEqual(seen, [{
            provider: 'google',
            email: 'ada@students.school.example',
            rememberMe: true,
            returnPath: '/marketplace',
        }]);
        const [setCookie] = parseSetCookies(response);
        assert.ok(setCookie);
        assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=browser-secret;`));
        assert.match(setCookie, /Path=\/api\/auth\/student\/sso/);
        assert.match(setCookie, /Max-Age=600/);
        assert.match(setCookie, /HttpOnly/);
        assert.match(setCookie, /Secure/);
        assert.match(setCookie, /SameSite=Lax/);
        assert.doesNotMatch(setCookie, /Domain=/);
    });
});

test('passwordless signup context and send-code reject extra JSON fields before service invocation', async () => {
    let invoked = 0;
    const signup = { context: async () => { invoked++; return {}; }, sendCode: async () => { invoked++; return {}; }, verifyCode: async () => ({}), complete: async () => ({}) };
    await withServer(routerWith(stubFlow(), { signupService: () => signup as never }), async (baseUrl) => {
        for (const path of ['signup/context', 'signup/send-code']) {
            for (const body of [{ handoffId: ATTEMPT_ID, handoffSecret: 'secret', extra: true }, null, 'text', []]) {
                const response = await fetch(`${baseUrl}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN }, body: JSON.stringify(body) });
                assert.equal(response.status, 400);
            }
        }
    });
    assert.equal(invoked, 0);
});

test('signup completion resolves its cookie before committing the account', async () => {
    const completeBody = { handoffId: ATTEMPT_ID, handoffSecret: 'secret', fullName: 'Stu Dent', ageAttested: true, termsAccepted: true, termsVersion: '2026-01', verificationConsent: true, noticeVersion: '2026-01' };
    const post = (baseUrl: string) => fetch(`${baseUrl}/signup/complete`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN }, body: JSON.stringify(completeBody),
    });
    const completed = { user: { id: ATTEMPT_ID, email: 's@x.invalid', role: 'student' }, tokens: { accessToken: 'a', refreshToken: 'r' } };
    // Success clears the attempt cookie resolved before the commit.
    await withServer(routerWith(stubFlow(), {
        signupService: () => ({ complete: async () => completed } as never),
        pool: { query: async () => ({ rows: [{ attempt_id: ATTEMPT_ID }], rowCount: 1 }) } as never,
    }), async (baseUrl) => {
        const response = await post(baseUrl);
        assert.equal(response.status, 201);
        const [setCookie] = parseSetCookies(response);
        assert.ok(setCookie);
        assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=;`));
    });
    // A lookup failure surfaces before the service commits, so it can
    // never mask an already-created account as a 500 with a dead retry.
    let commits = 0;
    await withServer(routerWith(stubFlow(), {
        signupService: () => ({ complete: async () => { commits++; return completed; } } as never),
        pool: { query: async () => { throw new Error('database unavailable'); } } as never,
    }), async (baseUrl) => {
        const response = await post(baseUrl);
        assert.equal(response.status, 500);
        assert.equal(commits, 0);
    });
});

test('Microsoft fresh-reauth routes preserve the browser binding and never use the ordinary login flow', async () => {
    const reauthAttemptId = '66666666-6666-4666-8666-666666666666';
    const seen: string[] = [];
    const reauth = {
        terminalizeFailedAttempt: async () => undefined,
        isDeadAttempt: async () => false,
        isInFlightAttempt: async () => false,
        callbackCookieNameForState: async (state: string | null) => state === 'reauth-state' ? `awoof_reauth_${reauthAttemptId}` : null,
        callback: async () => {
            seen.push('callback');
            return { attemptId: reauthAttemptId, completionUrl: new URL(`${COMPLETION_ORIGIN}/auth/student/sso/complete?reauth=${reauthAttemptId}`) };
        },
        start: async () => {
            seen.push('start');
            return { attemptId: reauthAttemptId, authorizationUrl: 'https://provider.example.invalid/fresh', callbackCookie: 'reauth-browser' };
        },
        finish: async (input: { callbackCookie?: string }) => {
            seen.push(`finish:${input.callbackCookie}`);
            return { grantId: 'grant-id', grantSecret: 'grant-secret', expiresAt: new Date(Date.now() + 60_000).toISOString() };
        },
    };
    const flow = stubFlow({ callback: async () => { throw new Error('ordinary login callback must not run'); } });
    await withServer(routerWith(flow, { reauthService: () => reauth as never }), async (baseUrl) => {
        const start = await fetch(`${baseUrl}/reauth/microsoft/start`, {
            method: 'POST', headers: authHeaders(studentToken(true)), body: JSON.stringify({ purpose: 'link' }),
        });
        assert.equal(start.status, 201);
        assert.deepEqual(await start.json(), { success: true, data: { attemptId: reauthAttemptId, authorizationUrl: 'https://provider.example.invalid/fresh' } });
        assert.match(parseSetCookies(start)[0]!, new RegExp(`awoof_reauth_${reauthAttemptId}=reauth-browser`));
        const callback = await fetch(`${baseUrl}/microsoft/callback?state=reauth-state&code=code`, {
            redirect: 'manual', headers: { Cookie: `awoof_reauth_${reauthAttemptId}=reauth-browser` },
        });
        assert.equal(callback.status, 303);
        assert.equal(callback.headers.get('location'), `${COMPLETION_ORIGIN}/auth/student/sso/complete?reauth=${reauthAttemptId}`);
        const finish = await fetch(`${baseUrl}/reauth/finish`, {
            method: 'POST',
            headers: { ...authHeaders(studentToken(true)), Cookie: `awoof_reauth_${reauthAttemptId}=reauth-browser` },
            body: JSON.stringify({ attemptId: reauthAttemptId }),
        });
        assert.equal(finish.status, 201);
        assert.equal((await finish.json()).data.grantId, 'grant-id');
        assert.match(parseSetCookies(finish)[0]!, new RegExp(`awoof_reauth_${reauthAttemptId}=;`));
    });
    assert.deepEqual(seen, ['start', 'callback', 'finish:reauth-browser']);
});

test('failed Microsoft fresh-reauth callbacks redirect to the bounded completion page', async () => {
    const reauthAttemptId = '67666666-6666-4666-8666-666666666666';
    const reauth = {
        terminalizeFailedAttempt: async () => undefined,
        isDeadAttempt: async () => false,
        isInFlightAttempt: async () => false,
        callbackCookieNameForState: async (state: string | null) => state === 'failed-reauth-state' ? `awoof_reauth_${reauthAttemptId}` : null,
        attemptIdForState: async (state: string | null) => state === 'failed-reauth-state' ? reauthAttemptId : null,
        callback: async () => { throw new ConflictError('Student SSO reauthentication is no longer valid'); },
    };
    const flow = stubFlow({ callback: async () => { throw new Error('ordinary login callback must not run'); } });
    await withServer(routerWith(flow, { reauthService: () => reauth as never }), async (baseUrl) => {
        const callback = await fetch(`${baseUrl}/microsoft/callback?state=failed-reauth-state&code=code`, {
            redirect: 'manual', headers: { Cookie: `awoof_reauth_${reauthAttemptId}=reauth-browser` },
        });
        assert.equal(callback.status, 303);
        assert.equal(callback.headers.get('location'), `${COMPLETION_ORIGIN}/auth/student/sso/complete?reauth=${reauthAttemptId}`);
        assert.match(parseSetCookies(callback)[0]!, new RegExp(`awoof_reauth_${reauthAttemptId}=;`));
    });
});

test('cancelled and invalid provider reauth callbacks redirect to the bounded completion page', async () => {
    for (const category of ['cancelled_or_permission', 'invalid_identity'] as const) {
        const reauthAttemptId = '69666666-6666-4666-8666-666666666666';
        const reauth = {
            terminalizeFailedAttempt: async () => undefined,
            isDeadAttempt: async () => false,
            isInFlightAttempt: async () => false,
            callbackCookieNameForState: async (state: string | null) => state === 'cancelled-reauth-state' ? `awoof_reauth_${reauthAttemptId}` : null,
            attemptIdForState: async (state: string | null) => state === 'cancelled-reauth-state' ? reauthAttemptId : null,
            callback: async () => { throw new StudentOidcOperationalError(category); },
        };
        const flow = stubFlow({ callback: async () => { throw new Error('ordinary login callback must not run'); } });
        await withServer(routerWith(flow, { reauthService: () => reauth as never }), async (baseUrl) => {
            const callback = await fetch(`${baseUrl}/microsoft/callback?state=cancelled-reauth-state&code=code`, {
                redirect: 'manual', headers: { Cookie: `awoof_reauth_${reauthAttemptId}=reauth-browser` },
            });
            assert.equal(callback.status, 303);
            assert.equal(callback.headers.get('location'), `${COMPLETION_ORIGIN}/auth/student/sso/complete?reauth=${reauthAttemptId}`);
            assert.match(parseSetCookies(callback)[0]!, new RegExp(`awoof_reauth_${reauthAttemptId}=;`));
        });
    }
});

test('unavailable provider reauth callbacks still surface as JSON errors', async () => {
    const reauthAttemptId = '6a666666-6666-4666-8666-666666666666';
    const reauth = {
        terminalizeFailedAttempt: async () => undefined,
        isDeadAttempt: async () => false,
        isInFlightAttempt: async () => false,
        callbackCookieNameForState: async (state: string | null) => state === 'outage-reauth-state' ? `awoof_reauth_${reauthAttemptId}` : null,
        attemptIdForState: async (state: string | null) => state === 'outage-reauth-state' ? reauthAttemptId : null,
        callback: async () => { throw new StudentOidcOperationalError('upstream_unavailable'); },
    };
    const flow = stubFlow({ callback: async () => { throw new Error('ordinary login callback must not run'); } });
    await withServer(routerWith(flow, { reauthService: () => reauth as never }), async (baseUrl) => {
        const callback = await fetch(`${baseUrl}/microsoft/callback?state=outage-reauth-state&code=code`, {
            redirect: 'manual', headers: { Cookie: `awoof_reauth_${reauthAttemptId}=reauth-browser` },
        });
        assert.equal(callback.status, 500);
    });
});

test('failed reauth callbacks terminalize the dead attempt before redirecting', async () => {
    const reauthAttemptId = '6c666666-6666-4666-8666-666666666666';
    const terminalized: string[] = [];
    const reauth = {
        terminalizeFailedAttempt: async (attemptId: string) => { terminalized.push(attemptId); },
        isDeadAttempt: async () => false,
        isInFlightAttempt: async () => false,
        callbackCookieNameForState: async (state: string | null) => state === 'failed-terminalize-state' ? `awoof_reauth_${reauthAttemptId}` : null,
        attemptIdForState: async (state: string | null) => state === 'failed-terminalize-state' ? reauthAttemptId : null,
        callback: async () => { throw new ConflictError('Student SSO reauthentication is no longer valid'); },
    };
    const flow = stubFlow({ callback: async () => { throw new Error('ordinary login callback must not run'); } });
    await withServer(routerWith(flow, { reauthService: () => reauth as never }), async (baseUrl) => {
        const callback = await fetch(`${baseUrl}/microsoft/callback?state=failed-terminalize-state&code=code`, {
            redirect: 'manual', headers: { Cookie: `awoof_reauth_${reauthAttemptId}=reauth-browser` },
        });
        assert.equal(callback.status, 303);
        // The redirect deletes the only browser binding that could finish
        // the attempt, so the dead row is terminalized first.
        assert.deepEqual(terminalized, [reauthAttemptId]);
    });
});

test('a duplicate callback racing a live redemption keeps the winner binding', async () => {
    const reauthAttemptId = '6f666666-6666-4666-8666-666666666666';
    let terminalized = false;
    const reauth = {
        terminalizeFailedAttempt: async () => { terminalized = true; },
        isDeadAttempt: async () => false,
        isInFlightAttempt: async (attemptId: string) => attemptId === reauthAttemptId,
        callbackCookieNameForState: async (state: string | null) => state === 'duplicate-race-state' ? `awoof_reauth_${reauthAttemptId}` : null,
        attemptIdForState: async (state: string | null) => state === 'duplicate-race-state' ? reauthAttemptId : null,
        callback: async () => { throw new ConflictError('Student SSO reauthentication is no longer valid'); },
    };
    const flow = stubFlow({ callback: async () => { throw new Error('ordinary login callback must not run'); } });
    await withServer(routerWith(flow, { reauthService: () => reauth as never }), async (baseUrl) => {
        const callback = await fetch(`${baseUrl}/microsoft/callback?state=duplicate-race-state&code=code`, {
            redirect: 'manual', headers: { Cookie: `awoof_reauth_${reauthAttemptId}=reauth-browser` },
        });
        // Still a bounded redirect, but the binding belongs to the live
        // redemption: nothing terminalizes and no clearing Set-Cookie
        // goes out, so finish can still exchange the winner's proof.
        assert.equal(callback.status, 303);
        assert.equal(callback.headers.get('location'), `${COMPLETION_ORIGIN}/auth/student/sso/complete?reauth=${reauthAttemptId}`);
        assert.equal(terminalized, false);
        assert.deepEqual(parseSetCookies(callback), []);
    });
});

test('a delayed callback for a scrubbed reauth attempt redirects to bounded completion', async () => {
    const reauthAttemptId = '6d666666-6666-4666-8666-666666666666';
    const reauth = {
        terminalizeFailedAttempt: async () => undefined,
        isDeadAttempt: async (attemptId: string) => attemptId === reauthAttemptId,
        isInFlightAttempt: async () => false,
        callbackCookieNameForState: async () => null,
        attemptIdForState: async () => null,
        callback: async () => { throw new Error('scrubbed attempts have no state to redeem'); },
    };
    const flow = stubFlow({
        callbackCookieNameForState: async () => null,
        callback: async () => { throw new Error('ordinary login callback must not run'); },
    });
    await withServer(routerWith(flow, { reauthService: () => reauth as never }), async (baseUrl) => {
        const callback = await fetch(`${baseUrl}/microsoft/callback?state=scrubbed-state&code=code`, {
            redirect: 'manual', headers: { Cookie: `awoof_reauth_${reauthAttemptId}=reauth-browser` },
        });
        // Neither state resolves, but the per-attempt cookie names a
        // confirmed-dead row: clear it and land bounded.
        assert.equal(callback.status, 303);
        assert.equal(callback.headers.get('location'), `${COMPLETION_ORIGIN}/auth/student/sso/complete?reauth=${reauthAttemptId}`);
        assert.match(parseSetCookies(callback)[0]!, new RegExp(`awoof_reauth_${reauthAttemptId}=;`));
    });
});

test('a live login callback is never hijacked by a stale dead reauth cookie', async () => {
    const reauthAttemptId = '6e666666-6666-4666-8666-666666666666';
    const reauth = {
        terminalizeFailedAttempt: async () => undefined,
        isDeadAttempt: async () => true,
        isInFlightAttempt: async () => false,
        callbackCookieNameForState: async () => null,
        attemptIdForState: async () => null,
        callback: async () => { throw new Error('reauth must not run for a login state'); },
    };
    let loginRan = false;
    const flow = stubFlow({
        callbackCookieNameForState: async () => COOKIE_NAME,
        callback: async () => { loginRan = true; return stubFlow().callback({} as never); },
    });
    await withServer(routerWith(flow, { reauthService: () => reauth as never }), async (baseUrl) => {
        const callback = await fetch(`${baseUrl}/microsoft/callback?state=login-state&code=code`, {
            redirect: 'manual', headers: { Cookie: `awoof_reauth_${reauthAttemptId}=stale-browser` },
        });
        // The login state resolves, so the ordinary flow owns this
        // callback despite the dead cookie riding along.
        assert.equal(callback.status, 303);
        assert.ok(loginRan);
        assert.ok(!String(callback.headers.get('location')).includes('reauth='));
    });
});

test('failed reauth callbacks never pollute the shared completion URL', async () => {
    const { config } = await import('../config/env.js');
    const previous = config.studentSso.completionUrl;
    const shared = new URL(`${COMPLETION_ORIGIN}/auth/student/sso/complete`);
    config.studentSso.completionUrl = shared;
    try {
        const reauthAttemptId = '68666666-6666-4666-8666-666666666666';
        const reauth = {
            terminalizeFailedAttempt: async () => undefined,
            isDeadAttempt: async () => false,
            isInFlightAttempt: async () => false,
            callbackCookieNameForState: async (state: string | null) => state === 'polluting-state' ? `awoof_reauth_${reauthAttemptId}` : null,
            attemptIdForState: async (state: string | null) => state === 'polluting-state' ? reauthAttemptId : null,
            callback: async () => { throw new ConflictError('Student SSO reauthentication is no longer valid'); },
        };
        await withServer(routerWith(stubFlow(), { reauthService: () => reauth as never }), async (baseUrl) => {
            const callback = await fetch(`${baseUrl}/microsoft/callback?state=polluting-state&code=code`, {
                redirect: 'manual', headers: { Cookie: `awoof_reauth_${reauthAttemptId}=reauth-browser` },
            });
            assert.equal(callback.status, 303);
            assert.equal(callback.headers.get('location'), `${COMPLETION_ORIGIN}/auth/student/sso/complete?reauth=${reauthAttemptId}`);
        });
        // The process-wide configured URL must not retain the attempt:
        // later ordinary completions clone it and would otherwise inherit
        // a stale reauth parameter that hijacks login completion.
        assert.equal(shared.searchParams.has('reauth'), false);
    } finally {
        config.studentSso.completionUrl = previous;
    }
});

test('Microsoft login callbacks reach the outage redirect when reauth is unavailable', async () => {
    // Full rollback nulls the attempt key, so reauth factory creation
    // itself throws; in-flight login callbacks must still land on the
    // bounded completion page instead of a bare 503.
    const outage = createStudentSsoRouter(
        () => { throw new ServiceUnavailableError('Student SSO is unavailable'); },
        {
            completionOrigin: COMPLETION_ORIGIN,
            isIssuanceEnabled: () => true,
            reauthService: () => { throw new ServiceUnavailableError('Student SSO is unavailable'); },
            pool: { query: async () => ({ rows: [{ id: ATTEMPT_ID }], rowCount: 1 }) } as never,
        },
    );
    await withServer(outage, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/microsoft/callback?state=opaque-state`, { redirect: 'manual' });
        assert.equal(response.status, 303);
        assert.equal(
            response.headers.get('location'),
            `${COMPLETION_ORIGIN}/auth/student/sso/complete?attempt=${ATTEMPT_ID}&outcome=connection_not_completed`,
        );
        const [setCookie] = parseSetCookies(response);
        assert.ok(setCookie);
        assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=;`));
    });
    // Only unavailability falls through: operational reauth failures
    // still surface instead of being mistaken for an outage.
    await withServer(routerWith(stubFlow(), { reauthService: () => { throw new ConflictError('nope'); } }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/microsoft/callback?state=opaque-state`, { redirect: 'manual' });
        assert.equal(response.status, 409);
    });
});

test('recovery-code endpoints expose only status metadata and require strict authenticated grants', async () => {
    const calls: string[] = [];
    const recovery = {
        status: async () => ({ status: 'active' as const, generation: 4 }),
        generate: async (input: { oldCode?: string }) => {
            calls.push(`generate:${input.oldCode ?? ''}`);
            return { pendingCodeId: ATTEMPT_ID, code: 'only-generation-returns-plaintext', expiresAt: new Date(Date.now() + 60_000).toISOString() };
        },
        activate: async (input: { oldCode?: string }) => {
            calls.push(`activate:${input.oldCode ?? ''}`);
            return { active: true as const };
        },
        remove: async (input: { oldCode: string }) => { calls.push(`remove:${input.oldCode}`); },
    };
    const grant = { grantId: '33333333-3333-4333-8333-333333333333', grantSecret: 'grant-secret' };
    await withServer(routerWith(stubFlow(), { recoveryCodeService: () => recovery as never }), async (baseUrl) => {
        const status = await fetch(`${baseUrl}/recovery-code`, { headers: authHeaders(studentToken(true)) });
        assert.equal(status.status, 200);
        assert.deepEqual((await status.json()).data, { status: 'active', generation: 4 });

        const malformed = await fetch(`${baseUrl}/recovery-code/generate`, {
            method: 'POST', headers: authHeaders(studentToken(true)), body: JSON.stringify({ reauthGrant: grant, injected: true }),
        });
        assert.equal(malformed.status, 400);

        const generated = await fetch(`${baseUrl}/recovery-code/generate`, {
            method: 'POST', headers: authHeaders(studentToken(true)), body: JSON.stringify({ reauthGrant: grant, oldCode: 'old-code' }),
        });
        assert.equal(generated.status, 201);
        assert.equal((await generated.json()).data.code, 'only-generation-returns-plaintext');

        const activated = await fetch(`${baseUrl}/recovery-code/activate`, {
            method: 'POST', headers: authHeaders(studentToken(true)),
            body: JSON.stringify({ reauthGrant: grant, pendingCodeId: ATTEMPT_ID, code: 'confirmed-code', oldCode: 'old-code' }),
        });
        assert.equal(activated.status, 200);
        assert.deepEqual((await activated.json()).data, { active: true });
    });
    assert.deepEqual(calls, ['generate:old-code', 'activate:old-code']);
});

test('recovery routes default to the trusted frontend origin without the option', async () => {
    const { config } = await import('../config/env.js');
    const frontendOrigin = new URL(config.frontend.url).origin;
    const recovery = { cancel: async () => undefined };
    const router = createStudentSsoRouter(() => stubFlow(), {
        isIssuanceEnabled: () => true,
        enabledProviders: () => ['google', 'microsoft'],
        checkStartQuota: async () => undefined,
        pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
        recoveryCodeService: () => recovery as never,
    });
    await withServer(router, async (baseUrl) => {
        const headers = (origin: string) => ({ 'content-type': 'application/json', origin, authorization: `Bearer ${studentToken(true)}` });
        const body = JSON.stringify({ pendingCodeId: ATTEMPT_ID });
        const allowed = await fetch(`${baseUrl}/recovery-code/cancel`, { method: 'POST', headers: headers(frontendOrigin), body });
        assert.equal(allowed.status, 204);
        const denied = await fetch(`${baseUrl}/recovery-code/cancel`, { method: 'POST', headers: headers('https://evil.example.invalid'), body });
        assert.equal(denied.status, 400);
    });
});

test('signup availability reports the deployment flag without authentication', async () => {
    await withServer(routerWith(stubFlow(), { isSignupEnabled: () => true }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/signup/availability`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { success: true, data: { available: true } });
    });
    await withServer(routerWith(stubFlow(), { isSignupEnabled: () => false }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/signup/availability`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { success: true, data: { available: false } });
    });
});

test('signup availability scopes to the handoff provider when requested', async () => {
    const options = { isSignupEnabled: () => true, enabledProviders: () => ['google' as const, 'microsoft' as const] };
    await withServer(routerWith(stubFlow(), options), async (baseUrl) => {
        const enabled = await fetch(`${baseUrl}/signup/availability?provider=microsoft`);
        assert.equal(enabled.status, 200);
        assert.deepEqual(await enabled.json(), { success: true, data: { available: true } });
        // The signup service accepts Microsoft handoffs only: an enabled
        // Google must not be offered an account creation that fails at
        // context with 409.
        const google = await fetch(`${baseUrl}/signup/availability?provider=google`);
        assert.equal(google.status, 200);
        assert.deepEqual(await google.json(), { success: true, data: { available: false } });
        const unknown = await fetch(`${baseUrl}/signup/availability?provider=github`);
        assert.equal(unknown.status, 400);
    });
    await withServer(routerWith(stubFlow(), { isSignupEnabled: () => true, enabledProviders: () => ['google' as const] }), async (baseUrl) => {
        const disabled = await fetch(`${baseUrl}/signup/availability?provider=microsoft`);
        assert.equal(disabled.status, 200);
        assert.deepEqual(await disabled.json(), { success: true, data: { available: false } });
    });
    await withServer(routerWith(stubFlow(), { ...options, isSignupEnabled: () => false }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/signup/availability?provider=microsoft`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { success: true, data: { available: false } });
    });
});

test('signup availability hides signup when email delivery is unavailable', async () => {
    // Without a mailer, send-code can only burn challenge allowance and
    // 503: availability must not advertise the flow.
    await withServer(routerWith(stubFlow(), { isSignupEnabled: () => true, isEmailConfigured: () => false }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/signup/availability?provider=microsoft`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { success: true, data: { available: false } });
    });
});

test('signup routes default to the deployment flag when the option is omitted', async () => {
    const router = createStudentSsoRouter(() => stubFlow(), {
        isIssuanceEnabled: () => true,
        enabledProviders: () => ['google', 'microsoft'],
        completionOrigin: COMPLETION_ORIGIN,
        checkStartQuota: async () => undefined,
        pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    });
    await withServer(router, async (baseUrl) => {
        // The deployment flag defaults to false in test env: fail closed.
        const response = await fetch(`${baseUrl}/signup/context`, {
            method: 'POST', headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN },
            body: JSON.stringify({ handoffId: ATTEMPT_ID, handoffSecret: 'secret' }),
        });
        assert.equal(response.status, 409);
    });
});

test('independent account recovery exposes the same start shape without an account lookup and keeps purpose server-bound', async () => {
    const calls: string[] = [];
    const recovery = {
        start: async (input: { email: string; purpose: string }) => {
            calls.push(`start:${input.email}:${input.purpose}`);
            return { attemptId: ATTEMPT_ID, secret: 'recovery-secret', expiresAt: '2026-09-26T12:00:00.000Z' };
        },
        verify: async () => { calls.push('verify'); },
        complete: async () => { calls.push('complete'); },
    };
    await withServer(routerWith(stubFlow(), { accountRecoveryService: () => recovery as never }), async (baseUrl) => {
        const started = await fetch(`${baseUrl}/account-recovery/start`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'student@example.invalid', purpose: 'compromise' }),
        });
        assert.equal(started.status, 202);
        assert.equal(started.headers.get('cache-control'), 'no-store');
        assert.deepEqual((await started.json()).data, { attemptId: ATTEMPT_ID, secret: 'recovery-secret', expiresAt: '2026-09-26T12:00:00.000Z' });
        const extra = await fetch(`${baseUrl}/account-recovery/start`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'student@example.invalid', purpose: 'compromise', injected: true }),
        });
        assert.equal(extra.status, 400);
        const blank = await fetch(`${baseUrl}/account-recovery/start`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: '', purpose: 'compromise' }),
        });
        assert.equal(blank.status, 400);
        const verified = await fetch(`${baseUrl}/account-recovery/verify`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ attemptId: ATTEMPT_ID, secret: 'recovery-secret', code: 'saved-code', otp: '123456' }),
        });
        assert.equal(verified.status, 204);
        const completed = await fetch(`${baseUrl}/account-recovery/complete`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ attemptId: ATTEMPT_ID, secret: 'recovery-secret', password: 'ValidNew1!' }),
        });
        assert.equal(completed.status, 204);
    });
    assert.deepEqual(calls, ['start:student@example.invalid:compromise', 'verify', 'complete']);
});

test('account recovery start fails closed when the mailer is unconfigured', async () => {
    const previousKey = config.studentAccountRecovery.codeKey;
    const previousBrevo = process.env.BREVO_API_KEY;
    config.studentAccountRecovery.codeKey = 'test-recovery-code-key-unconfigured-mailer';
    delete process.env.BREVO_API_KEY;
    try {
        // The default factory gates on the global email configuration: a
        // recovery key alone must not 202 when no OTP can be delivered.
        await withServer(routerWith(stubFlow()), async (baseUrl) => {
            const started = await fetch(`${baseUrl}/account-recovery/start`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ email: 'student@example.invalid', purpose: 'lost_access' }),
            });
            assert.equal(started.status, 503);
        });
    } finally {
        config.studentAccountRecovery.codeKey = previousKey;
        if (previousBrevo === undefined) delete process.env.BREVO_API_KEY;
        else process.env.BREVO_API_KEY = previousBrevo;
    }
});

test('start rejects unknown providers, malformed bodies, non-JSON, and inexact origins', async () => {
    await withServer(routerWith(stubFlow()), async (baseUrl) => {
        const badProvider = await fetch(`${baseUrl}/github/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN },
            body: JSON.stringify({ email: 'ada@students.school.example' }),
        });
        assert.equal(badProvider.status, 400);
        for (const body of [
            { email: 'ada@students.school.example', rememberMe: false, injected: true },
            { rememberMe: false },
            { email: 42, rememberMe: false },
            { email: 'ada@students.school.example', rememberMe: 'yes' },
        ]) {
            const response = await fetch(`${baseUrl}/google/start`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN },
                body: JSON.stringify(body),
            });
            assert.equal(response.status, 400, JSON.stringify(body));
        }
        const text = await fetch(`${baseUrl}/google/start`, {
            method: 'POST',
            headers: { 'content-type': 'text/plain', origin: COMPLETION_ORIGIN },
            body: 'email=ada@students.school.example',
        });
        assert.equal(text.status, 400);
        for (const origin of ['https://evil.example.invalid', 'https://app.example.invalid.evil.example.invalid']) {
            const response = await fetch(`${baseUrl}/google/start`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin },
                body: JSON.stringify({ email: 'ada@students.school.example' }),
            });
            assert.equal(response.status, 400, origin);
        }
    });
});

test('start fails closed when issuance or the provider is disabled', async () => {
    const disabled = createStudentSsoRouter(
        () => { throw new ServiceUnavailableError('Student SSO is unavailable'); },
        { completionOrigin: COMPLETION_ORIGIN, isIssuanceEnabled: () => false },
    );
    await withServer(disabled, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/google/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN },
            body: JSON.stringify({ email: 'ada@students.school.example' }),
        });
        assert.equal(response.status, 503);
    });
    await withServer(routerWith(stubFlow(), { enabledProviders: () => ['google'] }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/microsoft/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN },
            body: JSON.stringify({ email: 'ada@students.school.example' }),
        });
        assert.equal(response.status, 404);
    });
});

test('old SSO clients can still sign in while new passwordless signup is disabled', async () => {
    const router = routerWith(stubFlow(), { isSignupEnabled: () => false });
    await withServer(router, async (baseUrl) => {
        const oldLogin = await fetch(`${baseUrl}/google/start`, {
            method: 'POST', headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN },
            body: JSON.stringify({ email: 'ada@students.school.example' }),
        });
        assert.equal(oldLogin.status, 201);
        const signup = await fetch(`${baseUrl}/signup/context`, {
            method: 'POST', headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN },
            body: JSON.stringify({ handoffId: ATTEMPT_ID, handoffSecret: 'old-client-handoff' }),
        });
        assert.equal(signup.status, 409);
    });
});

test('start quota failures never reach the flow', async () => {
    let calls = 0;
    const flow = stubFlow({ start: async () => { calls += 1; return stubFlow().start({} as never); } });
    await withServer(routerWith(flow, {
        checkStartQuota: async () => { throw new RateLimitError('Too many SSO start requests.'); },
    }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/google/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN },
            body: JSON.stringify({ email: 'ada@students.school.example' }),
        });
        assert.equal(response.status, 429);
        assert.equal(calls, 0);
    });
});

test('start charges quota and issuance on one canonical mailbox', async () => {
    const seen: { quota: string[]; flow: unknown[] } = { quota: [], flow: [] };
    const flow = stubFlow({
        start: async (input: never) => {
            seen.flow.push((input as { email: string }).email);
            return stubFlow().start({} as never);
        },
    });
    await withServer(routerWith(flow, {
        checkStartQuota: async (_clientIp: string, mailbox: string) => { seen.quota.push(mailbox); },
    }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/google/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN },
            body: JSON.stringify({ email: '  Ada@Students.School.Example ' }),
        });
        assert.equal(response.status, 201);
        assert.deepEqual(seen.quota, ['ada@students.school.example']);
        assert.deepEqual(seen.flow, ['ada@students.school.example']);
    });
});

test('callback redirects to the fixed completion URL with no secret and keeps the cookie', async () => {
    await withServer(routerWith(stubFlow()), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/google/callback?state=opaque-state&code=opaque-code`, {
            redirect: 'manual',
            headers: { Cookie: `${COOKIE_NAME}=browser-secret` },
        });
        assert.equal(response.status, 303);
        const location = response.headers.get('location');
        assert.equal(location, `${COMPLETION_ORIGIN}/auth/student/sso/complete?attempt=${ATTEMPT_ID}`);
        assert.ok(!location.includes('browser-secret'));
        assert.ok(!location.includes('opaque-code'));
        assert.ok(!location.includes('opaque-state'));
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    });
});

test('callback failure outcome clears the resolved cookie on redirect', async () => {
    const flow = stubFlow({
        callback: async () => ({
            attemptId: ATTEMPT_ID,
            completionUrl: new URL(`${COMPLETION_ORIGIN}/auth/student/sso/complete?attempt=${ATTEMPT_ID}&outcome=connection_not_completed`),
            outcome: 'connection_not_completed',
        }),
    });
    await withServer(routerWith(flow), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/google/callback?state=opaque-state`, {
            redirect: 'manual',
            headers: { Cookie: `${COOKIE_NAME}=browser-secret` },
        });
        assert.equal(response.status, 303);
        assert.ok(response.headers.get('location')!.includes('outcome=connection_not_completed'));
        const [setCookie] = parseSetCookies(response);
        assert.ok(setCookie);
        assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=;`));
        assert.match(setCookie, /Path=\/api\/auth\/student\/sso/);
    });
});

test('callback client errors clear the resolved cookie while outages redirect bounded', async () => {
    const { config } = await import('../config/env.js');
    const googleEnabled = config.studentSso.google.enabled;
    // Client errors stay bare JSON only while their provider is live; a
    // disabled provider always lands on the bounded completion page.
    Object.assign(config.studentSso.google, { enabled: true });
    try {
        const failing = stubFlow({
            callback: async () => { throw new ConflictError('Student SSO attempt is no longer valid'); },
        });
        await withServer(routerWith(failing), async (baseUrl) => {
            const response = await fetch(`${baseUrl}/google/callback?state=opaque-state`, {
                redirect: 'manual',
                headers: { Cookie: `${COOKIE_NAME}=browser-secret` },
            });
            assert.equal(response.status, 409);
            const [setCookie] = parseSetCookies(response);
            assert.ok(setCookie);
            assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=;`));
        });
    } finally {
        Object.assign(config.studentSso.google, { enabled: googleEnabled });
    }

    const outage = createStudentSsoRouter(
        () => { throw new ServiceUnavailableError('Student SSO is unavailable'); },
        {
            completionOrigin: COMPLETION_ORIGIN,
            isIssuanceEnabled: () => true,
            pool: { query: async () => ({ rows: [{ id: ATTEMPT_ID }], rowCount: 1 }) } as never,
        },
    );
    await withServer(outage, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/google/callback?state=opaque-state`, { redirect: 'manual' });
        assert.equal(response.status, 303);
        assert.equal(
            response.headers.get('location'),
            `${COMPLETION_ORIGIN}/auth/student/sso/complete?attempt=${ATTEMPT_ID}&outcome=connection_not_completed`,
        );
        const [setCookie] = parseSetCookies(response);
        assert.ok(setCookie);
        assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=;`));
    });
});

test('callbacks for a disabled provider redirect bounded while the other provider stays live', async () => {
    const { config } = await import('../config/env.js');
    const googleEnabled = config.studentSso.google.enabled;
    const microsoftEnabled = config.studentSso.microsoft.enabled;
    Object.assign(config.studentSso.google, { enabled: false });
    Object.assign(config.studentSso.microsoft, { enabled: true });
    try {
        const failing = stubFlow({
            callback: async () => { throw new ConflictError('Student SSO attempt is no longer valid'); },
            callbackCookieNameForState: async () => null,
        });
        await withServer(routerWith(failing, {
            pool: { query: async () => ({ rows: [{ id: ATTEMPT_ID }], rowCount: 1 }) } as never,
        }), async (baseUrl) => {
            const response = await fetch(`${baseUrl}/google/callback?state=opaque-state`, { redirect: 'manual' });
            assert.equal(response.status, 303);
            assert.equal(
                response.headers.get('location'),
                `${COMPLETION_ORIGIN}/auth/student/sso/complete?attempt=${ATTEMPT_ID}&outcome=connection_not_completed`,
            );
            const [setCookie] = parseSetCookies(response);
            assert.ok(setCookie);
            assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=;`));
        });
    } finally {
        Object.assign(config.studentSso.google, { enabled: googleEnabled });
        Object.assign(config.studentSso.microsoft, { enabled: microsoftEnabled });
    }
});

test('finish clears the cookie on authentication and restart but retains it for linking', async () => {
    const authenticated = stubFlow({
        finish: async () => ({
            outcome: 'authenticated',
            user: { id: 'user', email: 'ada@students.school.example', role: 'student', verificationStatus: 'unverified' },
            tokens: { accessToken: 'access', refreshToken: 'refresh' },
            studentAssurance: null,
            assuranceStatus: 'unavailable',
        }),
    });
    await withServer(routerWith(authenticated), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/finish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN, Cookie: `${COOKIE_NAME}=browser-secret` },
            body: JSON.stringify({ attemptId: ATTEMPT_ID, finishSecret: 'finish-secret' }),
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).data.outcome, 'authenticated');
        const [setCookie] = parseSetCookies(response);
        assert.ok(setCookie);
        assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=;`));
    });

    const linking = stubFlow({
        finish: async () => ({ outcome: 'link_required', handoffId: 'handoff', handoffSecret: 'secret', expiresAt: new Date().toISOString(), provider: 'microsoft' }),
    });
    await withServer(routerWith(linking), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/finish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN, Cookie: `${COOKIE_NAME}=browser-secret` },
            body: JSON.stringify({ attemptId: ATTEMPT_ID, finishSecret: 'finish-secret' }),
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).data.outcome, 'link_required');
        assert.equal(response.headers.get('set-cookie'), null);
    });

    await withServer(routerWith(stubFlow()), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/finish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN, Cookie: `${COOKIE_NAME}=browser-secret` },
            body: JSON.stringify({ attemptId: ATTEMPT_ID, finishSecret: 'finish-secret' }),
        });
        assert.equal(response.status, 409);
        const body = await response.json();
        assert.equal(body.error.code, 'SSO_RESTART_REQUIRED');
        assert.deepEqual(body.error.details, { outcome: 'restart_required' });
        const [setCookie] = parseSetCookies(response);
        assert.ok(setCookie);
        assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=;`));
    });
});

test('finish enforces strict JSON, exact origin, and no-store headers', async () => {
    await withServer(routerWith(stubFlow()), async (baseUrl) => {
        for (const body of [
            { attemptId: ATTEMPT_ID, finishSecret: 'finish-secret', injected: true },
            { attemptId: ATTEMPT_ID },
            { attemptId: 'not-a-uuid', finishSecret: 'finish-secret' },
        ]) {
            const response = await fetch(`${baseUrl}/finish`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN },
                body: JSON.stringify(body),
            });
            assert.equal(response.status, 400, JSON.stringify(body));
        }
        const wrongOrigin = await fetch(`${baseUrl}/finish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://evil.example.invalid' },
            body: JSON.stringify({ attemptId: ATTEMPT_ID, finishSecret: 'finish-secret' }),
        });
        assert.equal(wrongOrigin.status, 400);
        const text = await fetch(`${baseUrl}/finish`, {
            method: 'POST',
            headers: { 'content-type': 'text/plain', origin: COMPLETION_ORIGIN },
            body: 'attemptId=x',
        });
        assert.equal(text.status, 400);
    });
});

test('failed callbacks consume the dedicated limit while completions are excused', async () => {
    const { config } = await import('../config/env.js');
    const googleEnabled = config.studentSso.google.enabled;
    Object.assign(config.studentSso.google, { enabled: true });
    try {
        const failing = stubFlow({
            callback: async () => { throw new ConflictError('Student SSO attempt is no longer valid'); },
            callbackCookieNameForState: async () => null,
        });
        const limited = routerWith(failing, { callbackLimiterMax: 2 });
        await withServer(limited, async (baseUrl) => {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const response = await fetch(`${baseUrl}/google/callback?state=opaque-state`, { redirect: 'manual' });
                assert.equal(response.status, 409);
            }
            const throttled = await fetch(`${baseUrl}/google/callback?state=opaque-state`, { redirect: 'manual' });
            assert.equal(throttled.status, 429);
        });

        const succeeding = routerWith(stubFlow(), { callbackLimiterMax: 1 });
        await withServer(succeeding, async (baseUrl) => {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const response = await fetch(`${baseUrl}/google/callback?state=opaque-state`, {
                    redirect: 'manual',
                    headers: { Cookie: `${COOKIE_NAME}=browser-secret` },
                });
                assert.equal(response.status, 303);
            }
        });
    } finally {
        Object.assign(config.studentSso.google, { enabled: googleEnabled });
    }
});

test('failed reauth redirects consume the dedicated callback limit', async () => {
    const reauthAttemptId = '6b666666-6666-4666-8666-666666666666';
    const reauth = {
        terminalizeFailedAttempt: async () => undefined,
        isDeadAttempt: async () => false,
        isInFlightAttempt: async () => false,
        callbackCookieNameForState: async (state: string | null) => state === 'counted-failure-state' ? `awoof_reauth_${reauthAttemptId}` : null,
        attemptIdForState: async (state: string | null) => state === 'counted-failure-state' ? reauthAttemptId : null,
        callback: async () => { throw new ConflictError('Student SSO reauthentication is no longer valid'); },
    };
    const flow = stubFlow({ callback: async () => { throw new Error('ordinary login callback must not run'); } });
    await withServer(routerWith(flow, { reauthService: () => reauth as never, callbackLimiterMax: 1 }), async (baseUrl) => {
        const first = await fetch(`${baseUrl}/microsoft/callback?state=counted-failure-state&code=code`, {
            redirect: 'manual', headers: { Cookie: `awoof_reauth_${reauthAttemptId}=reauth-browser` },
        });
        assert.equal(first.status, 303);
        // The bounded failure redirect is unauthenticated, so replaying
        // the known state counts against the quota instead of excusing.
        const replay = await fetch(`${baseUrl}/microsoft/callback?state=counted-failure-state&code=code`, {
            redirect: 'manual', headers: { Cookie: `awoof_reauth_${reauthAttemptId}=reauth-browser` },
        });
        assert.equal(replay.status, 429);
    });
});

test('SSO namespace predicates match only the student SSO paths', () => {
    assert.equal(isStudentSsoRoute('/api/auth/student/sso/google/start'), true);
    assert.equal(isStudentSsoRoute('/api/auth/student/sso/finish'), true);
    assert.equal(isStudentSsoRoute('/api/auth/student/sso'), true);
    assert.equal(isStudentSsoRoute('/api/auth/login'), false);
    assert.equal(isStudentSsoRoute('/api/verification/microsoft/callback'), false);
    assert.equal(isStudentSsoCallbackPath('/api/auth/student/sso/google/callback'), true);
    assert.equal(isStudentSsoCallbackPath('/api/auth/student/sso/microsoft/callback'), true);
    assert.equal(isStudentSsoCallbackPath('/api/auth/student/sso/google/start'), false);
    assert.equal(isStudentSsoCallbackPath('/api/verification/microsoft/callback'), false);
});

test('OpenAPI documents the browser-bound SSO contract', () => {
    const paths = (swaggerSpec as { paths: Record<string, unknown> }).paths;
    assert.ok(paths['/api/auth/student/sso/{provider}/start']);
    assert.ok(paths['/api/auth/student/sso/{provider}/callback']);
    assert.ok(paths['/api/auth/student/sso/finish']);
});

test('OpenAPI documents disabled passwordless signup and recovery contracts without benefit claims', () => {
    const spec = swaggerSpec as { paths: Record<string, { post?: { description?: string; requestBody?: unknown; responses?: Record<string, unknown> }; get?: { description?: string; responses?: Record<string, unknown> } }>; components: { schemas: Record<string, unknown> } };
    const paths = spec.paths;
    for (const path of [
        '/api/auth/student/sso/signup/context', '/api/auth/student/sso/signup/send-code',
        '/api/auth/student/sso/signup/verify-code', '/api/auth/student/sso/signup/complete',
        '/api/auth/student/sso/recovery-code', '/api/auth/student/sso/recovery-code/generate',
        '/api/auth/student/sso/recovery-code/activate', '/api/auth/student/sso/recovery-code/remove',
        '/api/auth/student/sso/account-recovery/start', '/api/auth/student/sso/account-recovery/verify',
        '/api/auth/student/sso/account-recovery/complete',
    ]) assert.ok(paths[path], `missing ${path}`);
    assert.match(paths['/api/auth/student/sso/signup/context']?.post?.description ?? '', /Disabled/);
    assert.match(paths['/api/auth/student/sso/account-recovery/start']?.post?.description ?? '', /never transfers account ownership/);
    for (const path of [
        '/api/auth/student/sso/signup/context', '/api/auth/student/sso/signup/send-code',
        '/api/auth/student/sso/signup/verify-code', '/api/auth/student/sso/signup/complete',
        '/api/auth/student/sso/recovery-code/generate', '/api/auth/student/sso/recovery-code/activate',
        '/api/auth/student/sso/recovery-code/remove', '/api/auth/student/sso/account-recovery/start',
        '/api/auth/student/sso/account-recovery/verify', '/api/auth/student/sso/account-recovery/complete',
    ]) {
        assert.ok(paths[path]?.post?.requestBody, `${path} needs a strict request contract`);
        assert.ok(paths[path]?.post?.responses?.['400']);
        assert.ok(paths[path]?.post?.responses?.['409']);
    }
    assert.ok(paths['/api/auth/student/sso/recovery-code']?.get?.responses?.['401']);
    for (const schema of ['PasswordlessSignupHandoffRequest', 'PasswordlessSignupCompleteRequest', 'RecoveryCodeGenerateRequest', 'RecoveryCodeStatusResponse', 'AccountRecoveryVerifyRequest']) {
        assert.ok(spec.components.schemas[schema], `missing typed OpenAPI schema ${schema}`);
    }
    // Both OTP fields reject anything but six digits at runtime; the
    // published contract must match so generated forms cannot accept
    // requests the API deterministically rejects.
    assert.deepEqual(spec.components.schemas.PasswordlessSignupVerifyRequest.properties.code, {
        type: 'string', minLength: 6, maxLength: 6, pattern: '^\\d{6}$', description: 'Six-digit mailbox OTP; anything else is rejected.',
    });
    assert.deepEqual(spec.components.schemas.AccountRecoveryVerifyRequest.properties.otp, {
        type: 'string', minLength: 6, maxLength: 6, pattern: '^\\d{6}$', description: 'Six-digit mailbox OTP; anything else is rejected.',
    });
});

const LINK_ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const LINK_SID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LINK_HANDOFF_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LINK_GRANT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LINK_IDENTITY_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function studentToken(withSid: boolean): string {
    return jwtService.generateAccessToken({
        userId: LINK_ACTOR_ID,
        email: 'owner@students.school.example',
        role: 'student',
        ...(withSid ? { sid: LINK_SID } : {}),
    });
}

function stubLink(overrides: Partial<StudentSsoLink> = {}): StudentSsoLink {
    return {
        reauth: async () => ({ grantId: LINK_GRANT_ID, grantSecret: 'grant-secret', expiresAt: new Date(Date.now() + 300_000).toISOString() }),
        link: async () => ({
            outcome: 'linked' as const,
            identity: { id: LINK_IDENTITY_ID, provider: 'google' as const, universityName: 'Fixture University', linkedAt: new Date().toISOString() },
            schoolAssertion: 'recorded' as const,
            reactivated: false,
            attemptId: ATTEMPT_ID,
        }),
        listIdentities: async () => [],
        unlink: async () => ({ unlinked: true as const, sessionRevoked: false }),
        ...overrides,
    };
}

function linkRouter(link: StudentSsoLink, overrides: Parameters<typeof createStudentSsoRouter>[1] = {}) {
    return routerWith(stubFlow(), { linkService: () => link, ...overrides });
}

function authHeaders(token: string): Record<string, string> {
    return { 'content-type': 'application/json', origin: COMPLETION_ORIGIN, authorization: `Bearer ${token}` };
}

test('reauth issues a purpose-bound grant for the current student session', async () => {
    const seen: unknown[] = [];
    const link = stubLink({
        reauth: async (input) => {
            seen.push(input);
            return { grantId: LINK_GRANT_ID, grantSecret: 'grant-secret', expiresAt: new Date(Date.now() + 300_000).toISOString() };
        },
    });
    await withServer(linkRouter(link), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/reauth`, {
            method: 'POST',
            headers: authHeaders(studentToken(true)),
            body: JSON.stringify({ password: 'Secret!123', purpose: 'link' }),
        });
        assert.equal(response.status, 201);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
        const body = await response.json();
        assert.equal(body.success, true);
        assert.deepEqual(Object.keys(body.data).sort(), ['expiresAt', 'grantId', 'grantSecret']);
        assert.deepEqual(seen, [{ userId: LINK_ACTOR_ID, sid: LINK_SID, password: 'Secret!123', purpose: 'link' }]);
    });
});

test('link and unlink routes require an authenticated student session with a session id', async () => {
    const link = stubLink();
    await withServer(linkRouter(link), async (baseUrl) => {
        const linkBody = JSON.stringify({
            handoffId: LINK_HANDOFF_ID,
            handoffSecret: 'handoff-secret',
            reauthGrant: { grantId: LINK_GRANT_ID, grantSecret: 'grant-secret' },
        });
        const anonymous = await fetch(`${baseUrl}/link`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: COMPLETION_ORIGIN },
            body: linkBody,
        });
        assert.equal(anonymous.status, 401);
        const legacy = await fetch(`${baseUrl}/link`, {
            method: 'POST',
            headers: authHeaders(studentToken(false)),
            body: linkBody,
        });
        assert.equal(legacy.status, 401);
        const vendor = await fetch(`${baseUrl}/link`, {
            method: 'POST',
            headers: authHeaders(jwtService.generateAccessToken({ userId: LINK_ACTOR_ID, email: 'vendor@example.invalid', role: 'vendor', sid: LINK_SID })),
            body: linkBody,
        });
        assert.equal(vendor.status, 401);
        const unlinkBody = JSON.stringify({ reauthGrant: { grantId: LINK_GRANT_ID, grantSecret: 'grant-secret' } });
        const unlinkLegacy = await fetch(`${baseUrl}/identities/${LINK_IDENTITY_ID}/unlink`, {
            method: 'POST',
            headers: authHeaders(studentToken(false)),
            body: unlinkBody,
        });
        assert.equal(unlinkLegacy.status, 401);
        const identitiesAnonymous = await fetch(`${baseUrl}/identities`, { headers: { origin: COMPLETION_ORIGIN } });
        assert.equal(identitiesAnonymous.status, 401);
    });
});

test('link enforces strict bodies, exact origin, and JSON', async () => {
    const link = stubLink();
    await withServer(linkRouter(link), async (baseUrl) => {
        const valid = {
            handoffId: LINK_HANDOFF_ID,
            handoffSecret: 'handoff-secret',
            reauthGrant: { grantId: LINK_GRANT_ID, grantSecret: 'grant-secret' },
        };
        const bad = [
            { ...valid, extra: true },
            { ...valid, handoffId: 'not-a-uuid' },
            { ...valid, reauthGrant: { grantId: LINK_GRANT_ID } },
            { ...valid, reauthGrant: { grantId: LINK_GRANT_ID, grantSecret: 'grant-secret', extra: true } },
        ];
        for (const body of bad) {
            const response = await fetch(`${baseUrl}/link`, {
                method: 'POST',
                headers: authHeaders(studentToken(true)),
                body: JSON.stringify(body),
            });
            assert.equal(response.status, 400);
        }
        const wrongOrigin = await fetch(`${baseUrl}/link`, {
            method: 'POST',
            headers: { ...authHeaders(studentToken(true)), origin: 'https://evil.example' },
            body: JSON.stringify(valid),
        });
        assert.equal(wrongOrigin.status, 400);
        const plainText = await fetch(`${baseUrl}/link`, {
            method: 'POST',
            headers: { ...authHeaders(studentToken(true)), 'content-type': 'text/plain' },
            body: JSON.stringify(valid),
        });
        assert.equal(plainText.status, 400);
        const malformedUnlink = await fetch(`${baseUrl}/identities/not-a-uuid/unlink`, {
            method: 'POST',
            headers: authHeaders(studentToken(true)),
            body: JSON.stringify({ reauthGrant: { grantId: LINK_GRANT_ID, grantSecret: 'grant-secret' } }),
        });
        assert.equal(malformedUnlink.status, 400);
    });
});

test('link clears the handoff cookie on linked, mismatch, and restart outcomes', async () => {
    const linked = stubLink();
    await withServer(linkRouter(linked), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/link`, {
            method: 'POST',
            headers: authHeaders(studentToken(true)),
            body: JSON.stringify({
                handoffId: LINK_HANDOFF_ID,
                handoffSecret: 'handoff-secret',
                reauthGrant: { grantId: LINK_GRANT_ID, grantSecret: 'grant-secret' },
            }),
        });
        assert.equal(response.status, 201);
        const body = await response.json();
        assert.equal(body.data.outcome, 'linked');
        assert.deepEqual(Object.keys(body.data.identity).sort(), ['id', 'linkedAt', 'provider', 'universityName']);
        const [setCookie] = parseSetCookies(response);
        assert.ok(setCookie);
        assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=;`));
    });
    const reactivated = stubLink({
        link: async () => ({
            outcome: 'linked' as const,
            identity: { id: LINK_IDENTITY_ID, provider: 'microsoft' as const, universityName: 'Fixture University', linkedAt: new Date().toISOString() },
            schoolAssertion: 'not_attested' as const,
            reactivated: true,
            attemptId: ATTEMPT_ID,
        }),
    });
    await withServer(linkRouter(reactivated), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/link`, {
            method: 'POST',
            headers: authHeaders(studentToken(true)),
            body: JSON.stringify({
                handoffId: LINK_HANDOFF_ID,
                handoffSecret: 'handoff-secret',
                reauthGrant: { grantId: LINK_GRANT_ID, grantSecret: 'grant-secret' },
            }),
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).data.reactivated, true);
    });
    const mismatched = stubLink({ link: async () => ({ outcome: 'mismatch' as const, attemptId: ATTEMPT_ID }) });
    await withServer(linkRouter(mismatched), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/link`, {
            method: 'POST',
            headers: authHeaders(studentToken(true)),
            body: JSON.stringify({
                handoffId: LINK_HANDOFF_ID,
                handoffSecret: 'handoff-secret',
                reauthGrant: { grantId: LINK_GRANT_ID, grantSecret: 'grant-secret' },
            }),
        });
        assert.equal(response.status, 409);
        const body = await response.json();
        assert.equal(body.error.code, 'SSO_LINK_MISMATCH');
        const [setCookie] = parseSetCookies(response);
        assert.ok(setCookie);
        assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=;`));
    });
    const restarted = stubLink({ link: async () => ({ outcome: 'restart' as const, attemptId: ATTEMPT_ID }) });
    await withServer(linkRouter(restarted), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/link`, {
            method: 'POST',
            headers: authHeaders(studentToken(true)),
            body: JSON.stringify({
                handoffId: LINK_HANDOFF_ID,
                handoffSecret: 'handoff-secret',
                reauthGrant: { grantId: LINK_GRANT_ID, grantSecret: 'grant-secret' },
            }),
        });
        assert.equal(response.status, 409);
        assert.equal((await response.json()).error.code, 'SSO_RESTART_REQUIRED');
        const [setCookie] = parseSetCookies(response);
        assert.ok(setCookie);
        assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=;`));
    });
});

test('unlink reports the last login method honestly and revokes otherwise', async () => {
    const lastMethod = stubLink({ unlink: async () => ({ outcome: 'last_method' as const }) });
    await withServer(linkRouter(lastMethod), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/identities/${LINK_IDENTITY_ID}/unlink`, {
            method: 'POST',
            headers: authHeaders(studentToken(true)),
            body: JSON.stringify({ reauthGrant: { grantId: LINK_GRANT_ID, grantSecret: 'grant-secret' } }),
        });
        assert.equal(response.status, 409);
        const body = await response.json();
        assert.equal(body.error.code, 'SSO_LAST_LOGIN_METHOD');
        assert.equal(response.headers.get('cache-control'), 'no-store');
    });
    const revoked = stubLink();
    await withServer(linkRouter(revoked), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/identities/${LINK_IDENTITY_ID}/unlink`, {
            method: 'POST',
            headers: authHeaders(studentToken(true)),
            body: JSON.stringify({ reauthGrant: { grantId: LINK_GRANT_ID, grantSecret: 'grant-secret' } }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { success: true, data: { unlinked: true, sessionRevoked: false } });
    });
});

test('identities lists owner identities with no-store and no subject material', async () => {
    const link = stubLink({
        listIdentities: async (userId) => {
            assert.equal(userId, LINK_ACTOR_ID);
            return [{ id: LINK_IDENTITY_ID, provider: 'google', universityName: 'Fixture University', linkedAt: new Date().toISOString() }];
        },
    });
    await withServer(linkRouter(link), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/identities`, {
            headers: { authorization: `Bearer ${studentToken(true)}` },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = await response.json();
        assert.equal(body.data.identities.length, 1);
        assert.deepEqual(Object.keys(body.data.identities[0]).sort(), ['id', 'linkedAt', 'provider', 'universityName']);
    });
});

test('link-confirmation endpoints are independently rate limited', async () => {
    const link = stubLink();
    const recovery = {
        generate: async () => ({ pendingCodeId: ATTEMPT_ID, code: 'code', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
        activate: async () => ({ active: true as const }),
        remove: async () => undefined,
    };
    const grant = { grantId: '33333333-3333-4333-8333-333333333333', grantSecret: 'grant-secret' };
    await withServer(linkRouter(link, { linkLimiterMax: 1, recoveryCodeService: () => recovery as never }), async (baseUrl) => {
        const first = await fetch(`${baseUrl}/reauth`, {
            method: 'POST',
            headers: authHeaders(studentToken(true)),
            body: JSON.stringify({ password: 'Secret!123', purpose: 'unlink' }),
        });
        assert.equal(first.status, 201);
        const second = await fetch(`${baseUrl}/reauth`, {
            method: 'POST',
            headers: authHeaders(studentToken(true)),
            body: JSON.stringify({ password: 'Secret!123', purpose: 'unlink' }),
        });
        assert.equal(second.status, 429);
        // The link bucket is independent of the exhausted reauth bucket.
        const independent = await fetch(`${baseUrl}/link`, {
            method: 'POST',
            headers: authHeaders(studentToken(true)),
            body: JSON.stringify({
                handoffId: LINK_HANDOFF_ID,
                handoffSecret: 'handoff-secret',
                reauthGrant: { grantId: LINK_GRANT_ID, grantSecret: 'grant-secret' },
            }),
        });
        assert.equal(independent.status, 201);
        // Each recovery-code mutation has its own bucket: exhausting one
        // never blocks the others or password reauthentication.
        const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
            method: 'POST', headers: authHeaders(studentToken(true)), body: JSON.stringify(body),
        });
        assert.equal((await post('/recovery-code/generate', { reauthGrant: grant })).status, 201);
        assert.equal((await post('/recovery-code/generate', { reauthGrant: grant })).status, 429);
        assert.equal((await post('/recovery-code/activate', { reauthGrant: grant, pendingCodeId: ATTEMPT_ID, code: '123456' })).status, 200);
        assert.equal((await post('/recovery-code/activate', { reauthGrant: grant, pendingCodeId: ATTEMPT_ID, code: '123456' })).status, 429);
        assert.equal((await post('/recovery-code/remove', { reauthGrant: grant, oldCode: 'old-code' })).status, 204);
        assert.equal((await post('/recovery-code/remove', { reauthGrant: grant, oldCode: 'old-code' })).status, 429);
    });
});

test('OpenAPI documents the SSO linking contract', () => {
    const spec = swaggerSpec as { paths: Record<string, unknown>; components: { schemas: Record<string, Record<string, unknown>> } };
    assert.ok(spec.paths['/api/auth/student/sso/reauth']);
    assert.ok(spec.paths['/api/auth/student/sso/reauth/microsoft/start']);
    assert.ok(spec.paths['/api/auth/student/sso/reauth/finish']);
    assert.ok(spec.paths['/api/auth/student/sso/link']);
    assert.ok(spec.paths['/api/auth/student/sso/identities']);
    assert.ok(spec.paths['/api/auth/student/sso/identities/{id}/unlink']);
    assert.ok(spec.paths['/api/auth/student/sso/recovery-code/cancel']);
    assert.ok(spec.components.schemas['StudentSsoReauthResponse']);
    assert.ok(spec.components.schemas['StudentSsoReauthStartResponse']);
    assert.ok(spec.components.schemas['StudentSsoReauthFinishResponse']);
    assert.ok(spec.components.schemas['StudentSsoLinkResponse']);
    assert.ok(spec.components.schemas['StudentSsoIdentitiesResponse']);
    // Server-provided deadlines are part of the contract: generated clients
    // need them to determine when a pending code or handle expires.
    for (const name of ['RecoveryCodeGeneratedResponse', 'AccountRecoveryStartResponse', 'PasswordlessSignupVerifiedResponse']) {
        const schema = spec.components.schemas[name] as { properties: { data: { required: string[]; properties: Record<string, unknown> } } };
        assert.ok(schema.properties.data.required.includes('expiresAt'), `${name} requires expiresAt`);
        assert.ok(schema.properties.data.properties['expiresAt'], `${name} describes expiresAt`);
    }
});
