import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { db } from './config/database.js';
import { createApp, type AppOptions } from './index.js';
import { BadRequestError } from './common/errors/AppError.js';

async function mountedServer(options?: AppOptions): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const app = await createApp(options);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind');
    return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test('mounted Microsoft callback redirects only a bound terminal provider failure and never finishes it', async () => {
    const attemptId = '11111111-1111-4111-8111-111111111111';
    const callbackCookie = `awoof_ms_${attemptId}`;
    let finishCalls = 0;
    const fixture = await mountedServer({
        microsoftIssuanceEnabled: () => true,
        microsoftFlowFactory: () => ({
            start: async () => { throw new Error('not used'); },
            finish: async () => { finishCalls += 1; throw new Error('not used'); },
            callbackCookieNameForState: async (callbackUrl) => callbackUrl.searchParams.get('state') === 'bound-state' ? callbackCookie : null,
            callback: async ({ callbackUrl, browserCookies }) => {
                const browserCookie = browserCookies?.find((cookie) => cookie.name === callbackCookie)?.value;
                if (callbackUrl.searchParams.get('state') !== 'bound-state' || browserCookie !== 'bound-browser-secret') {
                    throw new BadRequestError('Microsoft verification attempt is no longer valid');
                }
                return {
                    attemptId,
                    completionUrl: new URL(`https://app.awoof.example/student/verification/microsoft/complete?attempt=${attemptId}&outcome=connection_not_completed`),
                    outcome: 'connection_not_completed' as const,
                };
            },
        }),
    });
    try {
        const bound = await fetch(`${fixture.baseUrl}/api/verification/microsoft/callback?state=bound-state&error=access_denied&error_description=provider-text-must-not-leak`, {
            redirect: 'manual', headers: { Cookie: `${callbackCookie}=bound-browser-secret` },
        });
        assert.equal(bound.status, 303);
        assert.equal(bound.headers.get('location'), `https://app.awoof.example/student/verification/microsoft/complete?attempt=${attemptId}&outcome=connection_not_completed`);
        assert.equal(bound.headers.get('location')?.includes('access_denied'), false);
        assert.equal(bound.headers.get('location')?.includes('provider-text'), false);
        assert.match(bound.headers.get('set-cookie') ?? '', new RegExp(`${callbackCookie}=;`));
        assert.equal(finishCalls, 0);

        const unbound = await fetch(`${fixture.baseUrl}/api/verification/microsoft/callback?state=random-state&error=access_denied`, {
            redirect: 'manual', headers: { Cookie: `${callbackCookie}=bound-browser-secret` },
        });
        assert.equal(unbound.status, 400);
        assert.equal(unbound.headers.get('location'), null);
        assert.equal(unbound.headers.get('set-cookie'), null);
        assert.equal(finishCalls, 0);
    } finally {
        await fixture.close();
    }
});

