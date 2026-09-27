import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictError } from '../../common/errors/AppError.js';
import { passwordService } from './password.service.js';
import { consumeChallenge, requestChallenge } from '../verification/challenge.service.js';
import { revokeSsoSchoolAssertions } from './student-sso-onboarding.service.js';

type RecoveryPurpose = 'lost_access' | 'compromise';

type Account = {
    id: string;
    email: string;
    credential_generation: number | string;
    deleted_at: Date | null;
    student_status: 'active' | 'suspended' | 'deleted' | null;
};

type Attempt = {
    id: string;
    user_id: string;
    credential_generation: number | string;
    purpose: RecoveryPurpose;
    secret_hash: string;
    recovery_code_generation: number | string;
    mailbox_challenge_id: string;
    status: 'pending' | 'verified' | 'consumed' | 'failed' | 'expired';
    expires_at: Date;
};

type RecoveryCode = { id: string; generation: number | string; code_digest: string | null; status: string };

export type StudentAccountRecoveryDependencies = {
    pool: Pick<Pool, 'connect'>;
    /** Deployment-held HMAC key shared with recovery-code enrollment. */
    recoveryCodeKey: string;
    deliverOtp?: (email: string, otp: string) => Promise<{ success: boolean }>;
    hashPassword?: (password: string) => Promise<string>;
    validatePassword?: (password: string) => { valid: boolean; errors: string[] };
};

function unavailable(): ConflictError {
    return new ConflictError('Account recovery is not available');
}

function validPurpose(value: unknown): value is RecoveryPurpose {
    return value === 'lost_access' || value === 'compromise';
}

