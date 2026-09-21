import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { errorHandler } from '../common/middleware/errorHandler.js';
import { ConflictError, RateLimitError, ServiceUnavailableError } from '../common/errors/AppError.js';
import { createStudentSsoRouter, isStudentSsoCallbackPath, isStudentSsoRoute } from './student-sso.routes.js';
import type { StudentSsoFlowService } from '../services/auth/student-sso-flow.service.js';
import { swaggerSpec } from '../config/swagger.js';

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
    const app = express();
    app.use(express.json());
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
    }
}

function routerWith(flow: Flow, overrides: Parameters<typeof createStudentSsoRouter>[1] = {}) {
    return createStudentSsoRouter(() => flow, {
        isIssuanceEnabled: () => true,
        enabledProviders: () => ['google', 'microsoft'],
        completionOrigin: COMPLETION_ORIGIN,
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
        finish: async () => ({ outcome: 'link_required', handoffId: 'handoff', handoffSecret: 'secret', expiresAt: new Date().toISOString() }),
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
