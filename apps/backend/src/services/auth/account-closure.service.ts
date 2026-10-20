/**
 * Self-service student account closure (soft delete).
 *
 * Closure writes `users.deleted_at`, the same marker the rest of the
 * system already treats as a closed account: login refuses deleted
 * accounts, profile/purchase queries filter `deleted_at IS NULL`, and
 * the scheduled academic-profile purge keys off `deleted_at` plus the
 * approved retention window (see academic-profile-retention.service).
 * Sessions are revoked in the same statement: refresh credentials are
 * cleared, the active session binding is dropped, and
 * `credential_generation` is bumped so outstanding access tokens that
 * carry a session id can never match a future session, and
 * `recovery_session_binding_required` is set permanently so legacy
 * sid-less tokens stay rejected even if support later restores the
 * account (restoration clears only `deleted_at`; the student signs in
 * fresh and that login is session-bound like a recovered account).
 *
 * Closure is student-only: vendor accounts carry live business records
 * (products, orders, payouts) and admin accounts are operational, so
 * both close through support processes instead. Restoration inside the
 * retention window is likewise support-mediated: support clears
 * `deleted_at` before the purge runs, which restores login because no
 * other state is destroyed at closure time.
 */
import type { Pool } from 'pg';
import { ConflictError, NotFoundError, ServiceUnavailableError, UnauthorizedError } from '../../common/errors/AppError.js';
import { passwordService } from './password.service.js';
import {
    ACADEMIC_PROFILE_RETENTION_ENV_VAR,
    resolveAcademicProfileRetentionDays,
} from '../academic-profile/academic-profile-retention.service.js';

export type CloseOwnAccountResult = {
    closedAt: Date;
    /** Retention days before the academic profile purge applies. */
    retentionDays: number;
};

type ClosurePool = Pick<Pool, 'connect'>;

type VerifyPassword = (plainPassword: string, hashedPassword: string) => Promise<boolean>;

/**
 * Close the caller's own student account.
 *
 * Accounts with a password must re-enter it (a stolen session alone must
 * not destroy an account). Passwordless accounts (no `password_hash`)
 * must send the exact confirmation phrase `CLOSE MY ACCOUNT` instead.
 */
export async function closeOwnAccount(
    pool: ClosurePool,
    userId: string,
    input: { password?: string | null; confirmation?: string | null },
    verifyPassword: VerifyPassword = (plain, hashed) => passwordService.comparePassword(plain, hashed),
): Promise<CloseOwnAccountResult> {
    // One transaction holds the row lock from credential verification
    // through the update: a password change landing in between must not
    // leave this request acting on a stale verified hash (the password
    // change path uses the same compare-and-swap discipline).
    const client = await pool.connect();
    let committedClosedAt: Date;
    let retentionDays = 0;
    try {
        await client.query('BEGIN');
        const account = await client.query<{ role: string; password_hash: string | null; deleted_at: Date | null }>(
            'SELECT role, password_hash, deleted_at FROM users WHERE id = $1 FOR UPDATE',
            [userId],
        );
        const row = account.rows[0];
        if (!row) throw new NotFoundError('Account not found');
        if (row.deleted_at !== null) throw new ConflictError('Account is already closed');
        if (row.role !== 'student') {
            throw new ConflictError('This account type cannot be closed from settings; contact support@awoof.tech');
        }

        // The public promise is purge after the retention window; without
        // a validated window the purge cannot run, so closure must refuse
        // rather than commit an account the schedule can never purge.
        try {
            retentionDays = resolveAcademicProfileRetentionDays(process.env[ACADEMIC_PROFILE_RETENTION_ENV_VAR] ?? null);
        } catch {
            throw new ServiceUnavailableError('Account closure is unavailable until the retention window is configured');
        }

        if (row.password_hash !== null) {
            if (!input.password || !(await verifyPassword(input.password, row.password_hash))) {
                throw new UnauthorizedError('Password confirmation failed');
            }
        // codeql[js/user-controlled-bypass]: the phrase is deliberate-confirmation
        // friction, not a credential. Authorization for passwordless accounts is
        // the authenticated school-backed session itself (closure revokes it
        // immediately), and closure is reversible by support within the
        // retention window, so a typed phrase cannot escalate privileges.
        } else if (input.confirmation !== 'CLOSE MY ACCOUNT') {
            throw new UnauthorizedError('Type CLOSE MY ACCOUNT to confirm account closure');
        }

        const closed = await client.query<{ deleted_at: Date }>(
            `UPDATE users
             SET deleted_at = CURRENT_TIMESTAMP,
                 refresh_token_hash = NULL,
                 refresh_token_expires_at = NULL,
                 active_session_id = NULL,
                 active_session_issued_at = NULL,
                 active_session_auth_identity_id = NULL,
                 credential_generation = credential_generation + 1,
             recovery_session_binding_required = true
             WHERE id = $1 AND deleted_at IS NULL
             RETURNING deleted_at`,
            [userId],
        );
        const closedAt = closed.rows[0]?.deleted_at;
        if (!closedAt) throw new ConflictError('Account is already closed');
        await client.query('COMMIT');
        committedClosedAt = closedAt;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
    const closedAt = committedClosedAt;

    return { closedAt, retentionDays };
}