function validOpaque(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validAttemptId(value: unknown): value is string {
    return typeof value === 'string' && UUID.test(value);
}

/**
 * The only password-establishment path for passwordless marker accounts.
 * It deliberately never issues a session: a successful caller must perform a
 * normal password login after the transaction commits.
 */
export class StudentAccountRecoveryService {
    constructor(private readonly deps: StudentAccountRecoveryDependencies) {
        if (deps.recoveryCodeKey.length < 16) throw new TypeError('Recovery-code digest key is invalid');
    }

    async start(input: { email: unknown; purpose: unknown }): Promise<{ attemptId: string; secret: string; expiresAt: string }> {
        if (!validPurpose(input.purpose)) throw new TypeError('Recovery purpose is invalid');
        if (typeof input.email !== 'string' || input.email.trim().length === 0 || input.email.length > 255) {
            throw new TypeError('Recovery email is invalid');
        }
        const email = input.email.trim().toLowerCase();
        const attemptId = randomUUID();
        const secret = randomBytes(32).toString('base64url');
        const genericExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        const committed = await this.transaction(async (tx) => {
            const account = await this.findRecoverableAccount(tx, email);
            if (!account) return null;
            const active = await this.lockActiveCode(tx, account.id);
            if (!active) return null;
            const challenge = await requestChallenge(tx, {
                purpose: 'student_account_recovery', subjectKey: account.email,
                bindings: { recoveryAttemptId: attemptId, recoveryPurpose: input.purpose },
                expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            });
            if (challenge.status !== 'issued') return null;
            await tx.query(
                `UPDATE student_auth_recovery_attempts
                 SET status = 'failed', secret_hash = NULL
                 WHERE user_id = $1 AND status IN ('pending', 'verified')`,
                [account.id],
            );
            const inserted = await tx.query<{ expires_at: Date }>(
                `INSERT INTO student_auth_recovery_attempts
                     (id, user_id, credential_generation, purpose, secret_hash, recovery_code_generation,
                      mailbox_challenge_id, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, LEAST(clock_timestamp() + interval '10 minutes', $8::timestamptz))
                 RETURNING expires_at`,
                [attemptId, account.id, Number(account.credential_generation), input.purpose, this.secretDigest(secret), Number(active.generation), challenge.challengeId, challenge.expiresAt],
            );
            return { email: account.email, otp: challenge.code, expiresAt: inserted.rows[0]!.expires_at.toISOString() };
        });
        // Always provide an indistinguishable browser handle. A non-existent,
        // suspended, or code-less account receives a handle that cannot verify.
        if (committed && this.deps.deliverOtp) await this.deps.deliverOtp(committed.email, committed.otp).catch(() => undefined);
        return { attemptId, secret, expiresAt: committed?.expiresAt ?? genericExpiry };
    }

    async verify(input: { attemptId: unknown; secret: unknown; code: unknown; otp: unknown }): Promise<void> {
        if (!validAttemptId(input.attemptId) || !validOpaque(input.secret) || !validOpaque(input.code)
            || typeof input.otp !== 'string' || !/^\d{6}$/.test(input.otp)) throw unavailable();
        const { attemptId, secret, code: recoveryCode, otp: mailboxOtp } = input;
        const verified = await this.transaction(async (tx) => {
            const owner = await tx.query<{ user_id: string }>('SELECT user_id FROM student_auth_recovery_attempts WHERE id = $1', [attemptId]);
            const userId = owner.rows[0]?.user_id;
            if (!userId) return false;
            const account = await this.lockAccount(tx, userId);
            const attempt = await this.lockAttempt(tx, attemptId);
            if (!attempt || attempt.status !== 'pending' || attempt.expires_at <= await this.now(tx)
                || !this.matchesDigest(attempt.secret_hash, this.secretDigest(secret))) return false;
            const code = await this.lockActiveCode(tx, userId);
            if (!account || !code || Number(account.credential_generation) !== Number(attempt.credential_generation)
                || Number(code.generation) !== Number(attempt.recovery_code_generation) || !this.matchesRecoveryCode(code.code_digest, recoveryCode)) {
                await tx.query("UPDATE student_auth_recovery_attempts SET status = 'failed', secret_hash = NULL WHERE id = $1 AND status = 'pending'", [attempt.id]);
                return false;
            }
            const otp = await consumeChallenge(tx, {
                purpose: 'student_account_recovery', subjectKey: account.email,
                challengeId: attempt.mailbox_challenge_id, code: mailboxOtp,
            });
            if (otp.status !== 'verified'
                || otp.bindings.recoveryAttemptId !== attempt.id
                || otp.bindings.recoveryPurpose !== attempt.purpose) return false;
            const updated = await tx.query(
                `UPDATE student_auth_recovery_attempts
                 SET status = 'verified', verified_at = clock_timestamp()
                 WHERE id = $1 AND status = 'pending'`, [attempt.id],
            );
            return updated.rowCount === 1;
        });
        if (!verified) throw unavailable();
    }

    async complete(input: { attemptId: unknown; secret: unknown; password: unknown }): Promise<void> {
        if (!validAttemptId(input.attemptId) || !validOpaque(input.secret) || typeof input.password !== 'string') throw unavailable();
        const { attemptId, secret, password } = input;
        const validation = (this.deps.validatePassword ?? ((candidate: string) => passwordService.validatePassword(candidate)))(password);
        if (!validation.valid) throw new ConflictError(validation.errors.join(', '));
        // Cheap credential check before the expensive password hash; the
        // transaction below rechecks everything under lock.
        const candidate = await this.previewAttempt(attemptId);
        if (!candidate || candidate.status !== 'verified' || candidate.expires_at <= new Date()
            || !candidate.secret_hash || !this.matchesDigest(candidate.secret_hash, this.secretDigest(secret))) throw unavailable();
        const hash = await (this.deps.hashPassword ?? ((candidate: string) => passwordService.hashPassword(candidate)))(password);
        await this.transaction(async (tx) => {
            // Read only to establish the owner, then acquire the canonical user
            // lock before taking mutable attempt/code/identity locks.
            const owner = await tx.query<{ user_id: string }>('SELECT user_id FROM student_auth_recovery_attempts WHERE id = $1', [attemptId]);
            const userId = owner.rows[0]?.user_id;
            if (!userId) throw unavailable();
            const account = await this.lockAccount(tx, userId);
            const attempt = await this.lockAttempt(tx, attemptId);
            const code = await this.lockActiveCode(tx, userId);
            if (!account || !attempt || !code || attempt.status !== 'verified' || attempt.expires_at <= await this.now(tx)
                || !this.matchesDigest(attempt.secret_hash, this.secretDigest(secret))
                || Number(account.credential_generation) !== Number(attempt.credential_generation)
                || Number(code.generation) !== Number(attempt.recovery_code_generation)) throw unavailable();

            if (attempt.purpose === 'compromise') {
                const identities = await tx.query<{ id: string }>('SELECT id FROM student_auth_identities WHERE user_id = $1 AND revoked_at IS NULL FOR UPDATE', [userId]);
                for (const identity of identities.rows) {
                    await tx.query('UPDATE student_auth_identities SET revoked_at = clock_timestamp() WHERE id = $1 AND revoked_at IS NULL', [identity.id]);
                    await revokeSsoSchoolAssertions(tx, identity.id);
                }
            }
            await tx.query(
                `UPDATE student_auth_recovery_codes
                 SET status = CASE WHEN status = 'active' THEN 'consumed' ELSE 'revoked' END,
                     code_digest = NULL, expires_at = NULL,
                     consumed_at = CASE WHEN status = 'active' THEN clock_timestamp() ELSE NULL END,
                     revoked_at = CASE WHEN status = 'pending' THEN clock_timestamp() ELSE NULL END
                 WHERE user_id = $1 AND status IN ('active', 'pending')`, [userId],
            );
            await tx.query(
                `UPDATE users SET password_hash = $2, password_reset_otp = NULL, password_reset_otp_expires_at = NULL,
                     refresh_token_hash = NULL, refresh_token_expires_at = NULL, active_session_id = NULL,
                     active_session_issued_at = NULL, active_session_auth_identity_id = NULL,
                     credential_generation = credential_generation + 1,
                     recovery_reenrollment_requires_password = true, updated_at = clock_timestamp()
                 WHERE id = $1`, [userId, hash],
            );
            await tx.query("UPDATE student_auth_action_grants SET revoked_at = clock_timestamp(), secret_hash = 'scrubbed' WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL", [userId]);
            await tx.query("UPDATE student_auth_reauth_grants SET consumed_at = clock_timestamp(), secret_hash = 'scrubbed' WHERE user_id = $1 AND consumed_at IS NULL", [userId]);
            await tx.query(
                `UPDATE student_auth_reauth_attempts
                 SET status = 'failed', consumed_at = clock_timestamp(), state_hash = NULL, callback_cookie_hash = NULL,
                     encrypted_verifier = NULL, nonce = NULL
                 WHERE user_id = $1 AND status IN ('pending', 'ready')`,
                [userId],
            );
            // A ready provider callback is not yet a session. Invalidate every
            // same-mailbox attempt before releasing the account lock so a
            // pre-recovery callback cannot mint a post-recovery session.
            await tx.query(
                `UPDATE student_auth_attempts
                 SET status = 'failed', encrypted_verifier = NULL, nonce = NULL, encrypted_observation = NULL
                 WHERE requested_email = $1 AND status IN ('pending', 'processing', 'ready')`,
                [account.email],
            );
            await tx.query(
                `UPDATE student_auth_recovery_attempts
                 SET status = 'failed', secret_hash = NULL
                 WHERE user_id = $1 AND id <> $2 AND status IN ('pending', 'verified')`,
                [userId, attempt.id],
            );
            const consumed = await tx.query(
                `UPDATE student_auth_recovery_attempts SET status = 'consumed', consumed_at = clock_timestamp(), secret_hash = NULL
                 WHERE id = $1 AND status = 'verified'`, [attempt.id],
            );
            if (consumed.rowCount !== 1) throw unavailable();
        });
    }

    private async transaction<T>(operation: (tx: PoolClient) => Promise<T>): Promise<T> {
        const tx = await this.deps.pool.connect();
        try { await tx.query('BEGIN'); const result = await operation(tx); await tx.query('COMMIT'); return result; }
        catch (error) { await tx.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { tx.release(); }
    }

    private async findRecoverableAccount(tx: PoolClient, email: string): Promise<Account | null> {
        const result = await tx.query<Account>(
            `SELECT u.id, u.email, u.credential_generation, u.deleted_at, s.status AS student_status
             FROM users u LEFT JOIN students s ON s.user_id = u.id
             WHERE lower(btrim(u.email)) = $1 AND u.role = 'student' FOR UPDATE OF u`, [email],
        );
        const account = result.rows[0];
        return account && account.deleted_at === null && account.student_status === 'active' ? account : null;
    }

    private async lockAccount(tx: PoolClient, userId: string): Promise<Account | null> {
        const result = await tx.query<Account>(
            `SELECT u.id, u.email, u.credential_generation, u.deleted_at, s.status AS student_status
             FROM users u LEFT JOIN students s ON s.user_id = u.id WHERE u.id = $1 FOR UPDATE OF u`, [userId],
        );
        const account = result.rows[0];
        return account && account.deleted_at === null && account.student_status === 'active' ? account : null;
    }

    private async lockActiveCode(tx: PoolClient, userId: string): Promise<RecoveryCode | null> {
        const result = await tx.query<RecoveryCode>(
            "SELECT id, generation, code_digest, status FROM student_auth_recovery_codes WHERE user_id = $1 AND status = 'active' FOR UPDATE", [userId],
        );
        return result.rows[0] ?? null;
    }

    private async lockAttempt(tx: PoolClient, id: string): Promise<Attempt | null> {
        const result = await tx.query<Attempt>('SELECT * FROM student_auth_recovery_attempts WHERE id = $1 FOR UPDATE', [id]);
        return result.rows[0] ?? null;
    }

    private async previewAttempt(id: string): Promise<{ status: string; secret_hash: string | null; expires_at: Date } | null> {
        const conn = await this.deps.pool.connect();
        try {
            const result = await conn.query<{ status: string; secret_hash: string | null; expires_at: Date }>(
                'SELECT status, secret_hash, expires_at FROM student_auth_recovery_attempts WHERE id = $1', [id],
            );
            return result.rows[0] ?? null;
        } finally { conn.release(); }
    }

    private async now(tx: PoolClient): Promise<Date> {
        const result = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        return result.rows[0]!.now;
    }

    private secretDigest(secret: string): string { return createHmac('sha256', this.deps.recoveryCodeKey).update(`attempt\u0000${secret}`).digest('base64url'); }
    private recoveryCodeDigest(code: string): string {
        return createHmac('sha256', this.deps.recoveryCodeKey).update(code, 'utf8').digest('base64url');
    }
    private matchesRecoveryCode(expected: string | null, supplied: string): boolean {
        if (!expected) return false;
        const actual = Buffer.from(this.recoveryCodeDigest(supplied)); const wanted = Buffer.from(expected);
        return actual.length === wanted.length && timingSafeEqual(actual, wanted);
    }
    private matchesDigest(expected: string, candidate: string): boolean {
        const actual = Buffer.from(candidate); const wanted = Buffer.from(expected);
        return actual.length === wanted.length && timingSafeEqual(actual, wanted);
    }
}
