import assert from 'node:assert/strict';
import test from 'node:test';
import { isMicrosoftRoute } from './microsoft-cors.js';

test('classifies only the Microsoft verification namespace', () => {
    assert.equal(isMicrosoftRoute('/api/verification/microsoft/start'), true);
    assert.equal(isMicrosoftRoute('/api/verification/microsoft'), true);
    assert.equal(isMicrosoftRoute('/API/Verification/Microsoft/START'), true);
    assert.equal(isMicrosoftRoute('/api/verification/Microsoft/consents'), true);
    assert.equal(isMicrosoftRoute('/api/verification/microsoft-extra'), false);
    assert.equal(isMicrosoftRoute('/API/Verification/Microsoft-extra'), false);
    assert.equal(isMicrosoftRoute('/api/widget/config'), false);
});
