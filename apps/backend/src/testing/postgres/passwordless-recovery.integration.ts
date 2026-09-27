import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { issueActionGrant } from '../../services/auth/student-action-grant.service.js';
import { StudentRecoveryCodeService } from '../../services/auth/student-recovery-code.service.js';
import { StudentAccountRecoveryService } from '../../services/auth/student-account-recovery.service.js';
import { createTestPool } from './test-database.js';

const SID = '22222222-2222-4222-8222-222222222222';

async function seedStudent(client: PoolClient, sid = SID): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const user = await client.query<{ id: string }>(
        `INSERT INTO users (email, role, active_session_id)
         VALUES ($1, 'student', $2::uuid) RETURNING id`,
        [`recovery-${suffix}@example.invalid`, sid],
    );
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
        const decoy = await service.start({ email: `unknown-${randomUUID().slice(0, 8)}@example.invalid`, purpose: 'lost_access' });
        const committed = await service.start({ email: account.email, purpose: 'compromise' });
        const decoyMs = Date.parse(decoy.expiresAt);
        const committedMs = Date.parse(committed.expiresAt);
        assert.ok(Number.isFinite(decoyMs) && Number.isFinite(committedMs));
        // Both derive from the same server clock plus the shared mailbox
        // TTL: neither clock skew nor the shorter OTP window may mark a
        // real attempt.
        assert.ok(Math.abs(decoyMs - committedMs) < 30_000, `decoy and committed expiries must be indistinguishable (delta ${Math.abs(decoyMs - committedMs)}ms)`);
        for (const ms of [decoyMs, committedMs]) {
            const ttlMs = ms - Date.now();
            assert.ok(ttlMs > 4 * 60 * 1000 && ttlMs <= 6 * 60 * 1000, `expiry must sit on the shared mailbox TTL (saw ${Math.round(ttlMs / 1000)}s)`);
        }
        assert.deepEqual(deliveries, [account.email]);
        const decoyRows = await client.query('SELECT id FROM student_auth_recovery_attempts WHERE id = $1', [decoy.attemptId]);
        assert.equal(decoyRows.rowCount, 0, 'decoy handles persist nothing');
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

test('recovery terminal failure writers scrub superseded and rejected-at-verification secrets immediately', async () => {
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

        await assert.rejects(() => service.verify({
            attemptId: second.attemptId, secret: second.secret, code: `${account.code}-wrong`, otp,
        }));
        const rejected = await client.query<{ status: string; secret_hash: string | null }>(
            'SELECT status, secret_hash FROM student_auth_recovery_attempts WHERE id = $1', [second.attemptId],
        );
        assert.deepEqual(rejected.rows[0], { status: 'failed', secret_hash: null },
            'a rejected recovery verification immediately scrubs its terminal secret');
    } finally {
        client.release();
        await pool.end();
    }
});

