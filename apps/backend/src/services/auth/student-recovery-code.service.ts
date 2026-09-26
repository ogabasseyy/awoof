import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError } from '../../common/errors/AppError.js';
import { consumeActionGrant } from './student-action-grant.service.js';

type RecoveryCodeStatus = 'unconfigured' | 'pending' | 'active';

type RecoveryCodeRow = {
    id: string;
    generation: string | number;
    code_digest: string | null;
    status: 'pending' | 'active' | 'consumed' | 'revoked';
    expires_at: Date | null;
    pending_sid: string | null;
    pending_credential_generation: string | number | null;
    pending_proof_identity_id: string | null;
};

type AccountRow = {
    active_session_id: string | null;
    credential_generation: string | number;
    deleted_at: Date | null;
    recovery_reenrollment_requires_password: boolean;
};

type GrantProofRow = { proof_identity_id: string | null };

export type StudentRecoveryCodeDependencies = {
    pool: Pick<Pool, 'connect'>;
    /** Dedicated deployment-held HMAC key; never a client secret or JWT key. */
    codeKey: string;
    randomCode?: () => string;
};

function unavailable(): ConflictError {
    return new ConflictError('Recovery code operation is not available');
}

function oldCodeRequired(): ConflictError {
    return new ConflictError('Current recovery code is required');
}

function codeForDisplay(): string {
    // 256 random bits represented in a copyable, URL-safe form; well above the
    // 128-bit requirement without a human-memorable-code security downgrade.
    return randomBytes(32).toString('base64url');
}

export class StudentRecoveryCodeService {
    constructor(private readonly dependencies: StudentRecoveryCodeDependencies) {
        if (dependencies.codeKey.length < 16) throw new TypeError('Recovery-code digest key is invalid');
    }

    async generate(input: { userId: string; sid: string; grantId: string; secret: string; oldCode?: string }): Promise<{ pendingCodeId: string; code: string; expiresAt: string }> {
        return this.inTransaction(async (tx) => {
            const account = await this.lockAccount(tx, input.userId, input.sid);
            const active = await this.lockCurrentCode(tx, input.userId, 'active');
            const proofIdentityId = await this.readLiveGrantProof(tx, input.grantId, input.userId);
            if (active) this.requireOldCode(active, input.oldCode);
            // Recovery consumes the prior code and leaves a durable policy
            // marker. A retained Microsoft identity cannot re-enroll until a
            // fresh proof of the current password produces a password grant.
            if (account.recovery_reenrollment_requires_password && proofIdentityId !== null) throw unavailable();
            await this.requireLiveProofIdentity(tx, proofIdentityId, input.userId);
            await consumeActionGrant(tx, {
                userId: input.userId, sid: input.sid, grantId: input.grantId, secret: input.secret,
                purpose: 'recovery_code_generate',
                activeCodeGeneration: active ? Number(active.generation) : null,
            });

            // A new generation invalidates only an earlier pending candidate.
            await tx.query(
                `UPDATE student_auth_recovery_codes
                 SET status = 'revoked', code_digest = NULL, expires_at = NULL, revoked_at = clock_timestamp()
                 WHERE user_id = $1 AND status = 'pending'`,
                [input.userId],
            );
            const code = this.dependencies.randomCode?.() ?? codeForDisplay();
            const codeId = randomUUID();
            const result = await tx.query<{ expires_at: Date }>(
                `INSERT INTO student_auth_recovery_codes
                     (id, user_id, generation, code_digest, status, expires_at,
                      pending_sid, pending_credential_generation, pending_proof_identity_id)
                 VALUES ($1, $2, COALESCE((SELECT max(generation) + 1 FROM student_auth_recovery_codes WHERE user_id = $2), 1),
                         $3, 'pending', clock_timestamp() + interval '10 minutes', $4::uuid, $5, $6)
                 RETURNING expires_at`,
                [codeId, input.userId, this.digest(code), input.sid, Number(account.credential_generation), proofIdentityId],
            );
            return { pendingCodeId: codeId, code, expiresAt: result.rows[0]!.expires_at.toISOString() };
        });
    }

