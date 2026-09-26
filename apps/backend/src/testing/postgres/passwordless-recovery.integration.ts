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

async function seedProviderProof(client: PoolClient, userId: string): Promise<string> {
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
        assert.deepEqual(await service.status({ userId }), { status: 'active', generation: 1 });
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
        assert.deepEqual(await service.status({ userId }), { status: 'active', generation: 2 });

        const remove = await grant(client, { userId, purpose: 'recovery_code_remove', activeCodeGeneration: 2 });
        await assert.rejects(
            () => service.remove({ userId, sid: SID, grantId: remove.grantId, secret: remove.grantSecret, oldCode: initial.code }),
            (error: unknown) => (error as { code?: string }).code === 'CONFLICT',
        );
        await service.remove({ userId, sid: SID, grantId: remove.grantId, secret: remove.grantSecret, oldCode: replacement.code });
        assert.deepEqual(await service.status({ userId }), { status: 'unconfigured', generation: 2 });
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
        const proofIdentityId = await seedProviderProof(client, userId);
        const service = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key' });
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
        assert.deepEqual(await service.status({ userId }), { status: 'active', generation: 2 }, 'failed delivery must not roll back replacement');

        const removal = await grant(client, { userId, purpose: 'recovery_code_remove', activeCodeGeneration: 2 });
        await service.remove({ userId, sid: SID, grantId: removal.grantId, secret: removal.grantSecret, oldCode: replacement.code });
        assert.deepEqual(await service.status({ userId }), { status: 'unconfigured', generation: 2 });
        assert.deepEqual(events, ['activated', 'replaced', 'removed']);
    } finally {
        client.release();
        await pool.end();
    }
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
