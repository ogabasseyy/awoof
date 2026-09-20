import type { Pool, PoolClient } from 'pg';
import { AppError, UnauthorizedError } from '../../common/errors/AppError.js';

export type MicrosoftSessionUse = 'issuance' | 'owner';

export interface LiveMicrosoftSession {
    userId: string;
    email: string;
    sid: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reauthenticationRequired(): AppError {
    return new AppError('Microsoft verification requires reauthentication', 401, 'reauthentication_required');
}

/**
 * Rechecks the server session inside the caller's authority transaction. This
 * deliberately locks users before students; callers that need an attempt must
 * call lockMicrosoftAttempt only after this succeeds. Never perform HTTP while
 * this transaction is open.
 */
export async function assertMicrosoftSession(
    tx: PoolClient,
    userId: string,
    sid: unknown,
    use: MicrosoftSessionUse,
): Promise<LiveMicrosoftSession> {
    if (typeof sid !== 'string' || !UUID.test(sid)) throw reauthenticationRequired();

    const lockedUser = await tx.query<{ id: string; email: string }>(
        `SELECT id, email FROM users
         WHERE id = $1 AND role = 'student' AND deleted_at IS NULL
         FOR UPDATE`,
        [userId],
    );
    if (lockedUser.rowCount !== 1 || !lockedUser.rows[0]) throw reauthenticationRequired();

    // This is intentionally a second query after FOR UPDATE. A WHERE predicate
    // evaluated before a blocked lock can use an elapsed session; this check
    // sees the locked row with a fresh database wall clock.
    const liveSession = await tx.query<{ id: string }>(
        `SELECT id FROM users
         WHERE id = $1 AND active_session_id = $2::uuid
           AND refresh_token_hash IS NOT NULL
           AND refresh_token_expires_at > clock_timestamp()`,
        [userId, sid],
    );
    if (liveSession.rowCount !== 1) throw reauthenticationRequired();

    const student = await tx.query<{ status: string }>(
        'SELECT status FROM students WHERE user_id = $1 FOR UPDATE',
        [userId],
    );
    if (student.rowCount !== 1 || !student.rows[0]) throw new UnauthorizedError('Student profile unavailable');
    if (use === 'issuance' && student.rows[0].status !== 'active') {
        throw new UnauthorizedError('Microsoft verification issuance requires an active student profile');
    }
    return { userId: lockedUser.rows[0].id, email: lockedUser.rows[0].email, sid };
}

/**
 * Lock an attempt last: assertMicrosoftSession locks user then student first;
 * Task 2b then locks canonical institution/state/consent participants before
 * this attempt lock. This helper must not be used as a shortcut that treats
 * user/student locks as sufficient attempt authority.
 */
export async function lockMicrosoftAttempt(tx: PoolClient, attemptId: string): Promise<void> {
    await tx.query('SELECT id FROM microsoft_verification_attempts WHERE id = $1 FOR UPDATE', [attemptId]);
}

/** Convenience wrapper for start/callback/finish authority sections. */
export async function withMicrosoftSession<T>(
    pool: Pool,
    input: { userId: string; sid: unknown; use: MicrosoftSessionUse },
    operation: (tx: PoolClient, session: LiveMicrosoftSession) => Promise<T>,
): Promise<T> {
    const tx = await pool.connect();
    try {
        await tx.query('BEGIN');
        const session = await assertMicrosoftSession(tx, input.userId, input.sid, input.use);
        const result = await operation(tx, session);
        await tx.query('COMMIT');
        return result;
    } catch (error) {
        await tx.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        tx.release();
    }
}