test('recovery completion immediately scrubs invalidated sibling recovery and reauthentication attempts', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const account = await seedRecoverableStudent(client);
        const proofIdentityId = await seedProviderProof(client, account.userId);
        let otp = '';
        const service = new StudentAccountRecoveryService({
            pool, recoveryCodeKey: 'test-recovery-code-key',
            deliverOtp: async (_email, delivered) => { otp = delivered; return { success: true }; },
            validatePassword: () => ({ valid: true, errors: [] }), hashPassword: async () => 'recovered-password-hash',
        });
        const started = await service.start({ email: account.email, purpose: 'lost_access' });
        await service.verify({ attemptId: started.attemptId, secret: started.secret, code: account.code, otp });
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

        await client.query("UPDATE student_auth_recovery_codes SET status = 'active', expires_at = NULL, activated_at = clock_timestamp() WHERE user_id = $1 AND status = 'pending'", [account.userId]);
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

async function seedProviderProof(client: PoolClient, userId: string, options: { policy?: boolean } = {}): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const university = await client.query<{ id: string }>(
        'INSERT INTO universities (name, is_active) VALUES ($1, true) RETURNING id',
        [`Recovery proof ${suffix}`],
    );
    const identity = await client.query<{ id: string }>(
        `INSERT INTO student_auth_identities
             (user_id, university_id, provider, issuer, subject, observed_email)
         VALUES ($1, $2, 'microsoft', $3, $4, $5) RETURNING id`,
        [userId, university.rows[0]!.id, `https://issuer.example.invalid/${suffix}`, `subject-${suffix}`, `recovery-${suffix}@example.invalid`],
    );
    // Proof consumption revalidates the identity's currently live policy,
    // so proof-consumption tests opt into one; other callers seed their
    // own policy or none at all.
    if (options.policy === true) {
        const admin = await client.query<{ id: string }>(
            'INSERT INTO users (email, role) VALUES ($1, $2) RETURNING id',
            [`recovery-proof-admin-${suffix}@example.invalid`, 'admin'],
        );
        await client.query(
            `INSERT INTO institution_login_policies
                 (university_id, provider, issuer, provider_realm, version, enabled, approved_until, approved_by, school_assertion_days)
             VALUES ($1, 'microsoft', $2, $3, 1, true, clock_timestamp() + interval '30 days', $4, 90)`,
            [university.rows[0]!.id, `https://issuer.example.invalid/${suffix}`, suffix, admin.rows[0]!.id],
        );
    }
    return identity.rows[0]!.id;
}

async function grant(
    client: PoolClient,
    input: { userId: string; sid?: string; purpose: 'recovery_code_generate' | 'recovery_code_activate' | 'recovery_code_remove'; pendingCodeId?: string; activeCodeGeneration?: number; proofIdentityId?: string },
) {
    return issueActionGrant(client, {
        userId: input.userId,
        sid: input.sid ?? SID,
        purpose: input.purpose,
        credentialGeneration: 0,
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
        assert.equal((await service.status({ userId })).status, 'pending');

        const activation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: pending.pendingCodeId });
        await service.activate({
            userId, sid: SID, grantId: activation.grantId, secret: activation.grantSecret,
            pendingCodeId: pending.pendingCodeId, code: pending.code,
        });
        assert.deepEqual(await service.status({ userId }), { status: 'active', generation: 1, pendingCodeId: null });
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
        assert.deepEqual(await service.status({ userId }), { status: 'active', generation: 1, pendingCodeId: null });
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
        assert.deepEqual(await service.status({ userId }), { status: 'active', generation: 2, pendingCodeId: null });

        const remove = await grant(client, { userId, purpose: 'recovery_code_remove', activeCodeGeneration: 2 });
        await assert.rejects(
            () => service.remove({ userId, sid: SID, grantId: remove.grantId, secret: remove.grantSecret, oldCode: initial.code }),
            (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
        );
        await service.remove({ userId, sid: SID, grantId: remove.grantId, secret: remove.grantSecret, oldCode: replacement.code });
        assert.deepEqual(await service.status({ userId }), { status: 'unconfigured', generation: 2, pendingCodeId: null });
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
        assert.deepEqual(await service.status({ userId }), { status: 'active', generation: 2, pendingCodeId: null }, 'failed delivery must not roll back replacement');

        const removal = await grant(client, { userId, purpose: 'recovery_code_remove', activeCodeGeneration: 2 });
        await service.remove({ userId, sid: SID, grantId: removal.grantId, secret: removal.grantSecret, oldCode: replacement.code });
        assert.deepEqual(await service.status({ userId }), { status: 'unconfigured', generation: 2, pendingCodeId: null });
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
        const rows = await client.query<{ status: string; code_digest: string | null }>("SELECT status, code_digest FROM student_auth_recovery_codes WHERE user_id=$1 ORDER BY generation", [userId]);
        assert.deepEqual(rows.rows.map(row => row.status), ['active', 'revoked']);
        assert.notEqual(rows.rows[0]!.code_digest, null); assert.equal(rows.rows[1]!.code_digest, null);
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
                await tx.query(
                    `UPDATE student_auth_recovery_codes
                     SET status = 'revoked', code_digest = NULL, expires_at = NULL, revoked_at = clock_timestamp()
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
