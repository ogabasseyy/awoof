import assert from 'node:assert/strict';
import test from 'node:test';
import { isMicrosoftVerificationRequest } from '../../src/lib/api-client';

const baseURL = 'http://localhost:5001/api';

test('credentialed Microsoft client permits only its normalized API namespace', () => {
    assert.equal(isMicrosoftVerificationRequest({ baseURL, url: '/verification/microsoft/start' }), true);
    assert.equal(isMicrosoftVerificationRequest({ baseURL, url: '/verification/microsoft-extra' }), false);
    assert.equal(isMicrosoftVerificationRequest({ baseURL, url: '/verification/microsoft/../auth/logout' }), false);
    assert.equal(isMicrosoftVerificationRequest({ baseURL, url: 'https://attacker.invalid/api/verification/microsoft/start' }), false);
    assert.equal(isMicrosoftVerificationRequest({ baseURL, url: '//attacker.invalid/verification/microsoft/start' }), false);
    assert.equal(isMicrosoftVerificationRequest({ baseURL: 'https://attacker.invalid/api', url: '/verification/microsoft/start' }), false);
});
