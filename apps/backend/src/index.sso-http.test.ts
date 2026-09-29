import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { db } from './config/database.js';
import { config } from './config/env.js';
import { createApp, type AppOptions } from './index.js';

async function mountedServer(options?: AppOptions): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const app = await createApp(options);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind');
    return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test('mounted SSO namespace redacts malformed JSON and fails closed while disabled', async () => {
    // Dynamic widget CORS must not open the real pool: the application pool's
    // error handler exits the process when unit tests would otherwise use it.
    const originalQuery = db.query.bind(db);
    (db as unknown as { query: typeof db.query }).query = (async () => ({ rows: [], rowCount: 0 })) as never;
    const fixture = await mountedServer();
    const originalLog = console.log;
    const originalError = console.error;
    const capturedLogs: string[] = [];
    const capturedErrors: string[] = [];
    console.log = (...args: unknown[]) => { capturedLogs.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { capturedErrors.push(args.map(String).join(' ')); };
    try {
        const malformed = await fetch(`${fixture.baseUrl}/api/auth/student/sso/finish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"finishSecret":"SSO_FINISH_SECRET_CANARY_MUST_NOT_LEAK"',
        });
        const body = await malformed.text();
        assert.equal(malformed.status, 400);
        assert.equal(body.includes('SSO_FINISH_SECRET_CANARY_MUST_NOT_LEAK'), false);
        assert.equal(malformed.headers.get('cache-control'), 'no-store');
        assert.equal(malformed.headers.get('referrer-policy'), 'no-referrer');
        assert.deepEqual(JSON.parse(body), { success: false, error: { code: 'SSO_REQUEST_REJECTED', statusCode: 400 } });

        const disabled = await fetch(`${fixture.baseUrl}/api/auth/student/sso/google/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: 'https://app.example.invalid' },
            body: JSON.stringify({ email: 'ada@students.school.example' }),
        });
        assert.equal(disabled.status, 503);
        assert.deepEqual(await disabled.json(), { success: false, error: { code: 'SSO_REQUEST_REJECTED', statusCode: 503 } });

        assert.equal(capturedLogs.join('\n').includes('SSO_FINISH_SECRET_CANARY_MUST_NOT_LEAK'), false);
        assert.equal(capturedErrors.join('\n').includes('SSO_FINISH_SECRET_CANARY_MUST_NOT_LEAK'), false);
    } finally {
        await fixture.close();
        console.log = originalLog;
        console.error = originalError;
        (db as unknown as { query: typeof db.query }).query = originalQuery;
    }
});

test('mounted SSO callback skips the shared quota and reaches its redirect', async () => {
    const attemptId = '44444444-4444-4444-8444-444444444444';
    const fixture = await mountedServer({
        studentSsoIssuanceEnabled: () => true,
        studentSsoFlowFactory: () => ({
            start: async () => { throw new Error('not used'); },
            finish: async () => { throw new Error('not used'); },
            callbackCookieNameForState: async () => null,
            callback: async () => ({
                attemptId,
                completionUrl: new URL(`https://app.example.invalid/auth/student/sso/complete?attempt=${attemptId}`),
            }),
        }),
    });
    try {
        // A dedicated client address keeps this quota drill isolated from
        // every other test sharing the process-wide limiter stores.
        const quotaHeaders = { 'X-Forwarded-For': '10.99.0.21' };
        for (let warm = 0; warm < 100; warm += 1) {
            const health = await fetch(`${fixture.baseUrl}/health`, { headers: quotaHeaders });
            assert.equal(health.status, 200);
            await health.text();
        }
        const pastQuota = await fetch(`${fixture.baseUrl}/api/auth/student/sso/google/callback?state=fresh-state&code=CANARY`, {
            redirect: 'manual',
            headers: quotaHeaders,
        });
        assert.equal(pastQuota.status, 303);
        assert.equal(pastQuota.headers.get('location'), `https://app.example.invalid/auth/student/sso/complete?attempt=${attemptId}`);
        await pastQuota.text();
    } finally {
        await fixture.close();
    }
});

