import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { issueActionGrant } from '../../services/auth/student-action-grant.service.js';
import { StudentReauthService } from '../../services/auth/student-reauth.service.js';
import { StudentRecoveryCodeService } from '../../services/auth/student-recovery-code.service.js';
import { StudentAccountRecoveryService } from '../../services/auth/student-account-recovery.service.js';
import { challengeSubjectDigest } from '../../services/verification/challenge.service.js';
import { createTestPool } from './test-database.js';

const SID = '22222222-2222-4222-8222-222222222222';

type RecoveryStatusResult = Awaited<ReturnType<StudentRecoveryCodeService['status']>>;

function assertRecoveryStatus(actual: RecoveryStatusResult, expected: { status: string; generation: number | null; pendingCodeId: string | null; pendingExpiresAt: string | null }, message?: string): void {
    assert.ok(Number.isFinite(Date.parse(actual.serverNow)), 'status must report the server clock for client skew correction');
    assert.deepEqual(
        { status: actual.status, generation: actual.generation, pendingCodeId: actual.pendingCodeId, pendingExpiresAt: actual.pendingExpiresAt },
        expected, message,
    );
}

async function seedStudent(client: PoolClient, sid = SID): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const user = await client.query<{ id: string }>(
        `INSERT INTO users (email, role, active_session_id)
         VALUES ($1, 'student', $2::uuid) RETURNING id`,
        [`recovery-${suffix}@example.invalid`, sid],
    );
    // Real student accounts always carry a profile; recovery-code
    // consumption rechecks its active status at the action commit.
    await client.query(`INSERT INTO students (user_id, name, status) VALUES ($1, 'Recovery student', 'active')`, [user.rows[0]!.id]);
    return user.rows[0]!.id;
}

async function seedRecoverableStudent(client: PoolClient): Promise<{ userId: string; email: string; code: string }> {
    const suffix = randomUUID().slice(0, 8);
    const email = `independent-recovery-${suffix}@example.invalid`;
    const user = await client.query<{ id: string }>(
        `INSERT INTO users (email, role, password_setup_requires_recovery_code)
         VALUES ($1, 'student', true) RETURNING id`, [email],
    );
    await client.query(`INSERT INTO students (user_id, name, status) VALUES ($1, 'Recovery student', 'active')`, [user.rows[0]!.id]);
    const code = `recover-${suffix}`;
    const digest = createHmac('sha256', 'test-recovery-code-key').update(code, 'utf8').digest('base64url');
    await client.query(
        `INSERT INTO student_auth_recovery_codes (user_id, generation, code_digest, status, activated_at)
         VALUES ($1, 1, $2, 'active', clock_timestamp())`, [user.rows[0]!.id, digest],
    );
    return { userId: user.rows[0]!.id, email, code };
}

test('independent lost-access recovery consumes the active code, requires normal login, and preserves external identity', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        const identityId = await seedProviderProof(client, account.userId);
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'recovered-password-hash',
        });
        const started = await service.start({ email: account.email, purpose: 'lost_access' });
        assert.match(otp, /^\d{6}$/);
        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        await service.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' });

        const transientSecrets = await client.query<{ attempt_secret: string | null; otp_digest: string }>(
            `SELECT attempt.secret_hash AS attempt_secret, otp.secret_digest AS otp_digest
             FROM student_auth_recovery_attempts attempt
             JOIN verification_challenges otp ON otp.id = attempt.mailbox_challenge_id
             WHERE attempt.id = $1`,
            [started.attemptId],
        );
        assert.deepEqual(transientSecrets.rows[0], { attempt_secret: null, otp_digest: '0'.repeat(64) },
            'successful recovery immediately scrubs its attempt and mailbox-OTP digests');

        const after = await client.query<{ password_hash: string; recovery_reenrollment_requires_password: boolean; credential_generation: string; active_session_id: string | null }>(
            'SELECT password_hash, recovery_reenrollment_requires_password, credential_generation, active_session_id FROM users WHERE id = $1', [account.userId],
        );
        assert.equal(after.rows[0]!.password_hash, 'recovered-password-hash');
        assert.equal(after.rows[0]!.recovery_reenrollment_requires_password, true);
        assert.equal(after.rows[0]!.credential_generation, '1');
        assert.equal(after.rows[0]!.active_session_id, null, 'recovery must not issue a session');
        const code = await client.query<{ status: string; code_digest: string | null }>('SELECT status, code_digest FROM student_auth_recovery_codes WHERE user_id = $1', [account.userId]);
        assert.deepEqual(code.rows[0], { status: 'consumed', code_digest: null });
        const identity = await client.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM student_auth_identities WHERE id = $1', [identityId]);
        assert.equal(identity.rows[0]!.revoked_at, null);
    } finally {
        client.release();
        await pool.end();
    }
});

test('suspension after verification blocks recovery completion without consuming the code', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'recovered-password-hash',
        });
        const started = await service.start({ email: account.email, purpose: 'lost_access' });
        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        // Suspend after both proofs verified: completion rechecks the
        // locked student row instead of replacing the password.
        await client.query("UPDATE students SET status = 'suspended' WHERE user_id = $1", [account.userId]);
        await assert.rejects(
            () => service.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' }),
            /not available/i,
            'a suspension for suspected compromise must not still mint a usable credential',
        );
        const after = await client.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [account.userId]);
        assert.equal(after.rows[0]!.password_hash, null);
        const code = await client.query<{ status: string }>('SELECT status FROM student_auth_recovery_codes WHERE user_id = $1', [account.userId]);
        assert.equal(code.rows[0]!.status, 'active');
    } finally {
        client.release();
        await pool.end();
    }
});

test('unknown-mailbox recovery handles expire exactly like committed ones', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        const deliveries: string[] = [];
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (email, _otp) => { deliveries.push(email); return { success: true }; },
        });
        const unknown = `unknown-${randomUUID().slice(0, 8)}@example.invalid`;
        const decoy = await service.start({ email: unknown, purpose: 'lost_access' });
        const committed = await service.start({ email: account.email, purpose: 'compromise' });
        const decoyMs = Date.parse(decoy.expiresAt);
        const committedMs = Date.parse(committed.expiresAt);
        assert.ok(Number.isFinite(decoyMs) && Number.isFinite(committedMs));
        const decoyNow = Date.parse(decoy.serverNow);
        const committedNow = Date.parse(committed.serverNow);
        assert.ok(Number.isFinite(decoyNow) && Number.isFinite(committedNow), 'both handles report the server clock for skew correction');
        // Both derive from the same server clock plus the shared
        // ten-minute attempt window: neither clock skew nor the shorter
        // OTP window underneath may mark a real attempt.
        assert.ok(Math.abs(decoyMs - committedMs) < 30_000, `decoy and committed expiries must be indistinguishable (delta ${Math.abs(decoyMs - committedMs)}ms)`);
        assert.ok(Math.abs(decoyNow - committedNow) < 30_000, 'decoy and committed server clocks must be indistinguishable');
        for (const ms of [decoyMs, committedMs]) {
            const ttlMs = ms - Date.now();
            assert.ok(ttlMs > 9 * 60 * 1000 && ttlMs <= 11 * 60 * 1000, `expiry must sit on the shared ten-minute attempt window (saw ${Math.round(ttlMs / 1000)}s)`);
        }
        // Both deadlines derive from the same captured timestamp: any
        // statement-latency skew between serverNow and expiresAt would
        // let expiresAt - serverNow fingerprint committed handles.
        assert.equal(decoyMs - decoyNow, 10 * 60 * 1000, 'decoy deadline must be exactly serverNow plus ten minutes');
        assert.equal(committedMs - committedNow, 10 * 60 * 1000, 'committed deadline must be exactly serverNow plus ten minutes');
        // Fresh handles also report the shorter OTP deadline the
        // pre-verification view counts down, on both paths alike.
        const committedOtp = await client.query<{ expires_at: Date }>(
            `SELECT challenge.expires_at FROM verification_challenges challenge
             JOIN student_auth_recovery_attempts attempt ON attempt.mailbox_challenge_id = challenge.id
             WHERE attempt.id = $1`,
            [committed.attemptId],
        );
        assert.equal(committed.otpExpiresAt, committedOtp.rows[0]!.expires_at.toISOString());
        assert.ok(committedMs - Date.parse(committed.otpExpiresAt) > 4 * 60 * 1000, 'the OTP deadline must sit well inside the attempt window');
        const decoyOtp = await client.query<{ expires_at: Date }>(
            `SELECT challenge.expires_at FROM verification_challenges challenge
             JOIN verification_challenge_budgets budget ON budget.current_challenge_id = challenge.id
             WHERE budget.purpose = 'student_account_recovery' AND budget.subject_digest = $1`,
            [challengeSubjectDigest('student_account_recovery', unknown)],
        );
        assert.equal(decoy.otpExpiresAt, decoyOtp.rows[0]!.expires_at.toISOString(), 'decoy handles report their challenge OTP deadline too');
        assert.deepEqual(deliveries, [account.email]);
        const decoyRows = await client.query('SELECT id FROM student_auth_recovery_attempts WHERE id = $1', [decoy.attemptId]);
        assert.equal(decoyRows.rowCount, 0, 'decoy handles write no attempt rows');
    } finally {
        client.release();
        await pool.end();
    }
});

test('a lost start response retries onto a rebound handle without a second OTP', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        const deliveries: string[] = [];
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { deliveries.push(delivered); return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'rebound-password-hash',
        });
        const key = randomUUID();
        const first = await service.start({ email: account.email, purpose: 'lost_access', idempotencyKey: key });
        // The 202 never arrived, so the browser retries immediately with
        // the original binding: the cooldown path rebounds onto the live
        // attempt instead of stranding the delivered OTP behind a decoy.
        const second = await service.start({ email: account.email, purpose: 'lost_access', idempotencyKey: key });
        assert.notEqual(second.attemptId, first.attemptId);
        assert.equal(second.expiresAt, second.otpExpiresAt, 'pre-proof response preserves the non-enumerating frozen deadline');
        assert.equal(deliveries.length, 1, 'the original OTP is reused, never re-sent');
        const verified = await service.verify({ attemptId: second.attemptId, secret: second.secret, code: account.code, otp: deliveries[0]! });
        assert.ok(Date.parse(verified.expiresAt) - Date.parse(second.expiresAt) > 4 * 60_000,
            'after both proofs succeed, disclose the rebound attempt deadline so password completion is usable');
        const rows = await client.query<{ id: string; status: string; idempotency_key: string | null }>(
            'SELECT id, status, idempotency_key FROM student_auth_recovery_attempts WHERE user_id = $1 ORDER BY created_at', [account.userId],
        );
        assert.deepEqual(rows.rows.map((row) => row.status), ['failed', 'verified']);
        assert.deepEqual(rows.rows.map((row) => row.idempotency_key), [null, null], 'only pending attempts retain the cooldown retry binding');
        await service.complete({ attemptId: second.attemptId, secret: second.secret, password: 'ValidNew1!' });
    } finally {
        client.release();
        await pool.end();
    }
});

test('cooldown retries without the original binding leave the live attempt usable', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        const deliveries: string[] = [];
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { deliveries.push(delivered); return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'binding-password-hash',
        });
        const key = randomUUID();
        const first = await service.start({ email: account.email, purpose: 'lost_access', idempotencyKey: key });
        const liveChallenge = await client.query<{ expires_at: Date }>(
            `SELECT challenge.expires_at FROM verification_challenges challenge
             JOIN student_auth_recovery_attempts attempt ON attempt.mailbox_challenge_id = challenge.id
             WHERE attempt.id = $1`,
            [first.attemptId],
        );
        // An anonymous caller repeating the start with no key — or the
        // wrong one — takes the frozen-expiry path: no new attempt row,
        // no OTP re-sent, and the victim handle still verifies.
        for (const retry of [
            await service.start({ email: account.email, purpose: 'lost_access' }),
            await service.start({ email: account.email, purpose: 'lost_access', idempotencyKey: randomUUID() }),
        ]) {
            assert.equal(retry.expiresAt, liveChallenge.rows[0]!.expires_at.toISOString(), 'unbound retries must replay the frozen challenge expiry');
            await assert.rejects(() => service.verify({ attemptId: retry.attemptId, secret: retry.secret, code: account.code, otp: deliveries[0]! }));
        }
        assert.equal(deliveries.length, 1);
        const rows = await client.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM student_auth_recovery_attempts WHERE user_id = $1', [account.userId],
        );
        assert.equal(rows.rows[0]!.count, '1', 'unbound retries must not replace the live attempt');
        // The bound retry still rebounds afterwards against the same
        // delivered OTP: the attack attempts disturbed nothing.
        const rebound = await service.start({ email: account.email, purpose: 'lost_access', idempotencyKey: key });
        assert.notEqual(rebound.attemptId, first.attemptId);
        await service.verify({ attemptId: rebound.attemptId, secret: rebound.secret, code: account.code, otp: deliveries[0]! });
        const after = await client.query<{ status: string }>(
            'SELECT status FROM student_auth_recovery_attempts WHERE user_id = $1 ORDER BY created_at', [account.userId],
        );
        assert.deepEqual(after.rows.map((row) => row.status), ['failed', 'verified']);
    } finally {
        client.release();
        await pool.end();
    }
});

