import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError } from '../../common/errors/AppError.js';
import { appLogger } from '../../common/logger.js';
import { sendRecoveryCodeSecurityNotice } from '../email/email.service.js';
import { consumeActionGrant } from './student-action-grant.service.js';
import { selectCurrentProofAuthority } from './student-sso-onboarding.service.js';
import type { LoginProvider } from './student-sso.types.js';

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
    email: string;
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
    /**
     * Retained previous effective key, used only as a verification fallback
     * so adding (or rotating) the dedicated key never strands active codes
     * digested under it. New digests always use the current key.
     */
    previousCodeKey?: string;
    randomCode?: () => string;
    notify?: (email: string, event: 'activated' | 'replaced' | 'removed') => Promise<{ success: boolean }>;
    /**
     * Deployment provider gate. Proof-backed operations fail closed without
     * it; password-backed grants (null proof) never consult it.
     */
    isProviderEnabled?: (provider: LoginProvider) => boolean;
};

const RECOVERY_CODE_DIGEST_VERSION = 'v1';

/** Versioned HMAC digest for stored recovery codes. */
export function digestRecoveryCode(code: string, key: string): string {
    return `${RECOVERY_CODE_DIGEST_VERSION}:${createHmac('sha256', key).update(code, 'utf8').digest('base64url')}`;
}

/**
 * Verify a supplied code against a stored digest. Legacy unprefixed digests
 * compare the same body. The previous key is tried only when set and
 * different, so a key change verifies both old and new codes.
 */