test('student SSO CORS permits its configured completion origin without opening other origins', async () => {
    const originalQuery = db.query.bind(db);
    const originalCompletionUrl = config.studentSso.completionUrl;
    (db as unknown as { query: typeof db.query }).query = (async () => ({ rows: [], rowCount: 0 })) as never;
    config.studentSso.completionUrl = new URL('https://sso-completion.example.invalid/auth/student/sso/complete');
    const fixture = await mountedServer();
    try {
        const allowed = await fetch(`${fixture.baseUrl}/api/auth/student/sso/reauth/finish`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://sso-completion.example.invalid',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'authorization,content-type',
            },
        });
        assert.equal(allowed.status, 204);
        assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://sso-completion.example.invalid');
        assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');

        const rejected = await fetch(`${fixture.baseUrl}/api/auth/student/sso/reauth/finish`, {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://untrusted.example.invalid',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'authorization,content-type',
            },
        });
        assert.notEqual(rejected.headers.get('access-control-allow-origin'), 'https://untrusted.example.invalid');
        await rejected.text();
    } finally {
        await fixture.close();
        config.studentSso.completionUrl = originalCompletionUrl;
        (db as unknown as { query: typeof db.query }).query = originalQuery;
    }
});

test('mounted SSO errors preserve the existing-account code and redact everything else', async () => {
    const { StudentSsoSignupExistingAccountError } = await import('./services/auth/student-sso-signup.service.js');
    const originalQuery = db.query.bind(db);
    const originalCompletionUrl = config.studentSso.completionUrl;
    const originalSignupEnabled = config.passwordlessStudentSignupEnabled;
    (db as unknown as { query: typeof db.query }).query = (async () => ({ rows: [], rowCount: 0 })) as never;
    config.studentSso.completionUrl = new URL('https://sso-completion.example.invalid/auth/student/sso/complete');
    (config as { passwordlessStudentSignupEnabled: boolean }).passwordlessStudentSignupEnabled = true;
    let mode: 'existing-account' | 'unexpected' = 'existing-account';
    const fixture = await mountedServer({
        studentSsoPool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
        studentSsoSignupFactory: () => ({
            context: async () => { throw new Error('not used'); },
            sendCode: async () => { throw new Error('not used'); },
            verifyCode: async () => { throw new Error('not used'); },
            complete: async () => {
                if (mode === 'existing-account') throw new StudentSsoSignupExistingAccountError();
                throw new Error('SSO_COMPLETE_SECRET_CANARY_MUST_NOT_LEAK');
            },
        }) as never,
    });
    try {
        const complete = () => fetch(`${fixture.baseUrl}/api/auth/student/sso/signup/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: 'https://sso-completion.example.invalid' },
            body: JSON.stringify({
                handoffId: '55555555-5555-4555-8555-555555555555',
                handoffSecret: 'handoff-secret',
                fullName: 'Ada Example',
                ageAttested: true,
                termsAccepted: true,
                termsVersion: '2026-01-01',
                verificationConsent: true,
                noticeVersion: '2026-01-01',
            }),
        });
        const conflict = await complete();
        assert.equal(conflict.status, 409);
        assert.deepEqual(await conflict.json(), { success: false, error: { code: 'SSO_SIGNUP_EXISTING_ACCOUNT', statusCode: 409 } });

        mode = 'unexpected';
        const redacted = await complete();
        const redactedBody = await redacted.text();
        assert.equal(redacted.status, 500);
        assert.deepEqual(JSON.parse(redactedBody), { success: false, error: { code: 'SSO_REQUEST_REJECTED', statusCode: 500 } });
        assert.equal(redactedBody.includes('SSO_COMPLETE_SECRET_CANARY_MUST_NOT_LEAK'), false);
    } finally {
        await fixture.close();
        config.studentSso.completionUrl = originalCompletionUrl;
        (config as { passwordlessStudentSignupEnabled: boolean }).passwordlessStudentSignupEnabled = originalSignupEnabled;
        (db as unknown as { query: typeof db.query }).query = originalQuery;
    }
});