test('cooldown retries without a live attempt return frozen expiries on both paths', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async () => ({ success: true }),
        });
        const before = await client.query<{ budgets: string; challenges: string }>(
            'SELECT (SELECT count(*)::text FROM verification_challenge_budgets) AS budgets, (SELECT count(*)::text FROM verification_challenges) AS challenges',
        );
        // Unknown addresses issue a budget-bounded challenge so retry
        // deadlines stay stable: exactly one budget row and one challenge
        // row, never an attempt row, and the retry replays the frozen
        // expiry instead of minting a fresh deadline oracle.
        const unknown = `unknown-${randomUUID().slice(0, 8)}@example.invalid`;
        const decoy = await service.start({ email: unknown, purpose: 'lost_access' });
        const decoyRetry = await service.start({ email: unknown, purpose: 'lost_access' });
        // Fresh handles report the ten-minute attempt expiry; cooldown
        // retries report the frozen challenge expiry — identically on
        // the decoy and committed paths.
        const decoyChallenge = await client.query<{ expires_at: Date }>(
            `SELECT challenge.expires_at FROM verification_challenges challenge
             JOIN verification_challenge_budgets budget ON budget.current_challenge_id = challenge.id
             WHERE budget.purpose = 'student_account_recovery' AND budget.subject_digest = $1`,
            [challengeSubjectDigest('student_account_recovery', unknown)],
        );
        assert.equal(decoyRetry.expiresAt, decoyChallenge.rows[0]!.expires_at.toISOString(), 'decoy retries must replay the frozen challenge expiry');
        assert.ok(Date.parse(decoy.expiresAt) - Date.parse(decoyRetry.expiresAt) > 4 * 60 * 1000, 'fresh decoy handles report the ten-minute attempt window');
        await assert.rejects(() => service.verify({ attemptId: decoy.attemptId, secret: decoy.secret, code: 'code', otp: '123456' }));
        const after = await client.query<{ budgets: string; challenges: string }>(
            'SELECT (SELECT count(*)::text FROM verification_challenge_budgets) AS budgets, (SELECT count(*)::text FROM verification_challenges) AS challenges',
        );
        assert.equal(Number(after.rows[0]!.budgets) - Number(before.rows[0]!.budgets), 1, 'one upserted budget row per unknown subject');
        assert.equal(Number(after.rows[0]!.challenges) - Number(before.rows[0]!.challenges), 1, 'one challenge row per unknown subject');
        const decoyAttempts = await client.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM student_auth_recovery_attempts WHERE id = $1 OR id = $2', [decoy.attemptId, decoyRetry.attemptId],
        );
        assert.equal(decoyAttempts.rows[0]!.count, '0', 'decoy handles write no attempt rows and cannot verify');
        // A failed attempt is not resumable: the cooldown retry finds no
        // live attempt, writes no new attempt row, and returns the frozen
        // challenge expiry — never a fresh deadline that would mark
        // committed handles against decoy retries.
        const first = await service.start({ email: account.email, purpose: 'lost_access' });
        await client.query(`UPDATE student_auth_recovery_attempts SET status = 'failed', secret_hash = NULL WHERE id = $1`, [first.attemptId]);
        const retry = await service.start({ email: account.email, purpose: 'lost_access' });
        const committedChallenge = await client.query<{ expires_at: Date }>(
            `SELECT challenge.expires_at FROM verification_challenges challenge
             JOIN student_auth_recovery_attempts attempt ON attempt.mailbox_challenge_id = challenge.id
             WHERE attempt.id = $1`,
            [first.attemptId],
        );
        assert.equal(retry.expiresAt, committedChallenge.rows[0]!.expires_at.toISOString(), 'committed retries without a live attempt must replay the frozen challenge expiry');
        assert.ok(Date.parse(first.expiresAt) - Date.parse(retry.expiresAt) > 4 * 60 * 1000, 'fresh committed handles report the ten-minute attempt window');
        await assert.rejects(() => service.verify({ attemptId: retry.attemptId, secret: retry.secret, code: account.code, otp: '123456' }));
        const rows = await client.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM student_auth_recovery_attempts WHERE user_id = $1', [account.userId],
        );
        assert.equal(rows.rows[0]!.count, '1');
    } finally {
        client.release();
        await pool.end();
    }
});

test('failed recovery delivery retires the attempt and challenge without stranding retry', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        let sends = 0; let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { sends++; if (sends === 1) return { success: false }; otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'delivery-retry-hash',
        });
        const first = await service.start({ email: account.email, purpose: 'lost_access' });
        assert.match(first.attemptId, /^[0-9a-f-]{36}$/i, 'the 202 handle shape is preserved while compensation runs async');
        // The delivery resolves { success: false } (Brevo retries
        // exhausted): the pending attempt terminalizes and its challenge
        // supersedes instead of staying reboundable.
        const deadline = Date.now() + 5000;
        for (;;) {
            const row = await client.query<{ status: string; secret_hash: string | null }>(
                'SELECT status, secret_hash FROM student_auth_recovery_attempts WHERE id = $1', [first.attemptId],
            );
            if (row.rows[0]?.status === 'failed') {
                assert.equal(row.rows[0]!.secret_hash, null);
                break;
            }
            assert.ok(Date.now() < deadline, 'async compensation must retire the undelivered attempt');
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        // A cooldown restart cannot rebound to the undelivered challenge:
        // no live attempt exists, so the handle cannot verify. The
        // deadline still replays the superseded challenge's frozen
        // expiry — a fresh fallback here would mark compensated
        // accounts against untouched decoys by expiresAt.
        const retry = await service.start({ email: account.email, purpose: 'lost_access' });
        const compensatedChallenge = await client.query<{ expires_at: Date }>(
            `SELECT challenge.expires_at FROM verification_challenges challenge
             JOIN student_auth_recovery_attempts attempt ON attempt.mailbox_challenge_id = challenge.id
             WHERE attempt.id = $1`,
            [first.attemptId],
        );
        assert.equal(retry.expiresAt, compensatedChallenge.rows[0]!.expires_at.toISOString(), 'post-compensation cooldown retries must replay the frozen challenge expiry');
        await assert.rejects(() => service.verify({ attemptId: retry.attemptId, secret: retry.secret, code: account.code, otp: '123456' }));
        // Past the cooldown, recovery completes end to end on a fresh OTP.
        await client.query(
            `UPDATE verification_challenge_budgets
             SET send_count = 0, resend_available_at = clock_timestamp() - interval '1 second'
             WHERE purpose = 'student_account_recovery' AND subject_digest = $1`,
            [challengeSubjectDigest('student_account_recovery', account.email)],
        );
        const second = await service.start({ email: account.email, purpose: 'lost_access' });
        assert.match(otp, /^\d{6}$/);
        await service.verify({ attemptId: second.attemptId, secret: second.secret, code: account.code, otp });
        await service.complete({ attemptId: second.attemptId, secret: second.secret, password: 'ValidNew1!' });
        const after = await client.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [account.userId]);
        assert.equal(after.rows[0]!.password_hash, 'delivery-retry-hash');
    } finally {
        client.release();
        await pool.end();
    }
});

test('failed recovery delivery follows challenge rebinding to the live holder', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        let resolveDelivery: ((value: { success: boolean }) => void) | null = null;
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async () => new Promise<{ success: boolean }>((resolve) => { resolveDelivery = resolve; }),
        });
        const key = randomUUID();
        const first = await service.start({ email: account.email, purpose: 'lost_access', idempotencyKey: key });
        // A bound cooldown restart rebounds while delivery is still in
        // flight: the original attempt fails and the live challenge moves
        // to the new holder without any redelivery.
        const second = await service.start({ email: account.email, purpose: 'lost_access', idempotencyKey: key });
        assert.notEqual(second.attemptId, first.attemptId);
        resolveDelivery!({ success: false });
        // Compensation keys by the challenge, not the superseded attempt:
        // the rebound holder retires with the original, and the
        // undelivered challenge supersedes so nothing can resume it.
        const deadline = Date.now() + 5000;
        for (;;) {
            const rows = await client.query<{ id: string; status: string }>(
                'SELECT id, status FROM student_auth_recovery_attempts WHERE id = ANY($1)',
                [[first.attemptId, second.attemptId]],
            );
            const byId = new Map(rows.rows.map((row) => [row.id, row.status]));
            const challenge = await client.query<{ superseded_at: Date | null }>(
                `SELECT superseded_at FROM verification_challenges c
                 JOIN student_auth_recovery_attempts a ON a.mailbox_challenge_id = c.id WHERE a.id = $1`,
                [second.attemptId],
            );
            if (byId.get(first.attemptId) === 'failed' && byId.get(second.attemptId) === 'failed' && challenge.rows[0]?.superseded_at !== null) break;
            assert.ok(Date.now() < deadline, 'compensation must follow the rebound holder');
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    } finally {
        client.release();
        await pool.end();
    }
});

test('verified recovery completes after the OTP TTL within the ten-minute attempt window', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'window-split-hash',
        });
        const first = await service.start({ email: account.email, purpose: 'lost_access' });
        // The attempt owns the full ten-minute window even though the
        // mailbox OTP underneath uses the shorter signup-style TTL.
        const window = await client.query<{ expires_at: Date; created_at: Date }>(
            'SELECT expires_at, created_at FROM student_auth_recovery_attempts WHERE id = $1', [first.attemptId],
        );
        assert.ok(window.rows[0]!.expires_at.getTime() - window.rows[0]!.created_at.getTime() > 9 * 60 * 1000,
            'recovery attempts must own a ten-minute completion window');
        await service.verify({ attemptId: first.attemptId, secret: first.secret, code: account.code, otp });
        // The shorter OTP TTL elapses after the proofs were accepted: the
        // consumed challenge expires but the verified attempt stays live.
        // Both timestamps move together: the table requires expiry after
        // creation even for long-dead challenges.
        await client.query(
            `UPDATE verification_challenges
             SET created_at = clock_timestamp() - interval '6 minutes', expires_at = clock_timestamp() - interval '1 minute'
             WHERE id = (SELECT mailbox_challenge_id FROM student_auth_recovery_attempts WHERE id = $1)`,
            [first.attemptId],
        );
        await service.complete({ attemptId: first.attemptId, secret: first.secret, password: 'ValidNew1!' });
        const after = await client.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [account.userId]);
        assert.equal(after.rows[0]!.password_hash, 'window-split-hash');
    } finally {
        client.release();
        await pool.end();
    }
});

test('recovery attempts verify across a stage-two key rotation in either direction', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        // Stage-two rolling deploy: restarted replicas write K2 and fall
        // back to K1, while not-yet-restarted replicas still run the
        // stage-one config (write K1, fall back to K2). The seed enrolls
        // codes under K1, so both replicas also prove the code fallback.
        const K1 = 'test-recovery-code-key';
        const K2 = 'test-recovery-code-key-k2-rotation';
        let oldOtp = ''; let newOtp = '';
        const oldReplica = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: K1, previousRecoveryCodeKey: K2,
            deliverOtp: async (_email, delivered) => { oldOtp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'rotation-old-hash',
        });
        const newReplica = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: K2, previousRecoveryCodeKey: K1,
            deliverOtp: async (_email, delivered) => { newOtp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'rotation-new-hash',
        });
        // K1-created attempt verifies and completes on a K2 replica.
        const firstAccount = await seedRecoverableStudent(client);
        const first = await oldReplica.start({ email: firstAccount.email, purpose: 'lost_access' });
        await newReplica.verify({ attemptId: first.attemptId, secret: first.secret, code: firstAccount.code, otp: oldOtp });
        await newReplica.complete({ attemptId: first.attemptId, secret: first.secret, password: 'ValidNew1!' });
        const firstAfter = await client.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [firstAccount.userId]);
        assert.equal(firstAfter.rows[0]!.password_hash, 'rotation-new-hash');
        // K2-created attempt verifies and completes on a K1 replica.
        const secondAccount = await seedRecoverableStudent(client);
        const second = await newReplica.start({ email: secondAccount.email, purpose: 'lost_access' });
        await oldReplica.verify({ attemptId: second.attemptId, secret: second.secret, code: secondAccount.code, otp: newOtp });
        await oldReplica.complete({ attemptId: second.attemptId, secret: second.secret, password: 'ValidNew1!' });
        const secondAfter = await client.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [secondAccount.userId]);
        assert.equal(secondAfter.rows[0]!.password_hash, 'rotation-old-hash');
    } finally {
        client.release();
        await pool.end();
    }
});

test('anonymous restarts cannot cancel a verified recovery during password choice', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'verified-survives-hash',
        });
        const victim = await service.start({ email: account.email, purpose: 'lost_access' });
        await service.verify({ attemptId: victim.attemptId, secret: victim.secret, code: account.code, otp });
        // Past the resend cooldown, an unauthenticated restart for the
        // same email issues a fresh challenge — but the verified attempt
        // whose proofs already succeeded must survive it.
        await client.query(
            `UPDATE verification_challenge_budgets
             SET send_count = 0, resend_available_at = clock_timestamp() - interval '1 second'
             WHERE purpose = 'student_account_recovery' AND subject_digest = $1`,
            [challengeSubjectDigest('student_account_recovery', account.email)],
        );
        const restart = await service.start({ email: account.email, purpose: 'lost_access' });
        assert.notEqual(restart.attemptId, victim.attemptId);
        const status = await client.query<{ status: string }>(
            'SELECT status FROM student_auth_recovery_attempts WHERE id = $1', [victim.attemptId],
        );
        assert.equal(status.rows[0]!.status, 'verified', 'verified attempts survive anonymous restarts until completion or expiry');
        await service.complete({ attemptId: victim.attemptId, secret: victim.secret, password: 'ValidNew1!' });
        const after = await client.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [account.userId]);
        assert.equal(after.rows[0]!.password_hash, 'verified-survives-hash');
    } finally {
        client.release();
        await pool.end();
    }
});

