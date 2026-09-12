import assert from 'node:assert/strict';
import test from 'node:test';
import { readMicrosoftOidcConfiguration } from './microsoft-oidc.config.js';

const base = {
    enabled: true,
    tenantId: '11111111-1111-4111-8111-111111111111',
    clientId: '22222222-2222-4222-8222-222222222222',
    clientSecret: 'not-a-real-secret',
    callbackUrl: 'https://api.awoof.example/api/verification/microsoft/callback',
    frontendCompletionUrl: 'https://app.awoof.example/student/verification/microsoft/complete',
};

test('Microsoft OIDC is off unless explicitly enabled', () => {
    assert.deepEqual(readMicrosoftOidcConfiguration({}), { enabled: false });
    assert.deepEqual(readMicrosoftOidcConfiguration({ enabled: 'false' }), { enabled: false });
});

test('enabled Microsoft OIDC requires a fixed callback, UUID tenant, and same-site HTTPS pair', () => {
    assert.equal(readMicrosoftOidcConfiguration(base).enabled, true);
    assert.throws(() => readMicrosoftOidcConfiguration({ ...base, tenantId: 'not-a-tenant' }));
    assert.throws(() => readMicrosoftOidcConfiguration({ ...base, callbackUrl: 'https://api.awoof.example/other' }));
    assert.throws(() => readMicrosoftOidcConfiguration({ ...base, frontendCompletionUrl: 'https://awoof.invalid/student' }));
    assert.throws(() => readMicrosoftOidcConfiguration({ ...base, callbackUrl: 'http://localhost:5000/api/verification/microsoft/callback' }));
    assert.throws(() => readMicrosoftOidcConfiguration({ ...base, frontendCompletionUrl: 'https://app.awoof.example/student/verification/microsoft' }));
    assert.throws(() => readMicrosoftOidcConfiguration({ ...base, callbackUrl: 'https://alice.github.io/api/verification/microsoft/callback', frontendCompletionUrl: 'https://bob.github.io/student/verification/microsoft/complete' }));
});
