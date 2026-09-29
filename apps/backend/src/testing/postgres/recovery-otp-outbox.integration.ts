import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { StudentAccountRecoveryService } from '../../services/auth/student-account-recovery.service.js';
import { createTestPool } from './test-database.js';

const configuredRecoveryCodeKey = process.env.AWOOF_TEST_GUARD;
if (!configuredRecoveryCodeKey) throw new Error('The disposable PostgreSQL runner must provide its synthetic recovery-code test key');
const RECOVERY_CODE_KEY: string = configuredRecoveryCodeKey;
const configuredOutboxEncryptionKey = process.env.STUDENT_ACCOUNT_RECOVERY_OTP_ENCRYPTION_KEY;
if (!configuredOutboxEncryptionKey) throw new Error('The disposable PostgreSQL runner must provide its synthetic outbox test key');
const OUTBOX_ENCRYPTION_KEY: string = configuredOutboxEncryptionKey;

async function seedRecoverableStudent(client: PoolClient): Promise<{ userId: string; email: string; code: string }> {
    const suffix = randomUUID().slice(0, 8);
    const email = `outbox-recovery-${suffix}@example.invalid`;
    const user = await client.query<{ id: string }>(
        `INSERT INTO users (email, role, password_setup_requires_recovery_code)
         VALUES ($1, 'student', true) RETURNING id`, [email],
    );
    await client.query("INSERT INTO students (user_id, name, status) VALUES ($1, 'Outbox student', 'active')", [user.rows[0]!.id]);
    const code = `recover-${suffix}`;
    const digest = createHmac('sha256', RECOVERY_CODE_KEY).update(code, 'utf8').digest('base64url');
    await client.query(
        `INSERT INTO student_auth_recovery_codes (user_id, generation, code_digest, status, activated_at)
         VALUES ($1, 1, $2, 'active', clock_timestamp())`, [user.rows[0]!.id, digest],
    );
    return { userId: user.rows[0]!.id, email, code };
}

type OutboxDispatcher = (pool: Pick<Pool, 'connect'>, encryptionKey: string, deliver: (email: string, otp: string) => Promise<{ success: boolean }>, previousEncryptionKey?: string | null, challengeIds?: string[]) => Promise<{ sent: number; retried: number; scrubbed: number }>;

async function dispatch(pool: Pick<Pool, 'connect'>, deliver: (email: string, otp: string) => Promise<{ success: boolean }>, key = OUTBOX_ENCRYPTION_KEY, previousKey?: string, challengeIds?: string[]) {
    // Variable import keeps the expected RED a runtime missing-feature failure,
    // rather than making the test file itself fail TypeScript module resolution.
    const modulePath = '../../services/auth/recovery-otp-outbox.service.js';
    const module = await import(modulePath) as { dispatchRecoveryOtpOutboxBatch: OutboxDispatcher };
    return module.dispatchRecoveryOtpOutboxBatch(pool, key, deliver, previousKey, challengeIds);
}

function recoveryService(pool: Pick<Pool, 'connect'>, deliverOtp?: (email: string, otp: string) => Promise<{ success: boolean }>) {
    return new StudentAccountRecoveryService(Object.assign({
        pool,
        recoveryCodeKey: RECOVERY_CODE_KEY,
        ...(deliverOtp ? { deliverOtp } : {}),
        validatePassword: () => ({ valid: true, errors: [] }),
        hashPassword: async () => 'outbox-recovery-password-hash',
    }, { outboxEncryptionKey: OUTBOX_ENCRYPTION_KEY }));
}