test('recovery completion invalidates pending SSO attempts despite a messy stored email', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        // Legacy stored representation: recovery still finds the account
        // through lower(btrim(email)), and the SSO invalidation must match
        // the normalized mailbox the attempt rows store.
        await client.query('UPDATE users SET email = $2 WHERE id = $1', [account.userId, `  ${account.email.toUpperCase()} `]);
        const universityId = (await client.query<{ id: string }>(
            'INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id',
            [`Recovery normalization ${randomUUID().slice(0, 8)}`],
        )).rows[0]!.id;
        const adminId = (await client.query<{ id: string }>(
            `INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`,
            [`recovery-norm-admin-${randomUUID().slice(0, 8)}@example.invalid`],
        )).rows[0]!.id;
        const policyId = (await client.query<{ id: string }>(
            `INSERT INTO institution_login_policies
                 (university_id, provider, issuer, provider_realm, version, enabled, approved_until, approved_by, school_assertion_days)
             VALUES ($1, 'microsoft', $2, $3, 1, true, clock_timestamp() + interval '30 days', $4, 90) RETURNING id`,
            [universityId, 'https://login.microsoftonline.com/recovery-norm-tenant/v2.0', 'recovery-norm-tenant', adminId],
        )).rows[0]!.id;
        // A provider return begun before recovery, stored normalized.
        const attemptId = (await client.query<{ id: string }>(
            `INSERT INTO student_auth_attempts
                 (policy_id, policy_version, provider, requested_email, state_hash, callback_cookie_hash,
                  finish_secret_hash, encrypted_verifier, nonce, status, expires_at, remember_me)
             VALUES ($1, 1, 'microsoft', $2, $3, $4, $5, $6, $7, 'pending', clock_timestamp() + interval '9 minutes', false)
             RETURNING id`,
            [policyId, account.email, randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()],
        )).rows[0]!.id;
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'normalized-password-hash',
        });
        const started = await service.start({ email: account.email, purpose: 'lost_access' });
        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        await service.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' });
        const attempt = await client.query<{ status: string; state_hash: string | null }>(
            'SELECT status, state_hash FROM student_auth_attempts WHERE id = $1', [attemptId],
        );
        assert.deepEqual(attempt.rows[0], { status: 'failed', state_hash: null },
            'a pre-recovery provider return must not mint a post-recovery session');
    } finally {
        client.release();
        await pool.end();
    }
});

test('recovery completion sends a post-commit notice without credentials', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        let otp = '';
        const notices: Array<{ email: string; purpose: string }> = [];
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'recovered-password-hash',
            notify: async (email, purpose) => { notices.push({ email, purpose }); return { success: true }; },
        });
        const started = await service.start({ email: account.email, purpose: 'lost_access' });
        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        assert.equal(notices.length, 0);
        await service.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' });
        assert.deepEqual(notices, [{ email: account.email, purpose: 'lost_access' }]);
    } finally {
        client.release();
        await pool.end();
    }
});

test('recovery terminal failure writers scrub superseded and stale-state secrets immediately', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'unused',
        });
        const first = await service.start({ email: account.email, purpose: 'lost_access' });
        await client.query(
            `UPDATE verification_challenge_budgets AS budget
             SET resend_available_at = clock_timestamp() - interval '1 second'
             FROM verification_challenges AS challenge
             JOIN student_auth_recovery_attempts AS attempt ON attempt.mailbox_challenge_id = challenge.id
             WHERE budget.purpose = challenge.purpose AND budget.subject_digest = challenge.subject_digest
               AND attempt.id = $1`,
            [first.attemptId],
        );
        const second = await service.start({ email: account.email, purpose: 'lost_access' });
        const superseded = await client.query<{ status: string; secret_hash: string | null }>(
            'SELECT status, secret_hash FROM student_auth_recovery_attempts WHERE id = $1', [first.attemptId],
        );
        assert.deepEqual(superseded.rows[0], { status: 'failed', secret_hash: null },
            'starting a replacement recovery immediately scrubs the superseded secret');

        // An ordinary code typo rejects but stays pending with its bearer
        // intact; only unrecoverable state terminalizes below.
        // A stale tab resubmitting the scrubbed attempt gets a bounded
        // rejection, not a 500 from comparing its NULL digest.
        await assert.rejects(
            () => service.verify({ attemptId: first.attemptId, secret: first.secret, code: account.code, otp: '000000' }),
            (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
        );
        await assert.rejects(() => service.verify({
            attemptId: second.attemptId, secret: second.secret, code: `${account.code}-wrong`, otp,
        }));
        const typo = await client.query<{ status: string; secret_hash: string | null }>(
            'SELECT status, secret_hash FROM student_auth_recovery_attempts WHERE id = $1', [second.attemptId],
        );
        assert.equal(typo.rows[0]!.status, 'pending');
        assert.ok(typo.rows[0]!.secret_hash, 'a code typo keeps the attempt retryable');

        // A password change pins stale generations: verification can never
        // succeed, so the attempt fails and its secret scrubs at once.
        const owner = await client.query<{ user_id: string }>(
            'SELECT user_id FROM student_auth_recovery_attempts WHERE id = $1', [second.attemptId],
        );
        await client.query('UPDATE users SET credential_generation = credential_generation + 1 WHERE id = $1', [owner.rows[0]!.user_id]);
        await assert.rejects(() => service.verify({
            attemptId: second.attemptId, secret: second.secret, code: account.code, otp,
        }));
        const rejected = await client.query<{ status: string; secret_hash: string | null }>(
            'SELECT status, secret_hash FROM student_auth_recovery_attempts WHERE id = $1', [second.attemptId],
        );
        assert.deepEqual(rejected.rows[0], { status: 'failed', secret_hash: null },
            'a stale-state recovery verification immediately scrubs its terminal secret');
    } finally {
        client.release();
        await pool.end();
    }
});

test('recovery completion immediately scrubs invalidated sibling SSO, recovery, and reauthentication attempts', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        const proofIdentityId = await seedProviderProof(client, account.userId, { policy: true });
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'recovered-password-hash',
        });
        const started = await service.start({ email: account.email, purpose: 'lost_access' });
        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        const policyId = (await client.query<{ id: string }>(
            `SELECT policy.id FROM institution_login_policies policy
             JOIN student_auth_identities identity ON identity.university_id = policy.university_id
             WHERE identity.id = $1`, [proofIdentityId],
        )).rows[0]!.id;
        const ssoAttempt = await client.query<{ id: string }>(
            `INSERT INTO student_auth_attempts
                 (policy_id, policy_version, provider, requested_email, state_hash, callback_cookie_hash,
                  finish_secret_hash, encrypted_verifier, nonce, encrypted_observation, status, expires_at, remember_me)
             VALUES ($1, 1, 'microsoft', $2, 'sso-state-secret', 'sso-cookie-secret',
                     'sso-finish-secret', 'sso-encrypted-verifier', 'sso-nonce', 'sso-observation',
                     'ready', clock_timestamp() + interval '5 minutes', false)
             RETURNING id`,
            [policyId, account.email],
        );
        const reauth = await client.query<{ id: string }>(
            `INSERT INTO student_auth_reauth_attempts
                 (user_id, sid, credential_generation, purpose, state_hash, callback_cookie_hash, encrypted_verifier, nonce,
                  proof_identity_id, status, expires_at)
             VALUES ($1, $2, 0, 'link', 'reauth-state-secret', 'reauth-cookie-secret', 'reauth-encrypted-verifier', 'reauth-nonce-secret',
                     $3, 'ready', clock_timestamp() + interval '5 minutes') RETURNING id`,
            [account.userId, randomUUID(), proofIdentityId],
        );
        const siblingRecovery = await client.query<{ id: string }>(
            `INSERT INTO student_auth_recovery_attempts
                 (user_id, credential_generation, purpose, secret_hash, recovery_code_generation, status, expires_at)
             VALUES ($1, 0, 'lost_access', 'sibling-recovery-secret', 1, 'pending', clock_timestamp() + interval '5 minutes')
             RETURNING id`, [account.userId],
        );
        await service.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' });
        const invalidatedReauth = await client.query<{
            status: string; state_hash: string | null; callback_cookie_hash: string | null; encrypted_verifier: string | null; nonce: string | null;
        }>('SELECT status, state_hash, callback_cookie_hash, encrypted_verifier, nonce FROM student_auth_reauth_attempts WHERE id = $1', [reauth.rows[0]!.id]);
        assert.deepEqual(invalidatedReauth.rows[0], {
            status: 'failed', state_hash: null, callback_cookie_hash: null, encrypted_verifier: null, nonce: null,
        });
        const invalidatedRecovery = await client.query<{ status: string; secret_hash: string | null }>(
            'SELECT status, secret_hash FROM student_auth_recovery_attempts WHERE id = $1', [siblingRecovery.rows[0]!.id],
        );
        assert.deepEqual(invalidatedRecovery.rows[0], { status: 'failed', secret_hash: null });
        const invalidatedSso = await client.query<{
            status: string; state_hash: string | null; callback_cookie_hash: string | null; finish_secret_hash: string | null;
            encrypted_verifier: string | null; nonce: string | null; encrypted_observation: string | null;
        }>('SELECT status, state_hash, callback_cookie_hash, finish_secret_hash, encrypted_verifier, nonce, encrypted_observation FROM student_auth_attempts WHERE id = $1', [ssoAttempt.rows[0]!.id]);
        assert.deepEqual(invalidatedSso.rows[0], {
            status: 'failed', state_hash: null, callback_cookie_hash: null, finish_secret_hash: null,
            encrypted_verifier: null, nonce: null, encrypted_observation: null,
        });
    } finally {
        client.release();
        await pool.end();
    }
});

test('recovery completion scrubs multiple retained legacy reauth grants without a uniqueness rollback', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        // Upgrade-retained rows share nothing but the owner; the shared
        // 'scrubbed' sentinel must terminalize all of them instead of
        // aborting the recovery on the second row.
        await client.query(
            `INSERT INTO student_auth_reauth_grants (user_id, sid, purpose, secret_hash, expires_at)
             VALUES ($1, $2, 'link', 'legacy-digest-a', clock_timestamp() + interval '4 minutes'),
                    ($1, $2, 'unlink', 'legacy-digest-b', clock_timestamp() + interval '4 minutes')`,
            [account.userId, randomUUID()],
        );
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'legacy-scrub-hash',
        });
        const started = await service.start({ email: account.email, purpose: 'lost_access' });
        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        await service.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' });
        const scrubbed = await client.query<{ secret_hash: string; consumed_at: Date | null }>(
            'SELECT secret_hash, consumed_at FROM student_auth_reauth_grants WHERE user_id = $1', [account.userId],
        );
        assert.equal(scrubbed.rows.length, 2);
        for (const row of scrubbed.rows) {
            assert.equal(row.secret_hash, 'scrubbed');
            assert.ok(row.consumed_at instanceof Date);
        }
    } finally {
        client.release();
        await pool.end();
    }
});

test('compromise recovery revokes only linked-derived assertions while preserving independent enrollment when the provider policy is disabled', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        const identityId = await seedProviderProof(client, account.userId);
        const university = await client.query<{ university_id: string }>('SELECT university_id FROM student_auth_identities WHERE id = $1', [identityId]);
        const universityId = university.rows[0]!.university_id;
        const student = await client.query<{ id: string }>('SELECT id FROM students WHERE user_id = $1', [account.userId]);
        const policy = await client.query<{ id: string }>(
            `INSERT INTO institution_login_policies
                 (university_id, provider, issuer, provider_realm, enabled, approved_until, school_assertion_days)
             VALUES ($1, 'microsoft', $2, $3, false, clock_timestamp() - interval '1 day', 30) RETURNING id`,
            [universityId, `https://issuer.example.invalid/compromise-${randomUUID()}`, `realm-${randomUUID()}`],
        );
        await client.query(
            `INSERT INTO student_school_assertions
                 (user_id, university_id, source, auth_identity_id, login_policy_id, policy_version, identity_version, expires_at)
             VALUES ($1, $2, 'microsoft_school', $3, $4, 1, 1, clock_timestamp() + interval '30 days')`,
            [account.userId, universityId, identityId, policy.rows[0]!.id],
        );
        const challengeId = randomUUID();
        await client.query(
            `INSERT INTO verification_challenges (id, purpose, subject_digest, secret_digest, bindings, created_at, expires_at)
             VALUES ($1, 'student_signup', $2, $3, '{}'::jsonb, clock_timestamp(), clock_timestamp() + interval '10 minutes')`,
            [challengeId, 'a'.repeat(64), 'b'.repeat(64)],
        );
        const proof = await client.query<{ id: string }>(
            `INSERT INTO user_email_proofs (user_id, email, challenge_id) VALUES ($1, $2, $3) RETURNING id`,
            [account.userId, account.email, challengeId],
        );
        const consent = await client.query<{ id: string }>(
            `INSERT INTO verification_consents (user_id, kind, university_id, notice_version)
             VALUES ($1, 'processing', $2, 'test-v1') RETURNING id`, [account.userId, universityId],
        );
        const enrollment = await client.query<{ id: string }>(
            `INSERT INTO eligibility_evidence
                 (student_id, university_id, email_proof_id, processing_grant_id, method, outcome, identity_version, policy_version, source)
             VALUES ($1, $2, $3, $4, 'enrollment', 'verified', 1, 1, 'independent-test') RETURNING id`,
            [student.rows[0]!.id, universityId, proof.rows[0]!.id, consent.rows[0]!.id],
        );
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key', deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'compromise-password-hash',
        });
        const started = await service.start({ email: account.email, purpose: 'compromise' });
        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        await service.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' });
        const identity = await client.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM student_auth_identities WHERE id = $1', [identityId]);
        const assertion = await client.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM student_school_assertions WHERE auth_identity_id = $1', [identityId]);
        const retainedEnrollment = await client.query('SELECT id FROM eligibility_evidence WHERE id = $1 AND revoked_at IS NULL', [enrollment.rows[0]!.id]);
        assert.notEqual(identity.rows[0]!.revoked_at, null);
        assert.notEqual(assertion.rows[0]!.revoked_at, null);
        assert.equal(retainedEnrollment.rowCount, 1, 'independent enrollment must survive compromise recovery');
    } finally {
        client.release();
        await pool.end();
    }
});

