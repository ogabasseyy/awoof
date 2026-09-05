import assert from 'node:assert/strict';
import test from 'node:test';
import { VerificationFlowRateLimitError } from './verification-flow.service.js';

test('preserves the persisted retry deadline when the controller must emit Retry-After', () => {
    const retryAt = new Date('2026-09-05T12:34:56.000Z');
    const error = new VerificationFlowRateLimitError('Please wait before requesting another verification code.', retryAt);

    assert.equal(error.statusCode, 429);
    assert.equal(error.retryAt.getTime(), retryAt.getTime());
    assert.deepEqual(error.details, { retryAt: '2026-09-05T12:34:56.000Z' });
});