test('recovery outbox retries the same encrypted OTP after an ambiguous send and a worker crash', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        const service = recoveryService(pool);
        const started = await service.start({ email: account.email, purpose: 'lost_access', idempotencyKey: 'durable-retry' });
        const queued = await client.query<{ challenge_id: string; status: string; ciphertext: string | null; nonce: string | null; auth_tag: string | null }>(
            `SELECT job.challenge_id, job.status, job.ciphertext, job.nonce, job.auth_tag
             FROM student_auth_recovery_attempts attempt
             JOIN student_email_otp_outbox job ON job.challenge_id = attempt.mailbox_challenge_id
             WHERE attempt.id = $1`, [started.attemptId],
        );
        assert.equal(queued.rows.length, 1, 'the start transaction must atomically persist its delivery job');
        assert.equal(queued.rows[0]!.status, 'pending');
        assert.ok(queued.rows[0]!.ciphertext && queued.rows[0]!.nonce && queued.rows[0]!.auth_tag,
            'pending jobs must contain only an authenticated-encryption envelope');

        // Model a worker that durably claimed the row and crashed before
        // calling the provider. The expired DB-time lease must be reclaimable.
        await client.query(
            `UPDATE student_email_otp_outbox
             SET status = 'processing', lease_until = clock_timestamp() - interval '1 second', claim_token = $2
             WHERE challenge_id = $1`, [queued.rows[0]!.challenge_id, randomUUID()],
        );

        const attemptedCodes: string[] = [];
        const rotatedKey = Buffer.from(Array.from(Buffer.from(OUTBOX_ENCRYPTION_KEY, 'base64'), (byte) => byte ^ 0x11)).toString('base64');
        const retry = await dispatch(pool, async (_email, otp) => {
            attemptedCodes.push(otp);
            return { success: false }; // ambiguous provider result; retain same code for retry
        }, rotatedKey, OUTBOX_ENCRYPTION_KEY, [queued.rows[0]!.challenge_id]);
        assert.equal(retry.retried, 1);
        assert.match(attemptedCodes[0] ?? '', /^\d{6}$/);
        const afterFailure = await client.query<{ ciphertext: string | null; status: string }>(
            `SELECT ciphertext, status FROM student_email_otp_outbox WHERE challenge_id = $1`,
            [queued.rows[0]!.challenge_id],
        );
        assert.equal(afterFailure.rows[0]!.status, 'pending');
        assert.ok(afterFailure.rows[0]!.ciphertext);
        assert.equal(afterFailure.rows[0]!.ciphertext!.includes(attemptedCodes[0]!), false,
            'the retained retry payload must not contain the plaintext OTP');

        await client.query(
            `UPDATE student_email_otp_outbox SET next_attempt_at = clock_timestamp() - interval '1 second'
             WHERE challenge_id = $1`, [queued.rows[0]!.challenge_id],
        );
        const delivered = await dispatch(pool, async (_email, otp) => {
            attemptedCodes.push(otp);
            return { success: true };
        }, rotatedKey, OUTBOX_ENCRYPTION_KEY, [queued.rows[0]!.challenge_id]);
        assert.equal(delivered.sent, 1);
        assert.equal(attemptedCodes.length, 2);
        assert.equal(attemptedCodes[1], attemptedCodes[0], 'at-least-once retry must preserve the original OTP');
        const terminal = await client.query<{ ciphertext: string | null; status: string }>(
            `SELECT ciphertext, status FROM student_email_otp_outbox WHERE challenge_id = $1`,
            [queued.rows[0]!.challenge_id],
        );
        assert.deepEqual(terminal.rows[0], { ciphertext: null, status: 'sent' },
            'successful send must immediately scrub the encrypted OTP payload');

        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp: attemptedCodes[1]! });
    } finally {
        client.release();
        await pool.end();
    }
});

test('migration 084 worker still decrypts a queued recovery envelope written with migration 083 AAD', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        const service = recoveryService(pool);
        const started = await service.start({ email: account.email, purpose: 'lost_access', idempotencyKey: 'legacy-083-envelope' });
        const attempt = await client.query<{ challenge_id: string }>(
            'SELECT mailbox_challenge_id AS challenge_id FROM student_auth_recovery_attempts WHERE id = $1', [started.attemptId],
        );
        const challengeId = attempt.rows[0]?.challenge_id;
        if (!challengeId) throw new Error('Expected a real recovery challenge');
        const legacyOtp = '123456';
        const keyBytes = Buffer.from(OUTBOX_ENCRYPTION_KEY, 'base64');
        const keyId = `k-${createHash('sha256').update(keyBytes).digest('hex').slice(0, 12)}`;
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', keyBytes, nonce, { authTagLength: 16 });
        cipher.setAAD(Buffer.from(`awoof:student-account-recovery-otp:v1:${challengeId}`, 'utf8'));
        const ciphertext = Buffer.concat([cipher.update(legacyOtp, 'utf8'), cipher.final()]);
        await client.query(
            `UPDATE student_email_otp_outbox
             SET key_id = $2, ciphertext = $3, nonce = $4, auth_tag = $5, status = 'pending',
                 next_attempt_at = clock_timestamp() - interval '1 second', terminal_at = NULL, sent_at = NULL,
                 lease_until = NULL, claim_token = NULL
             WHERE challenge_id = $1`,
            [challengeId, keyId, ciphertext, nonce, cipher.getAuthTag()],
        );
        const delivered: string[] = [];
        const result = await dispatch(pool, async (_email, otp) => { delivered.push(otp); return { success: true }; }, OUTBOX_ENCRYPTION_KEY, undefined, [challengeId]);
        assert.equal(result.sent, 1);
        assert.deepEqual(delivered, [legacyOtp], 'legacy ciphertext is opened only in the recovery purpose context');
    } finally {
        client.release();
        await pool.end();
    }
});

