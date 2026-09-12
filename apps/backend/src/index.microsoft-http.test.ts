import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { db } from './config/database.js';
import { createApp } from './index.js';

async function mountedServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    const app = await createApp();
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind');
    return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test('mounted app keeps merchant CORS while isolating Microsoft CORS and redacts malformed JSON', async () => {
    const originalQuery = db.query.bind(db);
    (db as unknown as { query: typeof db.query }).query = async (_text, values) => ({ rows: values?.[0] === 'merchant.example' ? [{}] : [], rowCount: values?.[0] === 'merchant.example' ? 1 : 0 }) as never;
    const fixture = await mountedServer();
    const originalLog = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
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

        const hostilePost = await fetch(`${fixture.baseUrl}/api/verification/microsoft/start`, { method: 'POST', headers: { Origin: merchant, 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(hostilePost.status, 400);
        assert.equal(hostilePost.headers.get('access-control-allow-origin'), null);

        const merchantWidget = await fetch(`${fixture.baseUrl}/api/widget/domain-check`, { method: 'OPTIONS', headers: { Origin: frontend, 'Access-Control-Request-Method': 'GET' } });
        assert.equal(merchantWidget.status, 204);
        assert.equal(merchantWidget.headers.get('access-control-allow-origin'), frontend);

        const registeredMerchantWidget = await fetch(`${fixture.baseUrl}/api/widget/domain-check`, { method: 'OPTIONS', headers: { Origin: merchant, 'Access-Control-Request-Method': 'GET' } });
        assert.equal(registeredMerchantWidget.status, 204);
        assert.equal(registeredMerchantWidget.headers.get('access-control-allow-origin'), merchant);
        const unknownWidget = await fetch(`${fixture.baseUrl}/api/widget/domain-check`, { method: 'OPTIONS', headers: { Origin: 'https://unknown.example', 'Access-Control-Request-Method': 'GET' } });
        assert.equal(unknownWidget.headers.get('access-control-allow-origin'), null);

        const malformed = await fetch(`${fixture.baseUrl}/api/verification/microsoft/finish`, { method: 'POST', headers: { Origin: frontend, 'Content-Type': 'application/json' }, body: '{"finishSecret":"MALFORMED_FINISH_SECRET_CANARY"' });
        const body = await malformed.text();
        assert.equal(malformed.status, 400);
        assert.equal(body.includes('MALFORMED_FINISH_SECRET_CANARY'), false);
        assert.equal(captured.join('\n').includes('MALFORMED_FINISH_SECRET_CANARY'), false);
        assert.equal(malformed.headers.get('cache-control'), 'no-store');
        assert.equal(malformed.headers.get('referrer-policy'), 'no-referrer');
    } finally {
        await fixture.close();
        console.log = originalLog;
        (db as unknown as { query: typeof db.query }).query = originalQuery;
    }
});
