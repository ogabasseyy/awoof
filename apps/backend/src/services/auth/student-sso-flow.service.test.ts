import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestError, ConflictError } from '../../common/errors/AppError.js';
import {
    STUDENT_SSO_ATTEMPT_LIFETIME_SECONDS,
    STUDENT_SSO_COOKIE_PATH,
    STUDENT_SSO_OPEN_ATTEMPT_LIMIT,
    StudentSsoFlowService,
    assertAdapterPolicy,
    parseStudentSsoProvider,
    resolveStudentSsoReturnPath,
    studentSsoCookieName,
} from './student-sso-flow.service.js';

const ORIGIN = 'https://app.example.invalid';

test('handoff cookie uses the exact per-attempt name, path, and Lax flags', () => {
    const attemptId = '11111111-1111-4111-8111-111111111111';
    assert.equal(studentSsoCookieName(attemptId), `awoof_sso_${attemptId}`);
    assert.equal(STUDENT_SSO_COOKIE_PATH, '/api/auth/student/sso');
    assert.equal(STUDENT_SSO_ATTEMPT_LIFETIME_SECONDS, 600);
    assert.equal(STUDENT_SSO_OPEN_ATTEMPT_LIMIT, 3);
});

test('provider parsing accepts only the two login providers', () => {
    assert.equal(parseStudentSsoProvider('google'), 'google');
    assert.equal(parseStudentSsoProvider('microsoft'), 'microsoft');
    for (const value of [undefined, null, '', 'Google', 'github', 'microsoft ', 42, {}]) {
        assert.throws(() => parseStudentSsoProvider(value), BadRequestError, JSON.stringify(value));
    }
});

test('return path accepts same-origin relative targets without auth loops', () => {
    assert.equal(resolveStudentSsoReturnPath('/marketplace', ORIGIN), '/marketplace');
    assert.equal(resolveStudentSsoReturnPath('/marketplace?deal=1#offer', ORIGIN), '/marketplace?deal=1#offer');
    assert.equal(resolveStudentSsoReturnPath('https://app.example.invalid/student/profile', ORIGIN), '/student/profile');
    assert.equal(resolveStudentSsoReturnPath(null, ORIGIN), null);
    assert.equal(resolveStudentSsoReturnPath(undefined, ORIGIN), null);
});

test('return path rejects cross-origin, auth-loop, and malformed targets', () => {
    for (const candidate of [
        'https://evil.example.invalid/marketplace',
        'http://app.example.invalid.evil.example.invalid/',
        '/auth/student/login',
        '/auth',
        'https://app.example.invalid/auth/student/login',
        '/marketplace\\evil',
        '/marketplace%zz',
        'javascript:alert(1)',
        '',
        '   ',
    ]) {
        assert.throws(() => resolveStudentSsoReturnPath(candidate, ORIGIN), BadRequestError, candidate);
    }
    for (const candidate of [42, {}, [], 'x'.repeat(2049)]) {
        assert.throws(() => resolveStudentSsoReturnPath(candidate, ORIGIN), BadRequestError, JSON.stringify(candidate)?.slice(0, 32));
    }
});

test('adapter policy requires the exact approved issuer and realm shape', () => {
    assertAdapterPolicy({
        id: 'policy', universityId: 'university', provider: 'google',
        issuer: 'https://accounts.google.com', realm: 'students.school.example', version: 1,
    });
    assertAdapterPolicy({
        id: 'policy', universityId: 'university', provider: 'microsoft',
        issuer: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0',
        realm: '11111111-1111-4111-8111-111111111111', version: 1,
    });
    // Misconfigured policies fail closed: issuer/realm mismatch never reaches the provider.
    const bad = [
        { provider: 'google', issuer: 'https://evil.example.invalid', realm: 'students.school.example' },
        { provider: 'google', issuer: 'https://accounts.google.com', realm: 'not a domain' },
        { provider: 'microsoft', issuer: 'https://login.microsoftonline.com/tenant-a/v2.0', realm: 'tenant-a' },
        {
            provider: 'microsoft',
            issuer: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0',
            realm: '22222222-2222-4222-8222-222222222222',
        },
        {
            provider: 'microsoft',
            issuer: 'https://login.microsoftonline.com/common/v2.0',
            realm: '11111111-1111-4111-8111-111111111111',
        },
    ] as const;
    for (const policy of bad) {
        assert.throws(
            () => assertAdapterPolicy({ id: 'policy', universityId: 'university', version: 1, ...policy }),
            ConflictError,
            JSON.stringify(policy),
        );
    }
});

