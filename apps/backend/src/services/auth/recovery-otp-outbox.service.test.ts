import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { challengeSubjectDigest } from '../verification/challenge.service.js';
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

/** A real ciphertext envelope so a job reaches the provider call instead of failing decryption. */
function sealedTestJob() {
    const key = Buffer.from(validKey, 'base64');
    const keyId = `k-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from('awoof:student-email-otp:v1:student_account_recovery:c1', 'utf8'));
    return {
        id: 'j1', challenge_id: 'c1', purpose: 'student_account_recovery', key_id: keyId,
        ciphertext: Buffer.concat([cipher.update('123456', 'utf8'), cipher.final()]),
        nonce, auth_tag: cipher.getAuthTag(), attempts: 0,
    };
}

test('a hung provider delivery times out into retry instead of wedging the batch', async () => {
    const job = sealedTestJob();
    const email = 'student@school.example';
    const queries: string[] = [];
    const client = {
        query: async (text: string) => {
            queries.push(text);
            if (text.includes('FOR UPDATE SKIP LOCKED LIMIT $1')) return { rows: [job], rowCount: 1 };
            if (text.includes("SET status = 'processing', claim_token")) return { rows: [{ attempts: 1 }], rowCount: 1 };
            if (text.includes('JOIN student_auth_recovery_codes r ON')) {
                return { rows: [{ email, otp_subject_digest: challengeSubjectDigest('student_account_recovery', email) }], rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
        },
        release: () => undefined,
    };
    const started = Date.now();
    const result = await dispatchRecoveryOtpOutboxBatch(
        { connect: async () => client } as never,
        validKey,
        // The provider hangs past the timeout, then fails late: the batch
        // must already have moved on, and the late rejection must not
        // surface as an unhandled rejection (which fails this run).
        async () => {
            await new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late provider failure')), 100));
            return { success: true };
        },
        undefined,
        undefined,
        25,
    );
    assert.ok(Date.now() - started < 5000, 'the batch must bound a hung delivery instead of awaiting it');
    assert.equal(result.sent, 0);
    assert.equal(result.retried, 1);
    assert.ok(queries.some((text) => text.includes("SET status = 'pending', next_attempt_at")),
        'a timed-out delivery must release the job for retry');
});

test('a job whose lease lapsed mid-batch is skipped instead of double-sent', async () => {
    const job = sealedTestJob();
    const email = 'student@school.example';
    const queries: string[] = [];
    let deliveries = 0;
    const client = {
        query: async (text: string) => {
            queries.push(text);
            if (text.includes('FOR UPDATE SKIP LOCKED LIMIT $1')) return { rows: [job], rowCount: 1 };
            if (text.includes("SET status = 'processing', claim_token")) return { rows: [{ attempts: 1 }], rowCount: 1 };
            if (text.includes('JOIN student_auth_recovery_codes r ON')) {
                return { rows: [{ email, otp_subject_digest: challengeSubjectDigest('student_account_recovery', email) }], rowCount: 1 };
            }
            // Slow earlier jobs let this lease lapse; another worker
            // reclaimed it, so the renewal compare-and-swap misses.
            if (text.includes('SET lease_until = clock_timestamp()')) return { rows: [], rowCount: 0 };
            return { rows: [], rowCount: 1 };
        },
        release: () => undefined,
    };
    const result = await dispatchRecoveryOtpOutboxBatch(
        { connect: async () => client } as never,
        validKey,
        async () => { deliveries++; return { success: true }; },
    );
    assert.equal(deliveries, 0, 'a reclaimed job must never be sent on the stale claim');
    assert.deepEqual([result.sent, result.retried], [0, 0], 'the new lease holder owns the skipped outcome');
    assert.ok(!queries.some((text) => text.includes("SET status = 'pending', next_attempt_at")
        || text.includes('SET status = $3, ciphertext = NULL')), 'a skipped job must not settle another worker claim');
});
