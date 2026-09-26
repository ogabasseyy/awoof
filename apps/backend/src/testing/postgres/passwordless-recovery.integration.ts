import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { issueActionGrant } from '../../services/auth/student-action-grant.service.js';
import { StudentRecoveryCodeService } from '../../services/auth/student-recovery-code.service.js';
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

async function grant(
    client: PoolClient,
    input: { userId: string; sid?: string; purpose: 'recovery_code_generate' | 'recovery_code_activate' | 'recovery_code_remove'; pendingCodeId?: string; activeCodeGeneration?: number },
) {
    return issueActionGrant(client, {
        userId: input.userId,
        sid: input.sid ?? SID,
        purpose: input.purpose,
        credentialGeneration: 0,
        ...(input.pendingCodeId === undefined ? {} : { pendingCodeId: input.pendingCodeId }),
        ...(input.activeCodeGeneration === undefined ? {} : { activeCodeGeneration: input.activeCodeGeneration }),
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
            /old recovery code/i,
        );
        const replacement = await service.generate({ userId, sid: SID, grantId: replacementGrant.grantId, secret: replacementGrant.grantSecret, oldCode: initial.code });
        const replacementActivation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: replacement.pendingCodeId, activeCodeGeneration: 1 });
        await assert.rejects(
            () => service.activate({ userId, sid: SID, grantId: replacementActivation.grantId, secret: replacementActivation.grantSecret, pendingCodeId: replacement.pendingCodeId, code: replacement.code }),
            /old recovery code/i,
        );
        await service.activate({ userId, sid: SID, grantId: replacementActivation.grantId, secret: replacementActivation.grantSecret, pendingCodeId: replacement.pendingCodeId, code: replacement.code, oldCode: initial.code });
        assert.deepEqual(await service.status({ userId }), { status: 'active', generation: 2 });

        const remove = await grant(client, { userId, purpose: 'recovery_code_remove', activeCodeGeneration: 2 });
        await assert.rejects(
            () => service.remove({ userId, sid: SID, grantId: remove.grantId, secret: remove.grantSecret, oldCode: initial.code }),
            /old recovery code/i,
        );
        await service.remove({ userId, sid: SID, grantId: remove.grantId, secret: remove.grantSecret, oldCode: replacement.code });
        assert.deepEqual(await service.status({ userId }), { status: 'unconfigured', generation: 2 });
    } finally {
        client.release();
        await pool.end();
    }
});

test('obsolete session and credential generation cannot activate a pending code', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const userId = await seedStudent(client);
        const service = new StudentRecoveryCodeService({ pool, codeKey: 'test-recovery-code-key' });
        const generated = await grant(client, { userId, purpose: 'recovery_code_generate' });
        const pending = await service.generate({ userId, sid: SID, grantId: generated.grantId, secret: generated.grantSecret });
        const activation = await grant(client, { userId, purpose: 'recovery_code_activate', pendingCodeId: pending.pendingCodeId });
        await client.query('UPDATE users SET credential_generation = credential_generation + 1 WHERE id = $1', [userId]);
        await assert.rejects(
            () => service.activate({ userId, sid: SID, grantId: activation.grantId, secret: activation.grantSecret, pendingCodeId: pending.pendingCodeId, code: pending.code }),
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