test('suspended accounts, pending codes, replay, and purpose substitution fail closed', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        let deliveries = 0;
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key', deliverOtp: async () => { deliveries += 1; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'recovered-password-hash',
        });
        await client.query("UPDATE students SET status = 'suspended' WHERE user_id = $1", [account.userId]);
        const suspended = await service.start({ email: account.email, purpose: 'lost_access' });
        assert.equal(deliveries, 0);
        await assert.rejects(() => service.verify({ attemptId: suspended.attemptId, secret: suspended.secret, code: account.code, otp: '123456' }));
        await client.query("UPDATE students SET status = 'active' WHERE user_id = $1", [account.userId]);
        await client.query("UPDATE student_auth_recovery_codes SET status = 'revoked', code_digest = NULL, revoked_at = clock_timestamp() WHERE user_id = $1 AND status = 'active'", [account.userId]);
        await client.query(
            `INSERT INTO student_auth_recovery_codes
                 (user_id, generation, code_digest, status, expires_at, pending_sid, pending_credential_generation)
             VALUES ($1, 2, 'pending-digest', 'pending', clock_timestamp() + interval '5 minutes', $2::uuid, 0)`,
            [account.userId, SID],
        );
        const pending = await service.start({ email: account.email, purpose: 'compromise' });
        assert.equal(deliveries, 0, 'pending recovery codes cannot start recovery');
        await assert.rejects(() => service.verify({ attemptId: pending.attemptId, secret: pending.secret, code: account.code, otp: '123456' }));

        await client.query("UPDATE student_auth_recovery_codes SET status = 'active', expires_at = NULL, activated_at = clock_timestamp(), pending_sid = NULL, pending_credential_generation = NULL, pending_proof_identity_id = NULL WHERE user_id = $1 AND status = 'pending'", [account.userId]);
        // The decoy phases above share the subject's challenge budget with
        // the committed path (one subject, one cap). Re-arm it so this
        // phase starts from issuance instead of a cooldown the production
        // state transitions (reactivation, enrollment) would outlast.
        await client.query(
            `UPDATE verification_challenge_budgets
             SET send_count = 0, resend_available_at = clock_timestamp() - interval '1 second'
             WHERE purpose = 'student_account_recovery'`,
        );
        // This active code deliberately has a known digest only in this test fixture.
        await client.query("UPDATE student_auth_recovery_codes SET code_digest = $2 WHERE user_id = $1 AND status = 'active'", [account.userId, createHmac('sha256', 'test-recovery-code-key').update(account.code, 'utf8').digest('base64url')]);
        let otp = '';
        const replayService = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key', deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'recovered-password-hash',
        });
        const started = await replayService.start({ email: account.email, purpose: 'lost_access' });
        await assert.rejects(
            () => client.query("UPDATE student_auth_recovery_attempts SET purpose = 'compromise' WHERE id = $1", [started.attemptId]),
            /immutable/i,
        );
        await replayService.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        await replayService.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' });
        await assert.rejects(() => replayService.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' }));
    } finally {
        client.release();
        await pool.end();
    }
});

test('a failed recovery transaction rolls back code consumption and identity revocation', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        const identityId = await seedProviderProof(client, account.userId);
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key', deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'rollback-password-hash',
        });
        const started = await service.start({ email: account.email, purpose: 'compromise' });
        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        await client.query(`CREATE FUNCTION test_recovery_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced recovery rollback'; END $$`);
        await client.query(`CREATE TRIGGER test_recovery_rollback BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION test_recovery_rollback()`);
        await assert.rejects(() => service.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' }), /forced recovery rollback/);
        await client.query('DROP TRIGGER test_recovery_rollback ON users');
        await client.query('DROP FUNCTION test_recovery_rollback()');
        const code = await client.query<{ status: string }>('SELECT status FROM student_auth_recovery_codes WHERE user_id = $1', [account.userId]);
        const attempt = await client.query<{ status: string }>('SELECT status FROM student_auth_recovery_attempts WHERE id = $1', [started.attemptId]);
        const identity = await client.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM student_auth_identities WHERE id = $1', [identityId]);
        assert.equal(code.rows[0]!.status, 'active');
        assert.equal(attempt.rows[0]!.status, 'verified');
        assert.equal(identity.rows[0]!.revoked_at, null);
    } finally {
        client.release();
        await pool.end();
    }
});

test('simultaneous recovery completion has one winner and cannot consume a code twice', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key', deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'race-password-hash',
        });
        const started = await service.start({ email: account.email, purpose: 'lost_access' });
        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        const results = await Promise.allSettled([
            service.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' }),
            service.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' }),
        ]);
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        const settled = await client.query<{ credential_generation: string }>('SELECT credential_generation FROM users WHERE id = $1', [account.userId]);
        const code = await client.query<{ status: string }>('SELECT status FROM student_auth_recovery_codes WHERE user_id = $1', [account.userId]);
        assert.equal(settled.rows[0]!.credential_generation, '1');
        assert.equal(code.rows[0]!.status, 'consumed');
    } finally {
        client.release();
        await pool.end();
    }
});

test('recovery-code replacement and account recovery race through the same account lock', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        await client.query('UPDATE users SET active_session_id = $2::uuid WHERE id = $1', [account.userId, SID]);
        const codeService = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key' });
        const replacementGrant = await grant(client, { userId: account.userId, purpose: 'recovery_code_generate', activeCodeGeneration: 1 });
        const replacement = await codeService.generate({
            userId: account.userId, sid: SID, grantId: replacementGrant.grantId, secret: replacementGrant.grantSecret, oldCode: account.code,
        });
        const activationGrant = await grant(client, {
            userId: account.userId, purpose: 'recovery_code_activate', pendingCodeId: replacement.pendingCodeId, activeCodeGeneration: 1,
        });
        let otp = '';
        const recovery = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key', deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'recovery-race-password-hash',
        });
        const started = await recovery.start({ email: account.email, purpose: 'lost_access' });
        await recovery.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        const results = await Promise.allSettled([
            recovery.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' }),
            codeService.activate({
                userId: account.userId, sid: SID, grantId: activationGrant.grantId, secret: activationGrant.grantSecret,
                pendingCodeId: replacement.pendingCodeId, code: replacement.code, oldCode: account.code,
            }),
        ]);
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        const codes = await client.query<{ status: string; generation: string }>(
            "SELECT status, generation FROM student_auth_recovery_codes WHERE user_id = $1 AND status IN ('active', 'consumed', 'pending') ORDER BY generation", [account.userId],
        );
        assert.ok(codes.rows.some((row) => row.status === 'consumed') || codes.rows.some((row) => row.status === 'active' && row.generation === '2'));
    } finally {
        client.release();
        await pool.end();
    }
});

test('recovery verification is idempotent across a lost response without failing the attempt', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'idempotent-password-hash',
        });
        const started = await service.start({ email: account.email, purpose: 'lost_access' });
        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        // The commit landed but the response was lost: the same proofs
        // retry cleanly even though the mailbox challenge is consumed.
        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        // A mistyped retry still fails, but the verified attempt survives
        // it: the user keeps what they already earned.
        await assert.rejects(() => service.verify({
            attemptId: started.attemptId, secret: started.secret, code: 'wrong-code', otp,
        }));
        const status = await client.query<{ status: string }>(
            'SELECT status FROM student_auth_recovery_attempts WHERE id = $1', [started.attemptId],
        );
        assert.equal(status.rows[0]!.status, 'verified');
        await service.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' });
    } finally {
        client.release();
        await pool.end();
    }
});

test('a mistyped recovery code stays retryable while stale account state terminalizes', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'typo-password-hash',
        });
        const started = await service.start({ email: account.email, purpose: 'lost_access' });
        // A copy/paste error rejects but leaves the attempt pending: the
        // corrected code with the same OTP verifies without a new email.
        await assert.rejects(() => service.verify({
            attemptId: started.attemptId, secret: started.secret, code: 'wrong-code', otp,
        }));
        const kept = await client.query<{ status: string; secret_hash: string | null }>(
            'SELECT status, secret_hash FROM student_auth_recovery_attempts WHERE id = $1', [started.attemptId],
        );
        assert.equal(kept.rows[0]!.status, 'pending');
        assert.ok(kept.rows[0]!.secret_hash);
        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        await service.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' });
    } finally {
        client.release();
        await pool.end();
    }
});

test('recovery completion rejects passwords over the published maximum', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'unused',
        });
        const started = await service.start({ email: account.email, purpose: 'lost_access' });
        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        // 1025 characters of otherwise valid complexity: the published
        // maxLength 1024 is enforced at runtime, not just documented.
        await assert.rejects(() => service.complete({
            attemptId: started.attemptId, secret: started.secret, password: `Valid1!${'a'.repeat(1019)}`,
        }));
        const status = await client.query<{ status: string }>(
            'SELECT status FROM student_auth_recovery_attempts WHERE id = $1', [started.attemptId],
        );
        assert.equal(status.rows[0]!.status, 'verified');
    } finally {
        client.release();
        await pool.end();
    }
});

test('recovery permanently session-binds the account across re-enrollment', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        let otp = '';
        const recovery = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'binding-password-hash',
        });
        const started = await recovery.start({ email: account.email, purpose: 'compromise' });
        await recovery.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        await recovery.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' });
        const bound = await client.query<{ recovery_reenrollment_requires_password: boolean; recovery_session_binding_required: boolean }>(
            'SELECT recovery_reenrollment_requires_password, recovery_session_binding_required FROM users WHERE id = $1', [account.userId],
        );
        assert.deepEqual(bound.rows[0], { recovery_reenrollment_requires_password: true, recovery_session_binding_required: true });
        // The owner signs in fresh and re-enrolls with a password grant:
        // activation clears the UX marker but the session binding it
        // imposed persists, so legacy sid-less tokens stay revoked.
        await client.query('UPDATE users SET active_session_id = $2::uuid WHERE id = $1', [account.userId, SID]);
        const codes = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key' });
        const generated = await grant(client, { userId: account.userId, purpose: 'recovery_code_generate', credentialGeneration: 1 });
        const pending = await codes.generate({ userId: account.userId, sid: SID, grantId: generated.grantId, secret: generated.grantSecret });
        const activated = await grant(client, { userId: account.userId, purpose: 'recovery_code_activate', pendingCodeId: pending.pendingCodeId, credentialGeneration: 1 });
        await codes.activate({ userId: account.userId, sid: SID, grantId: activated.grantId, secret: activated.grantSecret, pendingCodeId: pending.pendingCodeId, code: pending.code });
        const reenrolled = await client.query<{ recovery_reenrollment_requires_password: boolean; recovery_session_binding_required: boolean }>(
            'SELECT recovery_reenrollment_requires_password, recovery_session_binding_required FROM users WHERE id = $1', [account.userId],
        );
        assert.deepEqual(reenrolled.rows[0], { recovery_reenrollment_requires_password: false, recovery_session_binding_required: true });
    } finally {
        client.release();
        await pool.end();
    }
});

test('five wrong recovery OTPs persist their shared failure budget despite generic verification errors', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key', deliverOtp: async () => ({ success: true }),
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'unused',
        });
        const started = await service.start({ email: account.email, purpose: 'lost_access' });
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await assert.rejects(() => service.verify({
                attemptId: started.attemptId, secret: started.secret, code: account.code, otp: '000000',
            }));
        }
        const budget = await client.query<{ failed_attempts: number }>(
            `SELECT budget.failed_attempts
             FROM verification_challenge_budgets AS budget
             JOIN verification_challenges AS challenge ON challenge.subject_digest = budget.subject_digest
                 AND challenge.purpose = budget.purpose
             JOIN student_auth_recovery_attempts AS recovery ON recovery.mailbox_challenge_id = challenge.id
             WHERE recovery.id = $1`,
            [started.attemptId],
        );
        assert.equal(budget.rows[0]!.failed_attempts, 5);
        await assert.rejects(() => service.verify({
            attemptId: started.attemptId, secret: started.secret, code: account.code, otp: '000000',
        }));
    } finally {
        client.release();
        await pool.end();
    }
});

async function seedProviderProof(client: PoolClient, userId: string, options: { policy?: boolean; linkedAt?: string; canonical?: boolean } = {}): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    // The observed mailbox sits inside the mapped institution domain, like
    // production link observations: proof authority matches the mapping to
    // the identity's own mailbox domain, not any domain on the policy.
    const domain = `recovery-proof-${suffix}.example.invalid`;
    const university = await client.query<{ id: string }>(
        'INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id',
        [`Recovery proof ${suffix}`],
    );
    const identity = await client.query<{ id: string }>(
        `INSERT INTO student_auth_identities
             (user_id, university_id, provider, issuer, subject, observed_email, linked_at)
         VALUES ($1, $2, 'microsoft', $3, $4, $5, COALESCE($6::timestamptz, clock_timestamp())) RETURNING id`,
        [userId, university.rows[0]!.id, `https://issuer.example.invalid/${suffix}`, `subject-${suffix}`, `recovery-${suffix}@${domain}`, options.linkedAt ?? null],
    );
    // Proof consumption revalidates the identity's full login authority
    // chain, so proof-consumption tests opt into a live policy, a live
    // domain mapping, and canonical placement at the student's
    // university; other callers seed their own policy or none at all.
    // Multi-identity tests pass canonical: false for decoys so the
    // student's canonical university stays on the intended identity.
    if (options.policy === true) {
        const admin = await client.query<{ id: string }>(
            'INSERT INTO users (email, role) VALUES ($1, $2) RETURNING id',
            [`recovery-proof-admin-${suffix}@example.invalid`, 'admin'],
        );
        const policy = await client.query<{ id: string }>(
            `INSERT INTO institution_login_policies
                 (university_id, provider, issuer, provider_realm, version, enabled, approved_until, approved_by, school_assertion_days)
             VALUES ($1, 'microsoft', $2, $3, 1, true, clock_timestamp() + interval '30 days', $4, 90) RETURNING id`,
            [university.rows[0]!.id, `https://issuer.example.invalid/${suffix}`, suffix, admin.rows[0]!.id],
        );
        await client.query(
            'INSERT INTO institution_login_domains (domain, university_id, is_active) VALUES ($1, $2, true)',
            [domain, university.rows[0]!.id],
        );
        await client.query(
            'INSERT INTO institution_login_domain_providers (domain, university_id, provider, policy_id) VALUES ($1, $2, $3, $4)',
            [domain, university.rows[0]!.id, 'microsoft', policy.rows[0]!.id],
        );
        if (options.canonical !== false) {
            await client.query('UPDATE students SET university_id = $2 WHERE user_id = $1', [userId, university.rows[0]!.id]);
        }
    }
    return identity.rows[0]!.id;
}