test('recovery outbox will not send after its attempt is terminalized', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        const service = recoveryService(pool);
        const started = await service.start({ email: account.email, purpose: 'lost_access', idempotencyKey: 'terminal-retry' });
        const challenge = await client.query<{ challenge_id: string }>(
            'SELECT mailbox_challenge_id AS challenge_id FROM student_auth_recovery_attempts WHERE id = $1', [started.attemptId],
        );
        await client.query(
            `UPDATE student_auth_recovery_attempts SET status = 'failed', secret_hash = NULL WHERE id = $1`, [started.attemptId],
        );
        let delivered = 0;
        const result = await dispatch(pool, async () => { delivered++; return { success: true }; }, OUTBOX_ENCRYPTION_KEY, undefined, [challenge.rows[0]!.challenge_id]);
        assert.equal(result.scrubbed, 1);
        assert.equal(delivered, 0, 'terminal attempt must be checked again immediately before sending');
        const job = await client.query<{ ciphertext: string | null; status: string }>(
            'SELECT ciphertext, status FROM student_email_otp_outbox WHERE challenge_id = $1', [challenge.rows[0]!.challenge_id],
        );
        assert.deepEqual(job.rows[0], { ciphertext: null, status: 'cancelled' });
    } finally {
        client.release();
        await pool.end();
    }
});

test('recovery outbox claim prevents two workers from concurrently sending the same row', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        const service = recoveryService(pool);
        const started = await service.start({ email: account.email, purpose: 'lost_access', idempotencyKey: 'concurrent-claim' });
        const challenge = await client.query<{ challenge_id: string }>(
            'SELECT mailbox_challenge_id AS challenge_id FROM student_auth_recovery_attempts WHERE id = $1', [started.attemptId],
        );
        let releaseSend!: () => void;
        let startedSend!: () => void;
        const sendEntered = new Promise<void>((resolve) => { startedSend = resolve; });
        const holdSend = new Promise<void>((resolve) => { releaseSend = resolve; });
        let sends = 0;
        const first = dispatch(pool, async () => {
            sends++;
            startedSend();
            await holdSend;
            return { success: true };
        }, OUTBOX_ENCRYPTION_KEY, undefined, [challenge.rows[0]!.challenge_id]);
        await sendEntered;
        const second = await dispatch(pool, async () => { sends++; return { success: true }; }, OUTBOX_ENCRYPTION_KEY, undefined, [challenge.rows[0]!.challenge_id]);
        assert.equal(second.sent, 0);
        assert.equal(sends, 1, 'a live DB lease must exclude another dispatcher');
        releaseSend();
        assert.equal((await first).sent, 1);
        const attempt = await client.query<{ status: string }>('SELECT status FROM student_auth_recovery_attempts WHERE id = $1', [started.attemptId]);
        assert.equal(attempt.rows[0]!.status, 'pending');
    } finally {
        client.release();
        await pool.end();
    }
});

test('expired recovery outbox jobs are scrubbed without delivery', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        const service = recoveryService(pool);
        const started = await service.start({ email: account.email, purpose: 'lost_access', idempotencyKey: 'expired-job' });
        const challenge = await client.query<{ challenge_id: string }>(
            'SELECT mailbox_challenge_id AS challenge_id FROM student_auth_recovery_attempts WHERE id = $1', [started.attemptId],
        );
        await client.query(
            `UPDATE student_email_otp_outbox
             SET created_at = clock_timestamp() - interval '3 seconds', expires_at = clock_timestamp() - interval '1 second'
             WHERE challenge_id = $1`, [challenge.rows[0]!.challenge_id],
        );
        let sends = 0;
        const result = await dispatch(pool, async () => { sends++; return { success: true }; }, OUTBOX_ENCRYPTION_KEY, undefined, [challenge.rows[0]!.challenge_id]);
        assert.equal(result.scrubbed, 1);
        assert.equal(sends, 0);
        const row = await client.query<{ status: string; ciphertext: Buffer | null }>(
            'SELECT status, ciphertext FROM student_email_otp_outbox WHERE challenge_id = $1', [challenge.rows[0]!.challenge_id],
        );
        assert.equal(row.rows[0]!.status, 'expired');
        assert.equal(row.rows[0]!.ciphertext, null);
    } finally {
        client.release();
        await pool.end();
    }
});
