import assert from 'node:assert/strict';
import test from 'node:test';
import { hasRecoveryOtpOutboxKey, runRecoveryOtpOutboxDispatcherTick, startRecoveryOtpOutboxDispatcher } from './recovery-otp-outbox.service.js';

const validKey = Buffer.alloc(32, 0x51).toString('base64');

test('recovery OTP outbox accepts only canonical base64 AES-256 keys', () => {
    assert.equal(hasRecoveryOtpOutboxKey(validKey), true);
    assert.equal(hasRecoveryOtpOutboxKey(Buffer.alloc(31, 0x51).toString('base64')), false);
    assert.equal(hasRecoveryOtpOutboxKey(`${validKey} `), false);
    assert.equal(hasRecoveryOtpOutboxKey(null), false);
});

test('outbox worker refuses a malformed previous key before it can strand queued jobs', () => {
    assert.throws(() => startRecoveryOtpOutboxDispatcher({
        pool: { connect: async () => { throw new Error('must not touch database'); } } as never,
        key: validKey,
        previousKey: 'not-a-key',
        deliver: async () => ({ success: true }),
    }), /canonical base64 for 32 bytes/);
});

test('outbox dispatcher emits a fixed payload-free signal for operational failures', async () => {
    const messages: unknown[][] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => { messages.push(values); };
    try {
        await runRecoveryOtpOutboxDispatcherTick({
            pool: { connect: async () => { throw new Error('sensitive OTP/provider payload'); } } as never,
            key: validKey,
            deliver: async () => ({ success: true }),
        });
    } finally {
        console.error = originalError;
    }
    assert.deepEqual(messages, [['Recovery OTP outbox dispatch failed']]);
});