async function grant(
    client: PoolClient,
    input: { userId: string; sid?: string; purpose: 'recovery_code_generate' | 'recovery_code_activate' | 'recovery_code_remove'; pendingCodeId?: string; activeCodeGeneration?: number; proofIdentityId?: string; credentialGeneration?: number },
) {
    return issueActionGrant(client, {
        userId: input.userId,
        sid: input.sid ?? SID,
        purpose: input.purpose,
        credentialGeneration: input.credentialGeneration ?? 0,
        ...(input.pendingCodeId === undefined ? {} : { pendingCodeId: input.pendingCodeId }),
        ...(input.activeCodeGeneration === undefined ? {} : { activeCodeGeneration: input.activeCodeGeneration }),
        ...(input.proofIdentityId === undefined ? {} : { proofIdentityId: input.proofIdentityId }),
    });
}

test('pending codes cannot recover and activation leaves only a digest at rest', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const service = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key' });
        const generated = await grant(client, { userId, purpose: 'recovery_code_generate' });

        const pending = await service.generate({ userId, sid: SID, grantId: generated.grantId, secret: generated.grantSecret });
        const stored = await client.query<{ code_digest: string; status: string }>(
            'SELECT code_digest, status FROM student_auth_recovery_codes WHERE id = $1',
            [pending.pendingCodeId],
        );
        assert.equal(stored.rows[0]!.status, 'pending');
        assert.notEqual(stored.rows[0]!.code_digest, pending.code);
        const pendingStatus = await service.status({ userId });
        assert.equal(pendingStatus.status, 'pending');
        assert.equal(pendingStatus.pendingCodeId, pending.pendingCodeId);
        assert.ok(pendingStatus.pendingExpiresAt && Date.parse(pendingStatus.pendingExpiresAt) > Date.now(),
            'status exposes the live pending activation deadline for display across navigation and reload');

        const activation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: pending.pendingCodeId });
        await service.activate({
            userId, sid: SID, grantId: activation.grantId, secret: activation.grantSecret,
            pendingCodeId: pending.pendingCodeId, code: pending.code,
        });
        assertRecoveryStatus(await service.status({ userId }), { status: 'active', generation: 1, pendingCodeId: null, pendingExpiresAt: null });
        const activated = await client.query<{ pending_sid: string | null; pending_credential_generation: string | null; pending_proof_identity_id: string | null }>(
            'SELECT pending_sid, pending_credential_generation, pending_proof_identity_id FROM student_auth_recovery_codes WHERE id = $1',
            [pending.pendingCodeId],
        );
        assert.deepEqual(activated.rows[0], { pending_sid: null, pending_credential_generation: null, pending_proof_identity_id: null },
            'activation scrubs the pending-only authorization bindings instead of retaining them for the code lifetime');
        await assert.rejects(
            () => service.activate({ userId, sid: SID, grantId: activation.grantId, secret: activation.grantSecret, pendingCodeId: pending.pendingCodeId, code: pending.code }),
            /not valid|not available/i,
            'a response-loss retry must not return plaintext or reactivate a consumed grant',
        );
    } finally {
        client.release();
        await pool.end();
    }
});

test('suspension after grant issuance blocks recovery-code enrollment and activation', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const service = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key' });
        const generated = await grant(client, { userId, purpose: 'recovery_code_generate' });
        // Suspend after the five-minute proof grant is issued: both
        // proof-issuance paths required an active student context, so
        // consumption must recheck instead of enrolling a credential.
        await client.query("UPDATE students SET status = 'suspended' WHERE user_id = $1", [userId]);
        await assert.rejects(
            () => service.generate({ userId, sid: SID, grantId: generated.grantId, secret: generated.grantSecret }),
            /not available/i,
            'a grant issued before suspension must not enroll a code after it',
        );
        assertRecoveryStatus(await service.status({ userId }), { status: 'unconfigured', generation: null, pendingCodeId: null, pendingExpiresAt: null });
    } finally {
        client.release();
        await pool.end();
    }
});

test('adding a dedicated digest key keeps codes enrolled under the previous key usable', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const legacy = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key' });
        const generated = await grant(client, { userId, purpose: 'recovery_code_generate' });
        const pending = await legacy.generate({ userId, sid: SID, grantId: generated.grantId, secret: generated.grantSecret });
        // Simulate a pre-versioning row: the stored digest loses its prefix.
        await client.query(`UPDATE student_auth_recovery_codes SET code_digest = substr(code_digest, 4) WHERE id = $1`, [pending.pendingCodeId]);
        // The deployment adds the dedicated key; the established key stays
        // as the verification fallback so nothing is stranded.
        const rotated = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key-v2-dedicated', previousCodeKey: 'test-recovery-code-key' });
        const activation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: pending.pendingCodeId });
        await rotated.activate({ userId, sid: SID, grantId: activation.grantId, secret: activation.grantSecret, pendingCodeId: pending.pendingCodeId, code: pending.code });
        assertRecoveryStatus(await rotated.status({ userId }), { status: 'active', generation: 1, pendingCodeId: null, pendingExpiresAt: null });
        // Replacement proves the old code against the previous key, while
        // the replacement itself digests under the new dedicated key.
        const replacement = await grant(client, { userId, purpose: 'recovery_code_generate', activeCodeGeneration: 1 });
        const second = await rotated.generate({ userId, sid: SID, grantId: replacement.grantId, secret: replacement.grantSecret, oldCode: pending.code });
        const stored = await client.query<{ code_digest: string }>('SELECT code_digest FROM student_auth_recovery_codes WHERE id = $1', [second.pendingCodeId]);
        assert.ok(stored.rows[0]!.code_digest.startsWith('v1:'), 'new digests are versioned under the current key');
        const activation2 = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: second.pendingCodeId, activeCodeGeneration: 1 });
        await rotated.activate({ userId, sid: SID, grantId: activation2.grantId, secret: activation2.grantSecret, pendingCodeId: second.pendingCodeId, code: second.code, oldCode: pending.code });
        assertRecoveryStatus(await rotated.status({ userId }), { status: 'active', generation: 2, pendingCodeId: null, pendingExpiresAt: null });
        // The replacement digest verifies under the dedicated key alone:
        // removal without the fallback proves the new code against it.
        const standalone = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key-v2-dedicated' });
        const removal = await grant(client, { userId, purpose: 'recovery_code_remove', activeCodeGeneration: 2 });
        await standalone.remove({ userId, sid: SID, grantId: removal.grantId, secret: removal.grantSecret, oldCode: second.code });
        assertRecoveryStatus(await standalone.status({ userId }), { status: 'unconfigured', generation: 2, pendingCodeId: null, pendingExpiresAt: null });
    } finally {
        client.release();
        await pool.end();
    }
});

test('account recovery verifies legacy codes after the digest key changes', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        // The seed stores an unprefixed legacy digest under the test key.
        const account = await seedRecoverableStudent(client);
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key-v2-dedicated', previousRecoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'recovered-password-hash',
        });
        const started = await service.start({ email: account.email, purpose: 'lost_access' });
        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
        await service.complete({ attemptId: started.attemptId, secret: started.secret, password: 'ValidNew1!' });
        const after = await client.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [account.userId]);
        assert.equal(after.rows[0]!.password_hash, 'recovered-password-hash');
    } finally {
        client.release();
        await pool.end();
    }
});

test('suspension after code issuance blocks pending activation', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const service = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key' });
        const generated = await grant(client, { userId, purpose: 'recovery_code_generate' });
        const pending = await service.generate({ userId, sid: SID, grantId: generated.grantId, secret: generated.grantSecret });
        const activation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: pending.pendingCodeId });
        await client.query("UPDATE students SET status = 'suspended' WHERE user_id = $1", [userId]);
        await assert.rejects(
            () => service.activate({
                userId, sid: SID, grantId: activation.grantId, secret: activation.grantSecret,
                pendingCodeId: pending.pendingCodeId, code: pending.code,
            }),
            /not available/i,
            'a grant issued before suspension must not activate a code after it',
        );
        assert.equal((await service.status({ userId })).status, 'pending');
        // The shared suite asserts exact cleanup counts: remove the live
        // pending row this test leaves behind, after its referencing grant.
        await client.query('DELETE FROM student_auth_action_grants WHERE id = $1', [activation.grantId]);
        await client.query('DELETE FROM student_auth_recovery_codes WHERE id = $1', [pending.pendingCodeId]);
    } finally {
        client.release();
        await pool.end();
    }
});

test('status falls back to the active code when a replacement candidate expired', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const service = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key' });
        const initialGrant = await grant(client, { userId, purpose: 'recovery_code_generate' });
        const initial = await service.generate({ userId, sid: SID, grantId: initialGrant.grantId, secret: initialGrant.grantSecret });
        const initialActivation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: initial.pendingCodeId });
        await service.activate({ userId, sid: SID, grantId: initialActivation.grantId, secret: initialActivation.grantSecret, pendingCodeId: initial.pendingCodeId, code: initial.code });
        const replacementGrant = await grant(client, { userId, purpose: 'recovery_code_generate', activeCodeGeneration: 1 });
        const replacement = await service.generate({ userId, sid: SID, grantId: replacementGrant.grantId, secret: replacementGrant.grantSecret, oldCode: initial.code });
        assert.equal((await service.status({ userId })).status, 'pending');
        await client.query(`UPDATE student_auth_recovery_codes SET expires_at = clock_timestamp() WHERE id = $1`, [replacement.pendingCodeId]);
        assertRecoveryStatus(await service.status({ userId }), { status: 'active', generation: 1, pendingCodeId: null, pendingExpiresAt: null });
        // The shared suite asserts exact cleanup counts: an expired pending
        // left behind would inflate the next file's terminalization count.
        await client.query(`DELETE FROM student_auth_recovery_codes WHERE id = $1`, [replacement.pendingCodeId]);
    } finally {
        client.release();
        await pool.end();
    }
});

test('replacement and removal require the current active code and exact separate grants', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const service = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key' });
        const initialGrant = await grant(client, { userId, purpose: 'recovery_code_generate' });
        const initial = await service.generate({ userId, sid: SID, grantId: initialGrant.grantId, secret: initialGrant.grantSecret });
        const initialActivation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: initial.pendingCodeId });
        await service.activate({ userId, sid: SID, grantId: initialActivation.grantId, secret: initialActivation.grantSecret, pendingCodeId: initial.pendingCodeId, code: initial.code });

        const replacementGrant = await grant(client, { userId, purpose: 'recovery_code_generate', activeCodeGeneration: 1 });
        await assert.rejects(
            () => service.generate({ userId, sid: SID, grantId: replacementGrant.grantId, secret: replacementGrant.grantSecret }),
            (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
        );
        const replacement = await service.generate({ userId, sid: SID, grantId: replacementGrant.grantId, secret: replacementGrant.grantSecret, oldCode: initial.code });
        const replacementActivation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: replacement.pendingCodeId, activeCodeGeneration: 1 });
        await assert.rejects(
            () => service.activate({ userId, sid: SID, grantId: replacementActivation.grantId, secret: replacementActivation.grantSecret, pendingCodeId: replacement.pendingCodeId, code: replacement.code }),
            (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
        );
        await service.activate({ userId, sid: SID, grantId: replacementActivation.grantId, secret: replacementActivation.grantSecret, pendingCodeId: replacement.pendingCodeId, code: replacement.code, oldCode: initial.code });
        assertRecoveryStatus(await service.status({ userId }), { status: 'active', generation: 2, pendingCodeId: null, pendingExpiresAt: null });

        const remove = await grant(client, { userId, purpose: 'recovery_code_remove', activeCodeGeneration: 2 });
        await assert.rejects(
            () => service.remove({ userId, sid: SID, grantId: remove.grantId, secret: remove.grantSecret, oldCode: initial.code }),
            (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
        );
        await service.remove({ userId, sid: SID, grantId: remove.grantId, secret: remove.grantSecret, oldCode: replacement.code });
        assertRecoveryStatus(await service.status({ userId }), { status: 'unconfigured', generation: 2, pendingCodeId: null, pendingExpiresAt: null });
    } finally {
        client.release();
        await pool.end();
    }
});

test('obsolete sessions and credential generations cannot activate pending codes', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const service = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key' });
        const generated = await grant(client, { userId, purpose: 'recovery_code_generate' });
        const pending = await service.generate({ userId, sid: SID, grantId: generated.grantId, secret: generated.grantSecret });
        const sessionActivation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: pending.pendingCodeId });
        await client.query('UPDATE users SET active_session_id = $2::uuid WHERE id = $1', [userId, '33333333-3333-4333-8333-333333333333']);
        await assert.rejects(
            () => service.activate({ userId, sid: SID, grantId: sessionActivation.grantId, secret: sessionActivation.grantSecret, pendingCodeId: pending.pendingCodeId, code: pending.code }),
            /not valid|not available/i,
        );

        const credentialUserId = await seedStudent(client, '44444444-4444-4444-8444-444444444444');
        const credentialGenerated = await grant(client, { userId: credentialUserId, sid: '44444444-4444-4444-8444-444444444444', purpose: 'recovery_code_generate' });
        const credentialPending = await service.generate({ userId: credentialUserId, sid: '44444444-4444-4444-8444-444444444444', grantId: credentialGenerated.grantId, secret: credentialGenerated.grantSecret });
        const credentialActivation = await grant(client, { userId: credentialUserId, sid: '44444444-4444-4444-8444-444444444444', purpose: 'recovery_code_activate', pendingCodeId: credentialPending.pendingCodeId });
        await client.query('UPDATE users SET credential_generation = credential_generation + 1 WHERE id = $1', [credentialUserId]);
        await assert.rejects(
            () => service.activate({ userId: credentialUserId, sid: '44444444-4444-4444-8444-444444444444', grantId: credentialActivation.grantId, secret: credentialActivation.grantSecret, pendingCodeId: credentialPending.pendingCodeId, code: credentialPending.code }),
            /not valid|not available/i,
        );
    } finally {
        client.release();
        await pool.end();
    }
});

