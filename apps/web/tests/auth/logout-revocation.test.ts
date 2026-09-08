import assert from 'node:assert/strict';
import { test } from 'node:test';
import { revokeLogoutSession } from '../../src/lib/logout-revocation';

test('logout dispatches revocation immediately with captured credentials and unload safety', async () => {
    let resolve!: (value: Response) => void;
    let dispatched = false;
    const request = ((url: string, options: RequestInit) => {
        dispatched = true;
        assert.equal(url, 'https://api.example/api/auth/logout');
        assert.equal(options.keepalive, true);
        assert.equal(options.method, 'POST');
        assert.deepEqual(options.headers, { Authorization: 'Bearer captured-token' });
        assert.ok(options.signal);
        return new Promise<Response>((done) => { resolve = done; });
    }) as typeof fetch;
    const result = revokeLogoutSession('https://api.example/api', 'captured-token', request);
    assert.equal(dispatched, true);
    resolve(new Response(null, { status: 200 }));
    assert.equal(await result, true);
});

test('revocation failure is reported without throwing or accessing a replacement session', async () => {
    const request = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    assert.equal(await revokeLogoutSession('https://api.example/api', 'old-token', request), false);
});