export function verifyRecoveryCodeDigest(digest: string | null, code: string, key: string, previousKey?: string | null): boolean {
    if (!digest) return false;
    const body = digest.startsWith(`${RECOVERY_CODE_DIGEST_VERSION}:`) ? digest.slice(RECOVERY_CODE_DIGEST_VERSION.length + 1) : digest;
    const expected = Buffer.from(body);
    const primary = Buffer.from(createHmac('sha256', key).update(code, 'utf8').digest('base64url'));
    if (expected.byteLength === primary.byteLength && timingSafeEqual(expected, primary)) return true;
    if (!previousKey || previousKey === key) return false;
    const fallback = Buffer.from(createHmac('sha256', previousKey).update(code, 'utf8').digest('base64url'));
    return expected.byteLength === fallback.byteLength && timingSafeEqual(expected, fallback);
}

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
        if (dependencies.previousCodeKey !== undefined && dependencies.previousCodeKey.length < 16) {
            throw new TypeError('Recovery-code previous digest key is invalid');
        }
    }

    async generate(input: { userId: string; sid: string; grantId: string; secret: string; oldCode?: string }): Promise<{ pendingCodeId: string; code: string; expiresAt: string; serverNow: string }> {
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
            // Terminalization also scrubs the pending-only authorization
            // bindings: they authorized activation and are unnecessary
            // session/identity metadata afterward.
            await tx.query(
                `UPDATE student_auth_recovery_codes
                 SET status = 'revoked', code_digest = NULL, expires_at = NULL, revoked_at = clock_timestamp(),
                     pending_sid = NULL, pending_credential_generation = NULL, pending_proof_identity_id = NULL
                 WHERE user_id = $1 AND status = 'pending'`,
                [input.userId],
            );
            const code = this.dependencies.randomCode?.() ?? codeForDisplay();
            const codeId = randomUUID();
            const result = await tx.query<{ expires_at: Date; now: Date }>(
                `INSERT INTO student_auth_recovery_codes
                     (id, user_id, generation, code_digest, status, expires_at,
                      pending_sid, pending_credential_generation, pending_proof_identity_id)
                 VALUES ($1, $2, COALESCE((SELECT max(generation) + 1 FROM student_auth_recovery_codes WHERE user_id = $2), 1),
                         $3, 'pending', clock_timestamp() + interval '10 minutes', $4::uuid, $5, $6)
                 RETURNING expires_at, clock_timestamp() AS now`,
                [codeId, input.userId, this.digest(code), input.sid, Number(account.credential_generation), proofIdentityId],
            );
            return { pendingCodeId: codeId, code, expiresAt: result.rows[0]!.expires_at.toISOString(), serverNow: result.rows[0]!.now.toISOString() };
        });
    }

    async activate(input: { userId: string; sid: string; grantId: string; secret: string; pendingCodeId: string; code: string; oldCode?: string }): Promise<{ active: true }> {
        const committed = await this.inTransaction(async (tx) => {
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
            const event: 'activated' | 'replaced' = active ? 'replaced' : 'activated';
            if (active) {
                await tx.query(
                    `UPDATE student_auth_recovery_codes
                     SET status = 'revoked', code_digest = NULL, revoked_at = clock_timestamp(),
                         pending_sid = NULL, pending_credential_generation = NULL, pending_proof_identity_id = NULL
                     WHERE id = $1`,
                    [active.id],
                );
            }
            // The pending-only authorization bindings authorize this
            // transition and nothing after it: scrub them as the durable
            // code activates rather than retaining session and
            // proof-identity metadata for the code's lifetime.
            const activated = await tx.query(
                `UPDATE student_auth_recovery_codes
                 SET status = 'active', expires_at = NULL, activated_at = clock_timestamp(),
                     pending_sid = NULL, pending_credential_generation = NULL, pending_proof_identity_id = NULL
                 WHERE id = $1 AND status = 'pending'`,
                [pending.id],
            );
            if (activated.rowCount !== 1) throw unavailable();
            await tx.query(
                'UPDATE users SET recovery_reenrollment_requires_password = false WHERE id = $1',
                [input.userId],
            );
            return { result: { active: true as const }, email: account.email, event };
        });
        await this.sendSecurityNotice(committed.email, committed.event);
        return committed.result;
    }

    async remove(input: { userId: string; sid: string; grantId: string; secret: string; oldCode: string }): Promise<void> {
        const committed = await this.inTransaction(async (tx) => {
            const account = await this.lockAccount(tx, input.userId, input.sid);
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
                 SET status = 'revoked', code_digest = NULL, revoked_at = clock_timestamp(),
                     pending_sid = NULL, pending_credential_generation = NULL, pending_proof_identity_id = NULL
                 WHERE id = $1`,
                [active.id],
            );
            await tx.query(
                `UPDATE student_auth_recovery_codes
                 SET status = 'revoked', code_digest = NULL, expires_at = NULL, revoked_at = clock_timestamp(),
                     pending_sid = NULL, pending_credential_generation = NULL, pending_proof_identity_id = NULL
                 WHERE user_id = $1 AND status = 'pending'`,
                [input.userId],
            );
            return { email: account.email };
        });
        await this.sendSecurityNotice(committed.email, 'removed');
    }

    async status(input: { userId: string }): Promise<{ status: RecoveryCodeStatus; generation: number | null; pendingCodeId: string | null; pendingExpiresAt: string | null; serverNow: string }> {
        const result = await this.dependencies.pool.connect();
        try {
            // Provider-proven pendings advertise only while their proof
            // could still activate: the enabled-provider set mirrors the
            // requireLiveProofIdentity gate (an absent gate rejects proofs,
            // so an empty set filters them here too).
            const enabledProviders = (['google', 'microsoft'] as LoginProvider[])
                .filter((provider) => this.dependencies.isProviderEnabled?.(provider) === true);
            const current = await result.query<RecoveryCodeRow & { now: Date }>(
                `SELECT code.id, code.generation, code.code_digest, code.status, code.expires_at, code.pending_sid,
                        code.pending_credential_generation, code.pending_proof_identity_id, clock_timestamp() AS now
                 FROM student_auth_recovery_codes code
                 JOIN users account ON account.id = code.user_id
                 WHERE code.user_id = $1
                   AND (code.status = 'active'
                        OR (code.status = 'pending' AND code.expires_at > clock_timestamp()
                            AND (code.pending_sid IS NULL OR code.pending_sid = account.active_session_id)
                            AND (code.pending_credential_generation IS NULL
                                 OR code.pending_credential_generation = account.credential_generation)
                            AND (code.pending_proof_identity_id IS NULL OR EXISTS (
                                SELECT 1 FROM student_auth_identities identity
                                JOIN students student ON student.user_id = identity.user_id
                                    AND student.status = 'active'
                                    AND student.university_id = identity.university_id
                                JOIN universities university ON university.id = identity.university_id AND university.is_active
                                JOIN institution_login_policies policy ON policy.university_id = identity.university_id
                                    AND policy.provider = identity.provider AND policy.issuer = identity.issuer
                                    AND policy.enabled AND policy.approved_by IS NOT NULL AND policy.approved_until > clock_timestamp()
                                JOIN institution_login_domain_providers mapping ON mapping.policy_id = policy.id
                                    AND mapping.university_id = policy.university_id AND mapping.provider = policy.provider
                                JOIN institution_login_domains domain ON domain.domain = mapping.domain
                                    AND domain.university_id = mapping.university_id AND domain.is_active
                                WHERE identity.id = code.pending_proof_identity_id
                                  AND identity.user_id = code.user_id
                                  AND identity.revoked_at IS NULL
                                  AND identity.provider = ANY($2)))))
                 ORDER BY generation DESC LIMIT 1`,
                [input.userId, enabledProviders],
            );
            const code = current.rows[0];
            if (code && (code.status === 'active' || code.status === 'pending')) {
                // The pending activation deadline must survive navigation and
                // reload: clients display it and restart on expiry instead of
                // failing a stale activation generically. The server clock
                // travels with it so skewed devices correct their countdown
                // instead of expiring a live deadline early. Pending
                // candidates whose session binding no longer matches the
                // account, or whose provider proof lost login authority
                // (unlinked, withdrawn policy/domain, disabled provider),
                // are filtered above: activate() would reject them, so
                // status must not advertise them as actionable (which
                // would also shadow a still-valid older active code).
                return {
                    status: code.status, generation: Number(code.generation), pendingCodeId: code.status === 'pending' ? code.id : null,
                    pendingExpiresAt: code.status === 'pending' && code.expires_at ? code.expires_at.toISOString() : null,
                    serverNow: code.now.toISOString(),
                };
            }
            const generation = await result.query<{ generation: string | number; now: Date }>(
                'SELECT max(generation) AS generation, clock_timestamp() AS now FROM student_auth_recovery_codes WHERE user_id = $1', [input.userId],
            );
            return { status: 'unconfigured', generation: generation.rows[0]?.generation == null ? null : Number(generation.rows[0].generation), pendingCodeId: null, pendingExpiresAt: null, serverNow: generation.rows[0]!.now.toISOString() };
        } finally {
            result.release();
        }
    }

    /** Cancelling a candidate never touches an active recovery code. */
    async cancel(input: { userId: string; sid: string; pendingCodeId: string }): Promise<void> {
        await this.inTransaction(async (tx) => {
            await this.lockAccount(tx, input.userId, input.sid);
            const pending = await this.lockCode(tx, input.userId, input.pendingCodeId);
            if (!pending || pending.status !== 'pending') throw unavailable();
            await tx.query(`UPDATE student_auth_recovery_codes
                SET status = 'revoked', code_digest = NULL, expires_at = NULL, revoked_at = clock_timestamp(),
                    pending_sid = NULL, pending_credential_generation = NULL, pending_proof_identity_id = NULL
                WHERE id = $1 AND status = 'pending'`, [pending.id]);
        });
    }

    private digest(code: string): string {
        return digestRecoveryCode(code, this.dependencies.codeKey);
    }

    private matches(digest: string | null, code: string): boolean {
        return verifyRecoveryCodeDigest(digest, code, this.dependencies.codeKey, this.dependencies.previousCodeKey);
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
            `SELECT email, active_session_id, credential_generation, deleted_at, recovery_reenrollment_requires_password
             FROM users WHERE id = $1 FOR UPDATE`, [userId],
        );
        const account = result.rows[0];
        if (!account || account.deleted_at !== null || account.active_session_id !== sid) throw unavailable();
        // A five-minute grant outlives suspension: both proof-issuance paths
        // required an active student context, so recheck the locked profile
        // at consumption or a suspended student could still enroll, activate,
        // or remove a credential. Lock order follows users → students.
        const student = await tx.query<{ status: string }>(
            'SELECT status FROM students WHERE user_id = $1 FOR UPDATE', [userId],
        );
        if (student.rows[0]?.status !== 'active') throw unavailable();
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
        const result = await tx.query<{ revoked_at: Date | null; provider: string; university_id: string; issuer: string }>(
            'SELECT revoked_at, provider, university_id, issuer FROM student_auth_identities WHERE id = $1 AND user_id = $2 FOR UPDATE', [identityId, userId],
        );
        const row = result.rows[0];
        if (!row || row.revoked_at !== null || (row.provider !== 'google' && row.provider !== 'microsoft')) throw unavailable();
        // A five-minute grant outlives authority edits: revalidate the
        // university activity gate under lock, the deployment kill switch,
        // and the identity's currently enabled, unexpired institution
        // policy at action time. The issuer must match exactly: a tenant
        // replaced mid-grant leaves the stale identity unable to log in,
        // so it cannot authorize code actions.
        const university = await tx.query<{ is_active: boolean }>(
            'SELECT is_active FROM universities WHERE id = $1 FOR UPDATE', [row.university_id],
        );
        if (!university.rows[0] || university.rows[0].is_active !== true) throw unavailable();
        if (this.dependencies.isProviderEnabled?.(row.provider) !== true) throw unavailable();
        const policy = await tx.query<{ id: string }>(
            `SELECT id FROM institution_login_policies
             WHERE university_id = $1 AND provider = $2 AND issuer = $3 AND enabled AND approved_until > clock_timestamp()
             LIMIT 1`,
            [row.university_id, row.provider, row.issuer],
        );
        if (!policy.rows[0]) throw unavailable();
        // Close the transfer/withdrawal gap: the proof must still sit at
        // the student's canonical university behind a live domain mapping,
        // or the stale identity could authorize code actions it can no
        // longer log in with.
        const authority = await selectCurrentProofAuthority(tx, userId, identityId);
        if (!authority || authority.provider !== row.provider) throw unavailable();
    }

    private async sendSecurityNotice(email: string, event: 'activated' | 'replaced' | 'removed'): Promise<void> {
        try {
            const delivery = await (this.dependencies.notify ?? sendRecoveryCodeSecurityNotice)(email, event);
            if (!delivery.success) appLogger.error('Recovery-code security notice delivery failed');
        } catch {
            // Credential state has already committed. A transport failure must
            // not reopen or roll back a consumed, replaced, or removed code.
            appLogger.error('Recovery-code security notice transport failed');
        }
    }
}