    async activate(input: { userId: string; sid: string; grantId: string; secret: string; pendingCodeId: string; code: string; oldCode?: string }): Promise<{ active: true }> {
        return this.inTransaction(async (tx) => {
            const account = await this.lockAccount(tx, input.userId, input.sid);
            const pending = await this.lockCode(tx, input.userId, input.pendingCodeId);
            const active = await this.lockCurrentCode(tx, input.userId, 'active');
            const proofIdentityId = await this.readLiveGrantProof(tx, input.grantId, input.userId);
            const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
            if (!pending || pending.status !== 'pending' || !pending.expires_at || pending.expires_at <= clock.rows[0]!.now
                || pending.pending_sid !== input.sid
                || Number(pending.pending_credential_generation) !== Number(account.credential_generation)) throw unavailable();
            await this.requireLiveProofIdentity(tx, pending.pending_proof_identity_id, input.userId);
            await this.requireLiveProofIdentity(tx, proofIdentityId, input.userId);
            if (!this.matches(pending.code_digest, input.code)) throw unavailable();
            if (active) this.requireOldCode(active, input.oldCode);
            await consumeActionGrant(tx, {
                userId: input.userId, sid: input.sid, grantId: input.grantId, secret: input.secret,
                purpose: 'recovery_code_activate', pendingCodeId: pending.id,
                activeCodeGeneration: active ? Number(active.generation) : null,
            });
            if (active) {
                await tx.query(
                    `UPDATE student_auth_recovery_codes
                     SET status = 'revoked', code_digest = NULL, revoked_at = clock_timestamp()
                     WHERE id = $1`,
                    [active.id],
                );
            }
            const activated = await tx.query(
                `UPDATE student_auth_recovery_codes
                 SET status = 'active', expires_at = NULL, activated_at = clock_timestamp()
                 WHERE id = $1 AND status = 'pending'`,
                [pending.id],
            );
            if (activated.rowCount !== 1) throw unavailable();
            await tx.query(
                'UPDATE users SET recovery_reenrollment_requires_password = false WHERE id = $1',
                [input.userId],
            );
            return { active: true };
        });
    }

    async remove(input: { userId: string; sid: string; grantId: string; secret: string; oldCode: string }): Promise<void> {
        await this.inTransaction(async (tx) => {
            await this.lockAccount(tx, input.userId, input.sid);
            const active = await this.lockCurrentCode(tx, input.userId, 'active');
            if (!active) throw unavailable();
            this.requireOldCode(active, input.oldCode);
            const proofIdentityId = await this.readLiveGrantProof(tx, input.grantId, input.userId);
            await this.requireLiveProofIdentity(tx, proofIdentityId, input.userId);
            await consumeActionGrant(tx, {
                userId: input.userId, sid: input.sid, grantId: input.grantId, secret: input.secret,
                purpose: 'recovery_code_remove', activeCodeGeneration: Number(active.generation),
            });
            await tx.query(
                `UPDATE student_auth_recovery_codes
                 SET status = 'revoked', code_digest = NULL, revoked_at = clock_timestamp()
                 WHERE id = $1`,
                [active.id],
            );
            await tx.query(
                `UPDATE student_auth_recovery_codes
                 SET status = 'revoked', code_digest = NULL, expires_at = NULL, revoked_at = clock_timestamp()
                 WHERE user_id = $1 AND status = 'pending'`,
                [input.userId],
            );
        });
    }

