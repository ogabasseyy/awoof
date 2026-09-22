import assert from 'node:assert/strict';
import test from 'node:test';
import { requireMicrosoftSession } from './microsoft-session.js';

test('scoped Microsoft auth maps an invalid signed token to 401 rather than an operational error', async () => {
    const middleware = requireMicrosoftSession();
    let received: unknown;
    await middleware(
        { headers: { authorization: 'Bearer malformed' } } as never,
        {} as never,
        (error?: unknown) => { received = error; },
    );
    assert.equal((received as { statusCode?: number }).statusCode, 401);
});