test('expired, obsolete-session, and competing activation attempts leave no second active code', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const service = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key' });
        const generated = await grant(client, { userId, purpose: 'recovery_code_generate' });
        const pending = await service.generate({ userId, sid: SID, grantId: generated.grantId, secret: generated.grantSecret });
        const expiredGrant = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: pending.pendingCodeId });
        await client.query("UPDATE student_auth_recovery_codes SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [pending.pendingCodeId]);
        await assert.rejects(
            () => service.activate({ userId, sid: SID, grantId: expiredGrant.grantId, secret: expiredGrant.grantSecret, pendingCodeId: pending.pendingCodeId, code: pending.code }),
            /not available/i,
        );

        const secondGenerate = await grant(client, { userId, purpose: 'recovery_code_generate' });
        const second = await service.generate({ userId, sid: SID, grantId: secondGenerate.grantId, secret: secondGenerate.grantSecret });
        const firstActivation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: second.pendingCodeId });
        const competingActivation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: second.pendingCodeId });
        const results = await Promise.allSettled([
            service.activate({ userId, sid: SID, grantId: firstActivation.grantId, secret: firstActivation.grantSecret, pendingCodeId: second.pendingCodeId, code: second.code }),
            service.activate({ userId, sid: SID, grantId: competingActivation.grantId, secret: competingActivation.grantSecret, pendingCodeId: second.pendingCodeId, code: second.code }),
        ]);
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        const active = await client.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM student_auth_recovery_codes WHERE user_id = $1 AND status = 'active'", [userId],
        );
        assert.equal(active.rows[0]!.count, 1);

        const replacement = await grant(client, { userId, purpose: 'recovery_code_generate', activeCodeGeneration: 2 });
        await client.query('UPDATE users SET active_session_id = $2::uuid WHERE id = $1', [userId, '33333333-3333-4333-8333-333333333333']);
        await assert.rejects(
            () => service.generate({ userId, sid: SID, grantId: replacement.grantId, secret: replacement.grantSecret, oldCode: second.code }),
            /not available/i,
        );
    } finally {
        client.release();
        await pool.end();
    }
});

test('revoked generating proof and provider-only post-recovery re-enrollment both fail closed', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const proofIdentityId = await seedProviderProof(client, userId, { policy: true });
        const service = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key', isProviderEnabled: () => true });
        const generated = await grant(client, { userId, purpose: 'recovery_code_generate', proofIdentityId });
        const pending = await service.generate({ userId, sid: SID, grantId: generated.grantId, secret: generated.grantSecret });
        const activation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: pending.pendingCodeId, proofIdentityId });
        await client.query('UPDATE student_auth_identities SET revoked_at = clock_timestamp() WHERE id = $1', [proofIdentityId]);
        await assert.rejects(
            () => service.activate({ userId, sid: SID, grantId: activation.grantId, secret: activation.grantSecret, pendingCodeId: pending.pendingCodeId, code: pending.code }),
            (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
        );

        await client.query('UPDATE users SET recovery_reenrollment_requires_password = true WHERE id = $1', [userId]);
        const providerOnly = await grant(client, { userId, purpose: 'recovery_code_generate', proofIdentityId });
        await assert.rejects(
            () => service.generate({ userId, sid: SID, grantId: providerOnly.grantId, secret: providerOnly.grantSecret }),
            (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
        );
        const passwordGrant = await grant(client, { userId, purpose: 'recovery_code_generate' });
        const restarted = await service.generate({ userId, sid: SID, grantId: passwordGrant.grantId, secret: passwordGrant.grantSecret });
        const passwordActivation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: restarted.pendingCodeId });
        await service.activate({ userId, sid: SID, grantId: passwordActivation.grantId, secret: passwordActivation.grantSecret, pendingCodeId: restarted.pendingCodeId, code: restarted.code });
        const marker = await client.query<{ recovery_reenrollment_requires_password: boolean }>(
            'SELECT recovery_reenrollment_requires_password FROM users WHERE id = $1', [userId],
        );
        assert.equal(marker.rows[0]!.recovery_reenrollment_requires_password, false);
    } finally {
        client.release();
        await pool.end();
    }
});

test('proof-backed recovery operations revalidate provider authority at action time', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const proofIdentityId = await seedProviderProof(client, userId, { policy: true });
        const conflict = (error: unknown) => (error as { code?: string }).code === 'CONFLICT';
        const gated = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key', isProviderEnabled: () => false });
        const live = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key', isProviderEnabled: () => true });
        const policyOf = async () => (await client.query<{ university_id: string }>(
            'SELECT university_id FROM student_auth_identities WHERE id = $1', [proofIdentityId],
        )).rows[0]!.university_id;
        // A grant issued while authority was live cannot consume once the
        // deployment gate flips, even though the identity row is intact.
        const gatedGenerate = await grant(client, { userId, purpose: 'recovery_code_generate', proofIdentityId });
        await assert.rejects(
            () => gated.generate({ userId, sid: SID, grantId: gatedGenerate.grantId, secret: gatedGenerate.grantSecret }),
            conflict,
        );
        // Password-backed grants never consult the gate.
        const passwordGrant = await grant(client, { userId, purpose: 'recovery_code_generate' });
        const pending = await gated.generate({ userId, sid: SID, grantId: passwordGrant.grantId, secret: passwordGrant.grantSecret });
        // A policy disabled after issuance blocks proof consumption.
        await client.query('UPDATE institution_login_policies SET enabled = false WHERE university_id = $1', [await policyOf()]);
        const disabledGenerate = await grant(client, { userId, purpose: 'recovery_code_generate', proofIdentityId });
        await assert.rejects(
            () => live.generate({ userId, sid: SID, grantId: disabledGenerate.grantId, secret: disabledGenerate.grantSecret }),
            conflict,
        );
        // An expired policy blocks activation while the pending code survives.
        await client.query(
            `UPDATE institution_login_policies SET enabled = true, approved_until = clock_timestamp() - interval '1 second'
             WHERE university_id = $1`, [await policyOf()],
        );
        const expiredActivate = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: pending.pendingCodeId, proofIdentityId });
        await assert.rejects(
            () => live.activate({ userId, sid: SID, grantId: expiredActivate.grantId, secret: expiredActivate.grantSecret, pendingCodeId: pending.pendingCodeId, code: pending.code }),
            conflict,
        );
        const survivor = await client.query<{ status: string }>('SELECT status FROM student_auth_recovery_codes WHERE id = $1', [pending.pendingCodeId]);
        assert.equal(survivor.rows[0]!.status, 'pending');
        // A tenant replaced mid-grant leaves a live policy the stale
        // identity can no longer log in with: the issuer pin rejects it.
        await client.query(
            `UPDATE institution_login_policies
             SET enabled = true, approved_until = clock_timestamp() + interval '30 days',
                 issuer = 'https://login.microsoftonline.com/replacement-tenant/v2.0'
             WHERE university_id = $1`, [await policyOf()],
        );
        const rotatedGenerate = await grant(client, { userId, purpose: 'recovery_code_generate', proofIdentityId });
        await assert.rejects(
            () => live.generate({ userId, sid: SID, grantId: rotatedGenerate.grantId, secret: rotatedGenerate.grantSecret }),
            conflict,
        );
    } finally {
        client.release();
        await pool.end();
    }
});

test('proof-backed recovery operations reject proofs after their university is deactivated', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const proofIdentityId = await seedProviderProof(client, userId, { policy: true });
        const live = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key', isProviderEnabled: () => true });
        const universityId = (await client.query<{ university_id: string }>(
            'SELECT university_id FROM student_auth_identities WHERE id = $1', [proofIdentityId],
        )).rows[0]!.university_id;
        // The grant is minted while authority is live; the university is
        // deactivated before consumption, with the policy row untouched.
        const proof = await grant(client, { userId, purpose: 'recovery_code_generate', proofIdentityId });
        await client.query('UPDATE universities SET is_active = false WHERE id = $1', [universityId]);
        await assert.rejects(
            () => live.generate({ userId, sid: SID, grantId: proof.grantId, secret: proof.grantSecret }),
            (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
        );
        // Password-backed grants never consult the university gate.
        const passwordGrant = await grant(client, { userId, purpose: 'recovery_code_generate' });
        const pending = await live.generate({ userId, sid: SID, grantId: passwordGrant.grantId, secret: passwordGrant.grantSecret });
        assert.ok(pending.pendingCodeId);
    } finally {
        client.release();
        await pool.end();
    }
});

test('proof-backed recovery operations reject proofs after institutional approval is withdrawn', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const proofIdentityId = await seedProviderProof(client, userId, { policy: true });
        const live = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key', isProviderEnabled: () => true });
        const universityId = (await client.query<{ university_id: string }>(
            'SELECT university_id FROM student_auth_identities WHERE id = $1', [proofIdentityId],
        )).rows[0]!.university_id;
        // The approver cannot be cleared while the policy stays enabled:
        // withdrawal disables with it, and login discovery then rejects
        // the policy — so proof consumption must reject the identity too.
        const proof = await grant(client, { userId, purpose: 'recovery_code_generate', proofIdentityId });
        const violation = await client.query(
            'UPDATE institution_login_policies SET approved_by = NULL WHERE university_id = $1', [universityId],
        ).then(() => null, (error: unknown) => error as { code?: string });
        assert.equal(violation?.code, '23514');
        await client.query(
            'UPDATE institution_login_policies SET enabled = false, approved_by = NULL WHERE university_id = $1', [universityId],
        );
        await assert.rejects(
            () => live.generate({ userId, sid: SID, grantId: proof.grantId, secret: proof.grantSecret }),
            (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
        );
    } finally {
        client.release();
        await pool.end();
    }
});

test('proof authority ends when only the identity mailbox domain is withdrawn', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const proofIdentityId = await seedProviderProof(client, userId, { policy: true });
        const live = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key', isProviderEnabled: () => true });
        const conflict = (error: unknown) => (error as { code?: string }).code === 'CONFLICT';
        const proof = await client.query<{ observed_email: string; university_id: string }>(
            'SELECT observed_email, university_id FROM student_auth_identities WHERE id = $1', [proofIdentityId],
        );
        const mailbox = proof.rows[0]!.observed_email;
        const mailboxDomain = mailbox.slice(mailbox.lastIndexOf('@') + 1);
        const universityId = proof.rows[0]!.university_id;
        const policyId = (await client.query<{ id: string }>(
            `SELECT policy.id FROM institution_login_policies policy
             JOIN student_auth_identities identity ON identity.university_id = policy.university_id
             WHERE identity.id = $1 AND policy.provider = 'microsoft'`, [proofIdentityId],
        )).rows[0]!.id;
        // A second live domain on the same policy: withdrawing it alone
        // must not disturb this identity's proof authority.
        const spare = `spare-${randomUUID().slice(0, 8)}.example.invalid`;
        await client.query('INSERT INTO institution_login_domains (domain, university_id, is_active) VALUES ($1, $2, true)', [spare, universityId]);
        await client.query(
            'INSERT INTO institution_login_domain_providers (domain, university_id, provider, policy_id) VALUES ($1, $2, $3, $4)',
            [spare, universityId, 'microsoft', policyId],
        );
        const baseline = await grant(client, { userId, purpose: 'recovery_code_generate', proofIdentityId });
        await live.generate({ userId, sid: SID, grantId: baseline.grantId, secret: baseline.grantSecret });
        await client.query('UPDATE institution_login_domains SET is_active = false WHERE domain = $1 AND university_id = $2', [spare, universityId]);
        const spareGone = await grant(client, { userId, purpose: 'recovery_code_generate', proofIdentityId });
        await live.generate({ userId, sid: SID, grantId: spareGone.grantId, secret: spareGone.grantSecret });
        const advertised = await live.status({ userId });
        assert.equal(advertised.status, 'pending', 'the provider-proven pending advertises while its proof is live');
        // Withdrawing the identity's own mailbox domain ends its proof
        // authority even though the policy still serves the spare domain:
        // a normal login for the stored mailbox would fail the same check.
        await client.query('UPDATE institution_login_domains SET is_active = true WHERE domain = $1 AND university_id = $2', [spare, universityId]);
        await client.query('UPDATE institution_login_domains SET is_active = false WHERE domain = $1 AND university_id = $2', [mailboxDomain, universityId]);
        const dead = await grant(client, { userId, purpose: 'recovery_code_generate', proofIdentityId });
        await assert.rejects(
            () => live.generate({ userId, sid: SID, grantId: dead.grantId, secret: dead.grantSecret }),
            conflict,
        );
        // Status mirrors the gate: the stale pending hides instead of
        // advertising an activation that can only be rejected.
        const hidden = await live.status({ userId });
        assert.equal(hidden.status, 'unconfigured');
        // ...and no fresh proof may start for it either.
        const reauth = new StudentReauthService({
            pool,
            attemptKey: Buffer.alloc(32, 7).toString('base64url'),
            completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'),
            isProviderEnabled: () => true,
            oidcForPolicy: () => { throw new Error('must not run'); },
        });
        await assert.rejects(() => reauth.start({ userId, sid: SID, purpose: 'link' }), /no longer valid/);
    } finally {
        client.release();
        await pool.end();
    }
});