function unreachablePool(): never {
    throw new Error('unreachable pool must not be touched');
}

function testService(overrides: { isEnabled?: () => boolean; isProviderEnabled?: (provider: 'google' | 'microsoft') => boolean } = {}): StudentSsoFlowService {
    return new StudentSsoFlowService({
        pool: { connect: async () => unreachablePool() } as never,
        oidc: { forPolicy: () => unreachablePool() },
        attemptKey: Buffer.alloc(32).toString('base64url'),
        callbackUrls: {
            google: new URL('https://api.example.invalid/api/auth/student/sso/google/callback'),
            microsoft: new URL('https://api.example.invalid/api/auth/student/sso/microsoft/callback'),
        },
        completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'),
        isEnabled: overrides.isEnabled ?? (() => true),
        isProviderEnabled: overrides.isProviderEnabled ?? (() => true),
    });
}

test('start and callback refuse a disabled provider before touching storage', async () => {
    const service = testService({ isProviderEnabled: () => false });
    await assert.rejects(
        service.start({ provider: 'google', email: 'a@b.example', rememberMe: false }),
        /no longer valid/,
    );
    const callbackUrl = new URL('https://api.example.invalid/api/auth/student/sso/google/callback?state=x');
    await assert.rejects(
        service.callback({ provider: 'google', callbackUrl, browserCookies: [] }),
        /no longer valid/,
    );
    // Selectivity is per provider, not aggregate: only google is refused here.
    const selective = testService({ isProviderEnabled: (provider) => provider === 'microsoft' });
    await assert.rejects(
        selective.start({ provider: 'google', email: 'a@b.example', rememberMe: false }),
        /no longer valid/,
    );
});

test('start validates input before touching durable storage', async () => {
    const service = testService();
    await assert.rejects(service.start({ provider: 'github', email: 'a@b.example', rememberMe: false }), BadRequestError);
    await assert.rejects(service.start({ provider: 'google', email: 'not-an-email', rememberMe: false }), BadRequestError);
    await assert.rejects(service.start({ provider: 'google', email: 'a@b.example', rememberMe: 'yes' }), BadRequestError);
    await assert.rejects(
        service.start({ provider: 'google', email: 'a@b.example', rememberMe: false, returnPath: '/auth/loop' }),
        BadRequestError,
    );
});

test('finish validates input before touching durable storage', async () => {
    const service = testService();
    await assert.rejects(service.finish({ attemptId: 'not-a-uuid', finishSecret: 'secret', browserCookie: 'cookie' }), ConflictError);
    await assert.rejects(service.finish({ attemptId: '11111111-1111-4111-8111-111111111111', finishSecret: '', browserCookie: 'cookie' }), ConflictError);
    await assert.rejects(service.finish({
        attemptId: '11111111-1111-4111-8111-111111111111',
        finishSecret: 'secret',
        browserCookie: undefined,
    }), ConflictError);
});

test('callback validates the provider return before touching durable storage', async () => {
    const service = testService();
    const foreign = new URL('https://evil.example.invalid/api/auth/student/sso/google/callback?state=x');
    await assert.rejects(service.callback({ provider: 'google', callbackUrl: foreign, browserCookies: [] }), ConflictError);
    const missingState = new URL('https://api.example.invalid/api/auth/student/sso/google/callback');
    await assert.rejects(service.callback({ provider: 'google', callbackUrl: missingState, browserCookies: [] }), ConflictError);
});
