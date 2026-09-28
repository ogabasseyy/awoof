import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { StudentRecoveryCodeService } from './student-recovery-code.service.js';

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