    async status(input: { userId: string }): Promise<{ status: RecoveryCodeStatus; generation: number | null }> {
        const result = await this.dependencies.pool.connect();
        try {
            const current = await result.query<RecoveryCodeRow>(
                `SELECT id, generation, code_digest, status, expires_at, pending_sid,
                        pending_credential_generation, pending_proof_identity_id
                 FROM student_auth_recovery_codes
                 WHERE user_id = $1 AND status IN ('active', 'pending')
                 ORDER BY generation DESC LIMIT 1`,
                [input.userId],
            );
            const code = current.rows[0];
            if (code && (code.status === 'active' || code.status === 'pending')) {
                return { status: code.status, generation: Number(code.generation) };
            }
            const generation = await result.query<{ generation: string | number }>(
                'SELECT max(generation) AS generation FROM student_auth_recovery_codes WHERE user_id = $1', [input.userId],
            );
            return { status: 'unconfigured', generation: generation.rows[0]?.generation == null ? null : Number(generation.rows[0].generation) };
        } finally {
            result.release();
        }
    }

    private digest(code: string): string {
        return createHmac('sha256', this.dependencies.codeKey).update(code, 'utf8').digest('base64url');
    }

    private matches(digest: string | null, code: string): boolean {
        if (!digest) return false;
        const expected = Buffer.from(digest);
        const actual = Buffer.from(this.digest(code));
        return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
    }

    private requireOldCode(active: RecoveryCodeRow, oldCode: string | undefined): void {
        if (!oldCode || !this.matches(active.code_digest, oldCode)) throw oldCodeRequired();
    }

    private async inTransaction<T>(operation: (tx: PoolClient) => Promise<T>): Promise<T> {
        const tx = await this.dependencies.pool.connect();
        try {
            await tx.query('BEGIN');
            const result = await operation(tx);
            await tx.query('COMMIT');
            return result;
        } catch (error) {
            await tx.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            tx.release();
        }
    }

    private async lockAccount(tx: PoolClient, userId: string, sid: string): Promise<AccountRow> {
        const result = await tx.query<AccountRow>(
            `SELECT active_session_id, credential_generation, deleted_at, recovery_reenrollment_requires_password
             FROM users WHERE id = $1 FOR UPDATE`, [userId],
        );
        const account = result.rows[0];
        if (!account || account.deleted_at !== null || account.active_session_id !== sid) throw unavailable();
        return account;
    }

    private async lockCode(tx: PoolClient, userId: string, codeId: string): Promise<RecoveryCodeRow | undefined> {
        const result = await tx.query<RecoveryCodeRow>(
            `SELECT id, generation, code_digest, status, expires_at, pending_sid,
                    pending_credential_generation, pending_proof_identity_id
             FROM student_auth_recovery_codes WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [codeId, userId],
        );
        return result.rows[0];
    }

    private async lockCurrentCode(tx: PoolClient, userId: string, status: 'active'): Promise<RecoveryCodeRow | undefined> {
        const result = await tx.query<RecoveryCodeRow>(
            `SELECT id, generation, code_digest, status, expires_at, pending_sid,
                    pending_credential_generation, pending_proof_identity_id
             FROM student_auth_recovery_codes WHERE user_id = $1 AND status = $2 FOR UPDATE`,
            [userId, status],
        );
        return result.rows[0];
    }

    private async readLiveGrantProof(tx: PoolClient, grantId: string, userId: string): Promise<string | null> {
        const result = await tx.query<GrantProofRow>(
            'SELECT proof_identity_id FROM student_auth_action_grants WHERE id = $1 AND user_id = $2 FOR UPDATE',
            [grantId, userId],
        );
        if (!result.rows[0]) throw unavailable();
        return result.rows[0].proof_identity_id;
    }

    private async requireLiveProofIdentity(tx: PoolClient, identityId: string | null, userId: string): Promise<void> {
        if (!identityId) return;
        const result = await tx.query<{ revoked_at: Date | null }>(
            'SELECT revoked_at FROM student_auth_identities WHERE id = $1 AND user_id = $2 FOR UPDATE', [identityId, userId],
        );
        if (!result.rows[0] || result.rows[0].revoked_at !== null) throw unavailable();
    }
}