test('fresh reauthentication skips a newer Microsoft identity without an observed email', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        // Pin the intended recency order at insert: linked_at is immutable,
        // so the email identity links a minute before the email-less one.
        const emailIdentityId = await seedProviderProof(client, userId, { policy: true, linkedAt: new Date(Date.now() - 60_000).toISOString() });
        const email = (await client.query<{ observed_email: string }>(
            'SELECT observed_email FROM student_auth_identities WHERE id = $1', [emailIdentityId],
        )).rows[0]!.observed_email;
        const bareIdentityId = await seedProviderProof(client, userId, { policy: true, canonical: false });
        await client.query('UPDATE student_auth_identities SET observed_email = NULL WHERE id = $1', [bareIdentityId]);
        let loginHint: string | null = null;
        const reauth = new StudentReauthService({
            pool,
            attemptKey: Buffer.alloc(32, 7).toString('base64url'),
            completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'),
            isProviderEnabled: () => true,
            oidcForPolicy: () => ({ authorizeFresh: async (input: { loginHint: string }) => { loginHint = input.loginHint; return new URL('https://provider.example.invalid/fresh'); } }) as never,
        });
        const started = await reauth.start({ userId, sid: SID, purpose: 'link' });
        assert.ok(started.attemptId);
        assert.equal(loginHint, email);
        const proof = await client.query<{ proof_identity_id: string }>(
            'SELECT proof_identity_id FROM student_auth_reauth_attempts WHERE id = $1', [started.attemptId],
        );
        assert.equal(proof.rows[0]!.proof_identity_id, emailIdentityId);
    } finally {
        client.release();
        await pool.end();
    }
});

test('fresh reauthentication prefers the Microsoft identity that issued the session', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        // Both siblings are authorized Microsoft proof identities; the
        // older one issued the current session while the newer one may no
        // longer be accessible to the user.
        const olderIdentityId = await seedProviderProof(client, userId, { policy: true, linkedAt: new Date(Date.now() - 60_000).toISOString() });
        const olderEmail = (await client.query<{ observed_email: string }>(
            'SELECT observed_email FROM student_auth_identities WHERE id = $1', [olderIdentityId],
        )).rows[0]!.observed_email;
        await seedProviderProof(client, userId, { policy: true, canonical: false });
        await client.query('UPDATE users SET active_session_auth_identity_id = $2 WHERE id = $1', [userId, olderIdentityId]);
        let loginHint: string | null = null;
        const reauth = new StudentReauthService({
            pool,
            attemptKey: Buffer.alloc(32, 7).toString('base64url'),
            completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'),
            isProviderEnabled: () => true,
            oidcForPolicy: () => ({ authorizeFresh: async (input: { loginHint: string }) => { loginHint = input.loginHint; return new URL('https://provider.example.invalid/fresh'); } }) as never,
        });
        const started = await reauth.start({ userId, sid: SID, purpose: 'link' });
        assert.ok(started.attemptId);
        assert.equal(loginHint, olderEmail, 'the session-issuing sibling proves the user still holds it');
        const proof = await client.query<{ proof_identity_id: string }>(
            'SELECT proof_identity_id FROM student_auth_reauth_attempts WHERE id = $1', [started.attemptId],
        );
        assert.equal(proof.rows[0]!.proof_identity_id, olderIdentityId);
    } finally {
        client.release();
        await pool.end();
    }
});

test('reauth finish signals retryable while the winner still redeems', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        await seedProviderProof(client, userId, { policy: true });
        const reauth = new StudentReauthService({
            pool,
            attemptKey: Buffer.alloc(32, 7).toString('base64url'),
            completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'),
            isProviderEnabled: () => true,
            oidcForPolicy: () => ({ authorizeFresh: async () => new URL('https://provider.example.invalid/fresh') }) as never,
        });
        const started = await reauth.start({ userId, sid: SID, purpose: 'link' });
        const callbackCookie = started.callbackCookie;
        await client.query('UPDATE student_auth_reauth_attempts SET status = \'processing\' WHERE id = $1', [started.attemptId]);
        // The bound owner learns the attempt is still redeeming and waits
        // instead of failing; anyone without the browser binding gets the
        // uniform terminal shape with no state signal.
        await assert.rejects(
            () => reauth.finish({ userId, sid: SID, attemptId: started.attemptId, callbackCookie }),
            (error: unknown) => {
                assert.ok(error instanceof Error && /still completing/.test(error.message));
                assert.deepEqual((error as { details?: unknown }).details, { retryable: true });
                return true;
            },
        );
        await assert.rejects(
            () => reauth.finish({ userId, sid: SID, attemptId: started.attemptId, callbackCookie: 'wrong-cookie' }),
            (error: unknown) => {
                assert.ok(error instanceof Error && /no longer valid/.test(error.message));
                assert.equal((error as { details?: unknown }).details, undefined);
                return true;
            },
        );
    } finally {
        client.release();
        await pool.end();
    }
});

test('fresh reauthentication refuses identities whose institutional approval was withdrawn', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const proofIdentityId = await seedProviderProof(client, userId, { policy: true });
        const universityId = (await client.query<{ university_id: string }>(
            'SELECT university_id FROM student_auth_identities WHERE id = $1', [proofIdentityId],
        )).rows[0]!.university_id;
        await client.query('UPDATE institution_login_policies SET enabled = false, approved_by = NULL WHERE university_id = $1', [universityId]);
        const reauth = new StudentReauthService({
            pool,
            attemptKey: Buffer.alloc(32, 7).toString('base64url'),
            completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'),
            isProviderEnabled: () => true,
            oidcForPolicy: () => { throw new Error('must not run'); },
        });
        // Approval withdrawal (disabled with the approver cleared) removes
        // the identity from login authority: no fresh proof may start.
        await assert.rejects(
            () => reauth.start({ userId, sid: SID, purpose: 'link' }),
            /no longer valid/,
        );
    } finally {
        client.release();
        await pool.end();
    }
});

test('concurrent duplicate reauth callbacks redeem the one-use code exactly once', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const proofIdentityId = await seedProviderProof(client, userId, { policy: true });
        const identity = (await client.query<{ issuer: string; subject: string }>(
            'SELECT issuer, subject FROM student_auth_identities WHERE id = $1', [proofIdentityId],
        )).rows[0]!;
        let captured: { state: string } | null = null;
        let redemptions = 0;
        const reauth = new StudentReauthService({
            pool,
            attemptKey: Buffer.alloc(32, 7).toString('base64url'),
            completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'),
            isProviderEnabled: () => true,
            oidcForPolicy: () => ({
                authorizeFresh: async (input: { state: string }) => {
                    captured = input;
                    return new URL('https://provider.example.invalid/fresh');
                },
                redeemFresh: async () => {
                    redemptions += 1;
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    return {
                        provider: 'microsoft' as const, issuer: identity.issuer, subject: identity.subject,
                        email: 'student@example.invalid', mailboxVerified: true, realm: 'realm',
                        schoolMembershipAttested: false, objectId: 'object', authTime: Math.floor(Date.now() / 1000),
                    };
                },
            }) as never,
        });
        const started = await reauth.start({ userId, sid: SID, purpose: 'link' });
        const callbackUrl = new URL(`https://api.example.invalid/callback?state=${captured!.state}&code=code`);
        // The same provider callback delivered twice: the loser observes
        // the winner's processing claim and never redeems, so the
        // winner's locked recheck still finds its own claim.
        const [first, second] = await Promise.allSettled([
            reauth.callback({ callbackUrl, callbackCookie: started.callbackCookie }),
            reauth.callback({ callbackUrl, callbackCookie: started.callbackCookie }),
        ]);
        assert.equal([first, second].filter((result) => result.status === 'fulfilled').length, 1);
        const rejected = [first, second].find((result) => result.status === 'rejected') as PromiseRejectedResult;
        assert.match(String(rejected.reason), /no longer valid/);
        assert.equal(redemptions, 1);
        const status = await client.query<{ status: string }>(
            'SELECT status FROM student_auth_reauth_attempts WHERE id = $1', [started.attemptId],
        );
        assert.equal(status.rows[0]!.status, 'ready');
    } finally {
        client.release();
        await pool.end();
    }
});

