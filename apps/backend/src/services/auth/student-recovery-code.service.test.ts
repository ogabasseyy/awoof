import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { hashMicrosoftAttemptSecret } from '../verification/microsoft-attempt-crypto.js';
import { StudentRecoveryCodeService, digestRecoveryCode } from './student-recovery-code.service.js';

test('status exposes recovery state and generation without a recovery digest', async () => {
    const queries: string[] = [];
    const client = {
        query: async (text: string) => {
            queries.push(text);
            if (text.includes('FROM student_auth_recovery_codes') && text.includes('ORDER BY generation DESC LIMIT 1')) {
                return {
                    rows: [{
                        id: '11111111-1111-4111-8111-111111111111', generation: 3, code_digest: 'must-not-leak',
                        status: 'active', expires_at: null, pending_sid: null,
                        pending_credential_generation: null, pending_proof_identity_id: null,
                        now: new Date('2026-09-27T22:00:00.000Z'),
                    }],
                    rowCount: 1,
                };
            }
            throw new Error(`unexpected query: ${text}`);
        },
        release: () => undefined,
    } as unknown as PoolClient;
    const service = new StudentRecoveryCodeService({
        pool: { connect: async () => client } as never,
        codeKey: 'test-recovery-code-key',
    });

    assert.deepEqual(await service.status({ userId: '22222222-2222-4222-8222-222222222222' }), {
        status: 'active', generation: 3, pendingCodeId: null, pendingExpiresAt: null,
        serverNow: '2026-09-27T22:00:00.000Z',
    });
    assert.equal(queries.length, 1);
    assert.ok(queries[0]!.includes("code.status = 'pending' AND code.expires_at > clock_timestamp()"),
        'expired pending candidates must not shadow the active recovery code');
    assert.ok(queries[0]!.includes('code.pending_proof_identity_id IS NULL OR EXISTS'),
        'pending codes with dead provider proofs must not shadow the active recovery code');
});

test('recovery-code digest key must have sufficient deployment-held entropy', () => {
    assert.throws(
        () => new StudentRecoveryCodeService({ pool: {} as never, codeKey: 'short' }),
        /digest key is invalid/,
    );
    assert.throws(
        () => new StudentRecoveryCodeService({ pool: {} as never, codeKey: 'test-recovery-code-key', previousCodeKey: 'short' }),
        /previous digest key is invalid/,
    );
});

test('a hung removal notice times out instead of holding the committed removal open', async () => {
    const userId = '22222222-2222-4222-8222-222222222222';
    const sid = '33333333-3333-4333-8333-333333333333';
    const grantId = '44444444-4444-4444-8444-444444444444';
    const grantSecret = 'grant-secret';
    const oldCode = 'OLDCODE1';
    const queries: string[] = [];
    const client = {
        query: async (text: string) => {
            queries.push(text);
            if (text.includes('SELECT email, active_session_id')) {
                return { rows: [{ email: 's@x.invalid', active_session_id: sid, credential_generation: 0, deleted_at: null, recovery_reenrollment_requires_password: false }], rowCount: 1 };
            }
            if (text.includes('SELECT status FROM students WHERE user_id')) return { rows: [{ status: 'active' }], rowCount: 1 };
            if (text.includes('FROM student_auth_recovery_codes WHERE user_id = $1 AND status = $2 FOR UPDATE')) {
                return { rows: [{ id: 'c1', generation: 3, code_digest: digestRecoveryCode(oldCode, 'test-recovery-code-key'), status: 'active' }], rowCount: 1 };
            }
            if (text.includes('SELECT proof_identity_id FROM student_auth_action_grants')) return { rows: [{ proof_identity_id: null }], rowCount: 1 };
            if (text.includes('SELECT * FROM student_auth_action_grants WHERE id = $1 FOR UPDATE')) {
                return {
                    rows: [{
                        user_id: userId, sid, credential_generation: 0, purpose: 'recovery_code_remove',
                        proof_identity_id: null, target_identity_id: null, pending_code_id: null, active_code_generation: 3,
                        consumed_at: null, revoked_at: null, expires_at: new Date(Date.now() + 600_000),
                        secret_hash: hashMicrosoftAttemptSecret(grantSecret),
                    }],
                    rowCount: 1,
                };
            }
            if (text.includes('SELECT active_session_id, credential_generation FROM users WHERE id = $1 FOR UPDATE')) {
                return { rows: [{ active_session_id: sid, credential_generation: 0 }], rowCount: 1 };
            }
            if (text.includes('SELECT clock_timestamp() AS now')) return { rows: [{ now: new Date() }], rowCount: 1 };
            if (text.includes("SET consumed_at = clock_timestamp(), secret_hash = 'scrubbed'")) return { rows: [], rowCount: 1 };
            if (text.includes("SET status = 'revoked'")) return { rows: [], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
    } as unknown as PoolClient;
    const service = new StudentRecoveryCodeService({
        pool: { connect: async () => client } as never,
        codeKey: 'test-recovery-code-key',
        notify: () => new Promise<{ success: boolean }>(() => undefined),
        noticeTimeoutMs: 25,
    });

    const started = Date.now();
    await service.remove({ userId, sid, grantId, secret: grantSecret, oldCode });
    assert.ok(Date.now() - started < 5000, 'remove must bound a hung notice instead of awaiting it');
    assert.ok(queries.some((text) => text.includes("SET status = 'revoked'")), 'the active code must commit as revoked');
});