test('mounted app keeps merchant CORS while isolating Microsoft CORS and redacts malformed JSON', async () => {
    const originalQuery = db.query.bind(db);
    (db as unknown as { query: typeof db.query }).query = async (_text, values) => ({ rows: values?.[0] === 'merchant.example' ? [{}] : [], rowCount: values?.[0] === 'merchant.example' ? 1 : 0 }) as never;
    const fixture = await mountedServer();
    const originalLog = console.log;
    const originalError = console.error;
    const capturedLogs: string[] = [];
    const capturedErrors: string[] = [];
    console.log = (...args: unknown[]) => { capturedLogs.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { capturedErrors.push(args.map(String).join(' ')); };
    try {
        const frontend = 'http://localhost:3000';
        const microsoftPreflight = await fetch(`${fixture.baseUrl}/api/verification/microsoft/start`, { method: 'OPTIONS', headers: { Origin: frontend, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } });
        assert.equal(microsoftPreflight.status, 204);
        assert.equal(microsoftPreflight.headers.get('access-control-allow-origin'), frontend);
        assert.equal(microsoftPreflight.headers.get('access-control-allow-credentials'), 'true');
        assert.match(microsoftPreflight.headers.get('vary') ?? '', /Origin/i);

        const merchant = 'https://merchant.example';
        const hostileMicrosoft = await fetch(`${fixture.baseUrl}/api/verification/microsoft/start`, { method: 'OPTIONS', headers: { Origin: merchant, 'Access-Control-Request-Method': 'POST' } });
        assert.equal(hostileMicrosoft.status, 403);
        assert.equal(hostileMicrosoft.headers.get('access-control-allow-origin'), null);

        const mixedCasePreflight = await fetch(`${fixture.baseUrl}/API/Verification/Microsoft/START`, { method: 'OPTIONS', headers: { Origin: merchant, 'Access-Control-Request-Method': 'POST' } });
        assert.equal(mixedCasePreflight.status, 403);
        assert.equal(mixedCasePreflight.headers.get('access-control-allow-origin'), null);

        const mixedCaseOwnerRead = await fetch(`${fixture.baseUrl}/api/verification/Microsoft/consents`, { headers: { Origin: merchant, Authorization: 'Bearer malformed-owner-token' } });
        assert.equal(mixedCaseOwnerRead.headers.get('access-control-allow-origin'), null);

        const hostilePost = await fetch(`${fixture.baseUrl}/api/verification/microsoft/start`, { method: 'POST', headers: { Origin: merchant, 'Content-Type': 'application/json' }, body: '{}' });
        const hostilePostBody = await hostilePost.json() as { error: { code: string; message?: string } };
        assert.equal(hostilePost.status, 400);
        assert.equal(hostilePost.headers.get('access-control-allow-origin'), null);
        // The originating BadRequestError has code BAD_REQUEST and a detailed
        // message; neither may be exposed from the Microsoft namespace.
        assert.equal(hostilePostBody.error.code, 'MICROSOFT_REQUEST_REJECTED');
        assert.equal(hostilePostBody.error.message, undefined);

        const merchantWidget = await fetch(`${fixture.baseUrl}/api/widget/domain-check`, { method: 'OPTIONS', headers: { Origin: frontend, 'Access-Control-Request-Method': 'GET' } });
        assert.equal(merchantWidget.status, 204);
        assert.equal(merchantWidget.headers.get('access-control-allow-origin'), frontend);

        const registeredMerchantWidget = await fetch(`${fixture.baseUrl}/api/widget/domain-check`, { method: 'OPTIONS', headers: { Origin: merchant, 'Access-Control-Request-Method': 'GET' } });
        assert.equal(registeredMerchantWidget.status, 204);
        assert.equal(registeredMerchantWidget.headers.get('access-control-allow-origin'), merchant);
        const unknownWidget = await fetch(`${fixture.baseUrl}/api/widget/domain-check`, { method: 'OPTIONS', headers: { Origin: 'https://unknown.example', 'Access-Control-Request-Method': 'GET' } });
        assert.equal(unknownWidget.headers.get('access-control-allow-origin'), null);

        for (const path of ['/API/Verification/Microsoft/START', '/API/Verification/Microsoft/FINISH']) {
            const malformed = await fetch(`${fixture.baseUrl}${path}`, { method: 'POST', headers: { Origin: frontend, 'Content-Type': 'application/json' }, body: '{"finishSecret":"MALFORMED_FINISH_SECRET_CANARY"' });
            const body = await malformed.text();
            assert.equal(malformed.status, 400);
            assert.equal(body.includes('MALFORMED_FINISH_SECRET_CANARY'), false);
            assert.equal(malformed.headers.get('cache-control'), 'no-store');
            assert.equal(malformed.headers.get('referrer-policy'), 'no-referrer');
        }
        assert.equal(capturedLogs.join('\n').includes('MALFORMED_FINISH_SECRET_CANARY'), false);
        assert.equal(capturedErrors.join('\n').includes('MALFORMED_FINISH_SECRET_CANARY'), false);
    } finally {
        await fixture.close();
        console.log = originalLog;
        console.error = originalError;
        (db as unknown as { query: typeof db.query }).query = originalQuery;
    }
});