test('reauth finish rechecks proof authority before minting the grant', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const proofIdentityId = await seedProviderProof(client, userId, { policy: true });
        const identity = (await client.query<{ issuer: string; subject: string; observed_email: string; university_id: string }>(
            'SELECT issuer, subject, observed_email, university_id FROM student_auth_identities WHERE id = $1', [proofIdentityId],
        )).rows[0]!;
        let captured: { state: string } | null = null;
        const reauth = new StudentReauthService({
            pool,
            attemptKey: Buffer.alloc(32, 7).toString('base64url'),
            completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'),
            isProviderEnabled: () => true,
            oidcForPolicy: () => ({
                authorizeFresh: async (input: { state: string }) => {
                    captured = input;
                    return new URL('https://provider.example.invalid/fresh');
                },
                redeemFresh: async () => ({
                    provider: 'microsoft' as const, issuer: identity.issuer, subject: identity.subject,
                    email: 'student@example.invalid', mailboxVerified: true, realm: 'realm',
                    schoolMembershipAttested: false, objectId: 'object', authTime: Math.floor(Date.now() / 1000),
                }),
            }) as never,
        });
        // Happy path first: an undisturbed ceremony mints its grant.
        const good = await reauth.start({ userId, sid: SID, purpose: 'link' });
        await reauth.callback({ callbackUrl: new URL(`https://api.example.invalid/callback?state=${captured!.state}&code=code`), callbackCookie: good.callbackCookie });
        const granted = await reauth.finish({ userId, sid: SID, attemptId: good.attemptId, callbackCookie: good.callbackCookie });
        assert.ok(granted.grantId);
        // Second ceremony: the proof identity's mailbox domain is
        // withdrawn after the proof validates but before finish. The
        // pinned policy row still passes, yet every grant consumer would
        // reject the minted grant — so finish fails the ceremony instead
        // of issuing an apparently successful confirmation.
        const drifted = await reauth.start({ userId, sid: SID, purpose: 'link' });
        await reauth.callback({ callbackUrl: new URL(`https://api.example.invalid/callback?state=${captured!.state}&code=code`), callbackCookie: drifted.callbackCookie });
        const mailboxDomain = identity.observed_email.slice(identity.observed_email.lastIndexOf('@') + 1);
        await client.query('UPDATE institution_login_domains SET is_active = false WHERE domain = $1 AND university_id = $2', [mailboxDomain, identity.university_id]);
        await assert.rejects(
            () => reauth.finish({ userId, sid: SID, attemptId: drifted.attemptId, callbackCookie: drifted.callbackCookie }),
            /no longer valid/,
        );
        const status = await client.query<{ status: string }>(
            'SELECT status FROM student_auth_reauth_attempts WHERE id = $1', [drifted.attemptId],
        );
        assert.equal(status.rows[0]!.status, 'ready', 'the failed finish must not consume the attempt or mint a grant');
        const grants = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM student_auth_action_grants WHERE user_id = $1 AND purpose = 'link'`, [userId],
        );
        assert.equal(grants.rows[0]!.count, '1', 'only the undisturbed ceremony mints a grant');
    } finally {
        client.release();
        await pool.end();
    }
});

test('terminalizeFailedAttempt marks the dead reauth attempt failed and scrubs its material', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const reauth = new StudentReauthService({
            pool,
            attemptKey: Buffer.alloc(32, 7).toString('base64url'),
            completionUrl: new URL('https://app.example.invalid/auth/student/sso/complete'),
            isProviderEnabled: () => true,
            oidcForPolicy: () => { throw new Error('must not run'); },
        });
        const pending = (await client.query<{ id: string }>(
            `INSERT INTO student_auth_reauth_attempts (user_id, sid, credential_generation, purpose, state_hash, callback_cookie_hash, encrypted_verifier, nonce, status, expires_at)
             VALUES ($1, $2::uuid, 0, 'link', 'state', 'cookie', 'verifier', 'nonce', 'pending', clock_timestamp() + interval '5 minutes') RETURNING id`,
            [userId, SID],
        )).rows[0]!.id;
        // Ready rows carry a validated proof identity; the terminalize
        // guard must leave them finishable.
        const readyProof = await seedProviderProof(client, userId);
        const ready = (await client.query<{ id: string }>(
            `INSERT INTO student_auth_reauth_attempts (user_id, sid, credential_generation, purpose, state_hash, callback_cookie_hash, encrypted_verifier, nonce, proof_identity_id, status, expires_at)
             VALUES ($1, $2::uuid, 0, 'link', 'ready-state', 'ready-cookie', 'ready-verifier', 'ready-nonce', $3, 'ready', clock_timestamp() + interval '5 minutes') RETURNING id`,
            [userId, SID, readyProof],
        )).rows[0]!.id;
        const processing = (await client.query<{ id: string }>(
            `INSERT INTO student_auth_reauth_attempts (user_id, sid, credential_generation, purpose, state_hash, callback_cookie_hash, encrypted_verifier, nonce, proof_identity_id, status, expires_at)
             VALUES ($1, $2::uuid, 0, 'link', 'processing-state', 'processing-cookie', 'processing-verifier', 'processing-nonce', $3, 'processing', clock_timestamp() + interval '5 minutes') RETURNING id`,
            [userId, SID, readyProof],
        )).rows[0]!.id;
        await reauth.terminalizeFailedAttempt(pending);
        await reauth.terminalizeFailedAttempt(ready);
        await reauth.terminalizeFailedAttempt(processing);
        const rows = await client.query<{ id: string; status: string; consumed_at: Date | null; state_hash: string | null; callback_cookie_hash: string | null; encrypted_verifier: string | null; nonce: string | null }>(
            'SELECT id, status, consumed_at, state_hash, callback_cookie_hash, encrypted_verifier, nonce FROM student_auth_reauth_attempts WHERE id = ANY($1::uuid[])',
            [[pending, ready, processing]],
        );
        const dead = rows.rows.find(row => row.id === pending)!;
        assert.deepEqual(
            { status: dead.status, state: dead.state_hash, cookie: dead.callback_cookie_hash, verifier: dead.encrypted_verifier, nonce: dead.nonce },
            { status: 'failed', state: null, cookie: null, verifier: null, nonce: null },
        );
        assert.ok(dead.consumed_at instanceof Date);
        // Ready rows are never touched: a callback that already validated
        // keeps its finishable state.
        assert.equal(rows.rows.find(row => row.id === ready)!.status, 'ready');
        // A claimed row belongs to its in-flight redemption: failure
        // handling must not terminalize it either.
        assert.equal(rows.rows.find(row => row.id === processing)!.status, 'processing');
        // Dead-attempt dispatch: terminal and missing rows read dead so a
        // delayed provider callback lands bounded; live rows never do.
        assert.equal(await reauth.isDeadAttempt(pending), true);
        assert.equal(await reauth.isDeadAttempt(ready), false);
        assert.equal(await reauth.isDeadAttempt(processing), false);
        assert.equal(await reauth.isDeadAttempt(randomUUID()), true);
        // Duplicate dispatch: claimed and validated rows read in flight
        // so the loser's redirect retains the winner's binding.
        assert.equal(await reauth.isInFlightAttempt(pending), false);
        assert.equal(await reauth.isInFlightAttempt(processing), true);
        assert.equal(await reauth.isInFlightAttempt(ready), true);
        assert.equal(await reauth.isInFlightAttempt(randomUUID()), false);
    } finally {
        client.release();
        await pool.end();
    }
});

test('credential-free activation, replacement, and removal notices run after commit', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const events: string[] = [];
        const service = new StudentRecoveryCodeService({
            pool,
            codeKey: 'test-recovery-code-key',
            notify: async (_email, event) => {
                events.push(event);
                if (event === 'removed') throw new Error('simulated email transport failure');
                return { success: event !== 'replaced' };
            },
        });
        const firstGrant = await grant(client, { userId, purpose: 'recovery_code_generate' });
        const first = await service.generate({ userId, sid: SID, grantId: firstGrant.grantId, secret: firstGrant.grantSecret });
        const firstActivation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: first.pendingCodeId });
        await service.activate({ userId, sid: SID, grantId: firstActivation.grantId, secret: firstActivation.grantSecret, pendingCodeId: first.pendingCodeId, code: first.code });

        const replacementGrant = await grant(client, { userId, purpose: 'recovery_code_generate', activeCodeGeneration: 1 });
        const replacement = await service.generate({ userId, sid: SID, grantId: replacementGrant.grantId, secret: replacementGrant.grantSecret, oldCode: first.code });
        const replacementActivation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: replacement.pendingCodeId, activeCodeGeneration: 1 });
        await service.activate({ userId, sid: SID, grantId: replacementActivation.grantId, secret: replacementActivation.grantSecret, pendingCodeId: replacement.pendingCodeId, code: replacement.code, oldCode: first.code });
        assertRecoveryStatus(await service.status({ userId }), { status: 'active', generation: 2, pendingCodeId: null, pendingExpiresAt: null }, 'failed delivery must not roll back replacement');

        const removal = await grant(client, { userId, purpose: 'recovery_code_remove', activeCodeGeneration: 2 });
        await service.remove({ userId, sid: SID, grantId: removal.grantId, secret: removal.grantSecret, oldCode: replacement.code });
        assertRecoveryStatus(await service.status({ userId }), { status: 'unconfigured', generation: 2, pendingCodeId: null, pendingExpiresAt: null });
        assert.deepEqual(events, ['activated', 'replaced', 'removed']);
    } finally {
        client.release();
        await pool.end();
    }
});

test('only the owner current session can cancel its pending code and active code survives', async () => {
    const pool = createTestPool(); const client = await pool.connect();
    try {
        const userId = await seedStudent(client); const otherUser = await seedStudent(client, '33333333-3333-4333-8333-333333333333');
        const service = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key' });
        const firstGrant = await grant(client, { userId, purpose: 'recovery_code_generate' });
        const first = await service.generate({ userId, sid: SID, grantId: firstGrant.grantId, secret: firstGrant.grantSecret });
        const firstActivation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: first.pendingCodeId });
        await service.activate({ userId, sid: SID, grantId: firstActivation.grantId, secret: firstActivation.grantSecret, pendingCodeId: first.pendingCodeId, code: first.code });
        const replacementGrant = await grant(client, { userId, purpose: 'recovery_code_generate', activeCodeGeneration: 1 });
        const pending = await service.generate({ userId, sid: SID, grantId: replacementGrant.grantId, secret: replacementGrant.grantSecret, oldCode: first.code });
        await assert.rejects(service.cancel({ userId: otherUser, sid: '33333333-3333-4333-8333-333333333333', pendingCodeId: pending.pendingCodeId }));
        await assert.rejects(service.cancel({ userId, sid: '33333333-3333-4333-8333-333333333333', pendingCodeId: pending.pendingCodeId }));
        const activeId = (await client.query<{ id: string }>("SELECT id FROM student_auth_recovery_codes WHERE user_id=$1 AND status='active'", [userId])).rows[0]!.id;
        await assert.rejects(service.cancel({ userId, sid: SID, pendingCodeId: activeId }));
        await service.cancel({ userId, sid: SID, pendingCodeId: pending.pendingCodeId });
        const rows = await client.query<{ status: string; code_digest: string | null; pending_sid: string | null; pending_credential_generation: string | null; pending_proof_identity_id: string | null }>("SELECT status, code_digest, pending_sid, pending_credential_generation, pending_proof_identity_id FROM student_auth_recovery_codes WHERE user_id=$1 ORDER BY generation", [userId]);
        assert.deepEqual(rows.rows.map(row => row.status), ['active', 'revoked']);
        assert.notEqual(rows.rows[0]!.code_digest, null); assert.equal(rows.rows[1]!.code_digest, null);
        assert.deepEqual(
            { sid: rows.rows[1]!.pending_sid, generation: rows.rows[1]!.pending_credential_generation, proof: rows.rows[1]!.pending_proof_identity_id },
            { sid: null, generation: null, proof: null },
            'cancelled pending codes lose their activation bindings with the digest',
        );
    } finally { client.release(); await pool.end(); }
});

test('status hides pending codes whose session binding no longer matches', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const service = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key' });
        // A pending code with no active fallback: session replacement
        // stops advertising it instead of sending the user through a
        // fresh proof that must deterministically fail.
        const bare = await seedStudent(client);
        const bareGrant = await grant(client, { userId: bare, purpose: 'recovery_code_generate' });
        await service.generate({ userId: bare, sid: SID, grantId: bareGrant.grantId, secret: bareGrant.grantSecret });
        await client.query('UPDATE users SET active_session_id = $2::uuid, credential_generation = credential_generation + 1 WHERE id = $1', [bare, randomUUID()]);
        assertRecoveryStatus(await service.status({ userId: bare }), { status: 'unconfigured', generation: 1, pendingCodeId: null, pendingExpiresAt: null });
        // A stale pending replacement must not shadow the still-valid
        // older active code either.
        const userId = await seedStudent(client);
        const firstGrant = await grant(client, { userId, purpose: 'recovery_code_generate' });
        const first = await service.generate({ userId, sid: SID, grantId: firstGrant.grantId, secret: firstGrant.grantSecret });
        const firstActivation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: first.pendingCodeId });
        await service.activate({ userId, sid: SID, grantId: firstActivation.grantId, secret: firstActivation.grantSecret, pendingCodeId: first.pendingCodeId, code: first.code });
        const replacementGrant = await grant(client, { userId, purpose: 'recovery_code_generate', activeCodeGeneration: 1 });
        await service.generate({ userId, sid: SID, grantId: replacementGrant.grantId, secret: replacementGrant.grantSecret, oldCode: first.code });
        await client.query('UPDATE users SET active_session_id = $2::uuid, credential_generation = credential_generation + 1 WHERE id = $1', [userId, randomUUID()]);
        assertRecoveryStatus(await service.status({ userId }), { status: 'active', generation: 1, pendingCodeId: null, pendingExpiresAt: null });
    } finally { client.release(); await pool.end(); }
});

test('status hides pending codes whose provider proof lost login authority', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const live = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key', isProviderEnabled: () => true });
        const gated = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key', isProviderEnabled: () => false });
        const userId = await seedStudent(client);
        const proofIdentityId = await seedProviderProof(client, userId, { policy: true });
        // An active code plus a provider-proven replacement: while the
        // proof is live the pending candidate advertises.
        const firstGrant = await grant(client, { userId, purpose: 'recovery_code_generate' });
        const first = await live.generate({ userId, sid: SID, grantId: firstGrant.grantId, secret: firstGrant.grantSecret });
        const firstActivation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: first.pendingCodeId });
        await live.activate({ userId, sid: SID, grantId: firstActivation.grantId, secret: firstActivation.grantSecret, pendingCodeId: first.pendingCodeId, code: first.code });
        const replacementGrant = await grant(client, { userId, purpose: 'recovery_code_generate', activeCodeGeneration: 1, proofIdentityId });
        const replacement = await live.generate({ userId, sid: SID, grantId: replacementGrant.grantId, secret: replacementGrant.grantSecret, oldCode: first.code });
        assert.equal(first.generation, 1, 'generate returns the pending generation for ambiguous-activation reconciliation');
        assert.equal(replacement.generation, 2, 'generate returns the pending generation for ambiguous-activation reconciliation');
        assertRecoveryStatus(await live.status({ userId }), { status: 'pending', generation: 2, pendingCodeId: replacement.pendingCodeId, pendingExpiresAt: replacement.expiresAt });
        // A deployment-wide provider rollback hides the candidate that
        // activate() would now deterministically reject.
        assertRecoveryStatus(await gated.status({ userId }), { status: 'active', generation: 1, pendingCodeId: null, pendingExpiresAt: null });
        // Unlinking the proof identity does the same permanently: the
        // dead pending must not shadow the still-valid active code.
        await client.query('UPDATE student_auth_identities SET revoked_at = clock_timestamp() WHERE id = $1', [proofIdentityId]);
        assertRecoveryStatus(await live.status({ userId }), { status: 'active', generation: 1, pendingCodeId: null, pendingExpiresAt: null });
    } finally { client.release(); await pool.end(); }
});

test('consumed recovery-code rows accept the one-way binding scrub without replay', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        // Legacy pre-076 shape: consumed but still carrying bindings.
        const row = (await client.query<{ id: string }>(
            `INSERT INTO student_auth_recovery_codes (user_id, generation, status, consumed_at, pending_sid, pending_credential_generation)
             VALUES ($1, 0, 'consumed', clock_timestamp(), $2::uuid, 0) RETURNING id`,
            [userId, SID],
        )).rows[0]!.id;
        // Migration 076's backfill shape: null the bindings in place.
        // Before the consumed-to-consumed transition, the trigger aborted
        // this on the very rows the migration targets.
        await client.query(
            `UPDATE student_auth_recovery_codes
             SET pending_sid = NULL, pending_credential_generation = NULL, pending_proof_identity_id = NULL
             WHERE id = $1`, [row],
        );
        const scrubbed = await client.query<{ status: string; pending_sid: string | null; pending_credential_generation: string | null; pending_proof_identity_id: string | null }>(
            'SELECT status, pending_sid, pending_credential_generation, pending_proof_identity_id FROM student_auth_recovery_codes WHERE id = $1', [row],
        );
        assert.deepEqual(scrubbed.rows[0], { status: 'consumed', pending_sid: null, pending_credential_generation: null, pending_proof_identity_id: null });
        // The terminal guard still holds: consumed rows cannot replay.
        await assert.rejects(
            client.query(`UPDATE student_auth_recovery_codes SET status = 'active' WHERE id = $1`, [row]),
            /Terminal recovery codes cannot be replayed/,
        );
    } finally { client.release(); await pool.end(); }
});

test('a simulated recovery transaction serializes against replacement generation and clears pending state', async () => {
    const pool = createTestPool();
    const setup = await pool.connect();
    try {
        const userId = await seedStudent(setup);
        const service = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key', notify: async () => ({ success: true }) });
        const firstGrant = await grant(setup, { userId, purpose: 'recovery_code_generate' });
        const first = await service.generate({ userId, sid: SID, grantId: firstGrant.grantId, secret: firstGrant.grantSecret });
        const firstActivation = await grant(setup, { userId, purpose: 'recovery_code_activate', pendingCodeId: first.pendingCodeId });
        await service.activate({ userId, sid: SID, grantId: firstActivation.grantId, secret: firstActivation.grantSecret, pendingCodeId: first.pendingCodeId, code: first.code });
        const replacementGrant = await grant(setup, { userId, purpose: 'recovery_code_generate', activeCodeGeneration: 1 });

        const simulatedRecovery = async (): Promise<void> => {
            const tx = await pool.connect();
            try {
                await tx.query('BEGIN');
                await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
                await tx.query(
                    `UPDATE student_auth_recovery_codes
                     SET status = 'consumed', code_digest = NULL, consumed_at = clock_timestamp()
                     WHERE user_id = $1 AND status = 'active'`,
                    [userId],
                );
                // Task 5 must perform this in its recovery/password-setup
                // transaction; without it, a pre-recovery replacement could
                // become a valid new recovery credential after recovery.
                // The simulation mirrors complete(): terminalization scrubs
                // the pending-only activation bindings with the digest.
                await tx.query(
                    `UPDATE student_auth_recovery_codes
                     SET status = 'revoked', code_digest = NULL, expires_at = NULL, revoked_at = clock_timestamp(),
                         pending_sid = NULL, pending_credential_generation = NULL, pending_proof_identity_id = NULL
                     WHERE user_id = $1 AND status = 'pending'`,
                    [userId],
                );
                await tx.query('COMMIT');
            } catch (error) {
                await tx.query('ROLLBACK').catch(() => undefined);
                throw error;
            } finally {
                tx.release();
            }
        };

        const results = await Promise.allSettled([
            service.generate({ userId, sid: SID, grantId: replacementGrant.grantId, secret: replacementGrant.grantSecret, oldCode: first.code }),
            simulatedRecovery(),
        ]);
        assert.ok(results.some((result) => result.status === 'fulfilled'));
        const live = await setup.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM student_auth_recovery_codes WHERE user_id = $1 AND status IN ('active', 'pending')",
            [userId],
        );
        assert.equal(live.rows[0]!.count, 0);
    } finally {
        setup.release();
        await pool.end();
    }
});
