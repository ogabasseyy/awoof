import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchRecoveryOtpOutboxBatch, hasRecoveryOtpOutboxKey, runRecoveryOtpOutboxDispatcherTick, startRecoveryOtpOutboxDispatcher } from './recovery-otp-outbox.service.js';

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

async function runExhaustedSettle(settleRowCount: number): Promise<{ queries: string[]; deliveries: number; scrubbed: number }> {
    const queries: string[] = [];
    let deliveries = 0;
    const job = {
        id: 'j1', challenge_id: 'c1', purpose: 'student_account_recovery', key_id: 'k',
        ciphertext: Buffer.alloc(16), nonce: Buffer.alloc(12), auth_tag: Buffer.alloc(16), attempts: 8,
    };
    const client = {
        query: async (text: string) => {
            queries.push(text);
            if (text.includes('FOR UPDATE SKIP LOCKED LIMIT $1')) return { rows: [job], rowCount: 1 };
            if (text.includes("SET status = 'processing', claim_token")) return { rows: [{ attempts: 9 }], rowCount: 1 };
            if (text.includes('JOIN student_auth_recovery_codes r ON')) return { rows: [{ email: 'e@x.invalid' }], rowCount: 1 };
            if (text.includes('SET status = $3, ciphertext = NULL')) return { rows: [], rowCount: settleRowCount };
            return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
    };
    const result = await dispatchRecoveryOtpOutboxBatch(
        { connect: async () => client } as never,
        validKey,
        async () => { deliveries++; return { success: true }; },
    );
    return { queries, deliveries, scrubbed: result.scrubbed };
}

test('exhausted outbox settle skips terminalization when its lease was reclaimed', async () => {
    // attempts 9 > MAX 8 settles failed without delivering; the zero-row
    // compare-and-swap means another worker reclaimed the lease after it
    // lapsed. The stale holder must not burn the attempt and challenge
    // the new claimant is about to deliver.
    const { queries, deliveries, scrubbed } = await runExhaustedSettle(0);
    assert.equal(deliveries, 0, 'exhausted jobs settle without a delivery call');
    assert.equal(scrubbed, 1);
    assert.ok(!queries.some((text) => text.includes("SET status = 'failed', secret_hash = NULL")),
        'a reclaimed lease must not fail the live attempt');
    assert.ok(!queries.some((text) => text.includes('SET superseded_at = clock_timestamp()')),
        'a reclaimed lease must not supersede the live challenge');
});

test('exhausted outbox settle terminalizes while it still holds the lease', async () => {
    const { queries, scrubbed } = await runExhaustedSettle(1);
    assert.equal(scrubbed, 1);
    assert.ok(queries.some((text) => text.includes("SET status = 'failed', secret_hash = NULL")),
        'the lease holder must fail the exhausted attempt');
    assert.ok(queries.some((text) => text.includes('SET superseded_at = clock_timestamp()')),
        'the lease holder must supersede the exhausted challenge');
});
