import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { db } from './config/database.js';
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
