import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ConflictError } from '../../common/errors/AppError.js';
import { hashMicrosoftAttemptSecret } from '../verification/microsoft-attempt-crypto.js';

export type ActionPurpose = 'link' | 'unlink' | 'recovery_code_generate' | 'recovery_code_activate' | 'recovery_code_remove';

export type ActionGrantBinding = {
    userId: string;
    sid: string;
    purpose: ActionPurpose;
    proofIdentityId?: string | null;
    targetIdentityId?: string | null;
    pendingCodeId?: string | null;
    activeCodeGeneration?: number | null;
};

export type ActionGrantResult = { grantId: string; grantSecret: string; expiresAt: string };

type GrantRow = {
    user_id: string;
    sid: string;
    credential_generation: string | number;
    purpose: string;
    secret_hash: string;
    proof_identity_id: string | null;
    target_identity_id: string | null;
    pending_code_id: string | null;
    active_code_generation: string | number | null;
    expires_at: Date;
    consumed_at: Date | null;
    revoked_at: Date | null;
};

type Dependencies = { hashSecret?: (secret: string) => string };

function invalidGrant(): ConflictError {
    return new ConflictError('Student SSO action grant is not valid');
}

function secret(): string {
    return randomBytes(32).toString('base64url');
}

function sameNullable(expected: string | number | null | undefined, actual: string | number | null): boolean {
    return (expected ?? null) === actual;
}

/**
 * Creates the one-use canonical action grant used by both password and
 * provider proof. The caller holds the canonical student context lock and
 * has already rechecked the account/session/credential binding.
 */
export async function issueActionGrant(
    tx: PoolClient,
    binding: ActionGrantBinding & { credentialGeneration: number },
    deps: Dependencies = {},
): Promise<ActionGrantResult> {
    const grantId = randomUUID();
    const grantSecret = secret();
    const hashSecret = deps.hashSecret ?? hashMicrosoftAttemptSecret;
    const result = await tx.query<{ expires_at: Date }>(
        `INSERT INTO student_auth_action_grants
             (id, user_id, sid, credential_generation, purpose, secret_hash,
              proof_identity_id, target_identity_id, pending_code_id, active_code_generation, expires_at)
         VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, clock_timestamp() + interval '5 minutes')
         RETURNING expires_at`,
        [
            grantId, binding.userId, binding.sid, binding.credentialGeneration, binding.purpose, hashSecret(grantSecret),
            binding.proofIdentityId ?? null, binding.targetIdentityId ?? null, binding.pendingCodeId ?? null,
            binding.activeCodeGeneration ?? null,
        ],
    );
    return { grantId, grantSecret, expiresAt: result.rows[0]!.expires_at.toISOString() };
}

/**
 * Consume exactly one grant after callers have acquired the account and any
 * target locks. It independently rechecks session and credential generation
 * so logout, session replacement and credential changes invalidate grants.
 */
export async function consumeActionGrant(
    tx: PoolClient,
    input: ActionGrantBinding & { grantId: string; secret: string },
    deps: Dependencies = {},
): Promise<void> {
    const hashSecret = deps.hashSecret ?? hashMicrosoftAttemptSecret;
    const grantResult = await tx.query<GrantRow>(
        'SELECT * FROM student_auth_action_grants WHERE id = $1 FOR UPDATE',
        [input.grantId],
    );
    const accountResult = await tx.query<{ active_session_id: string | null; credential_generation: string | number }>(
        'SELECT active_session_id, credential_generation FROM users WHERE id = $1 FOR UPDATE',
        [input.userId],
    );
    const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const grant = grantResult.rows[0];
    const account = accountResult.rows[0];
    if (!grant || !account
        || grant.user_id !== input.userId
        || grant.sid !== input.sid
        || account.active_session_id !== input.sid
        || Number(grant.credential_generation) !== Number(account.credential_generation)
        || grant.purpose !== input.purpose
        || !sameNullable(input.proofIdentityId, grant.proof_identity_id)
        || !sameNullable(input.targetIdentityId, grant.target_identity_id)
        || !sameNullable(input.pendingCodeId, grant.pending_code_id)
        || !sameNullable(input.activeCodeGeneration, grant.active_code_generation)
        || grant.consumed_at !== null
        || grant.revoked_at !== null
        || grant.expires_at <= clock.rows[0]!.now
        || hashSecret(input.secret) !== grant.secret_hash) {
        throw invalidGrant();
    }
    const consumed = await tx.query(
        `UPDATE student_auth_action_grants
         SET consumed_at = clock_timestamp(), secret_hash = 'scrubbed'
         WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
        [input.grantId],
    );
    if (consumed.rowCount !== 1) throw invalidGrant();
}
