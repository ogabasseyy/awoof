import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { errorHandler } from '../common/middleware/errorHandler.js';
import { ConflictError, RateLimitError, ServiceUnavailableError } from '../common/errors/AppError.js';
import { createStudentSsoRouter, isStudentSsoCallbackPath, isStudentSsoRoute, type StudentSsoLink } from './student-sso.routes.js';
import type { StudentSsoFlowService } from '../services/auth/student-sso-flow.service.js';
import { jwtService } from '../services/auth/jwt.service.js';
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
        unlink: async () => ({ unlinked: true as const }),
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
        assert.deepEqual(await response.json(), { success: true, data: { unlinked: true } });
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
    await withServer(linkRouter(link, { linkLimiterMax: 1 }), async (baseUrl) => {
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
    });
});

test('OpenAPI documents the SSO linking contract', () => {
    const spec = swaggerSpec as { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    assert.ok(spec.paths['/api/auth/student/sso/reauth']);
    assert.ok(spec.paths['/api/auth/student/sso/link']);
    assert.ok(spec.paths['/api/auth/student/sso/identities']);
    assert.ok(spec.paths['/api/auth/student/sso/identities/{id}/unlink']);
    assert.ok(spec.components.schemas['StudentSsoReauthResponse']);
    assert.ok(spec.components.schemas['StudentSsoLinkResponse']);
    assert.ok(spec.components.schemas['StudentSsoIdentitiesResponse']);
});
