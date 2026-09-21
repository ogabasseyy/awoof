import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../../config/database.js';
import { UnauthorizedError } from '../../common/errors/AppError.js';
import { jwtService, type TokenPair, type TokenPayload } from './jwt.service.js';

const refreshTokenHash = (refreshToken: string): string =>
    createHash('sha256').update(refreshToken).digest('hex');

const activeProfilePredicate = `
    (
        ($5::text = 'admin')
        OR ($5::text = 'student' AND EXISTS (
            SELECT 1 FROM students WHERE students.user_id = users.id AND students.status = 'active'
        ))
        OR ($5::text = 'vendor' AND EXISTS (
            SELECT 1 FROM vendors
            WHERE vendors.user_id = users.id
              AND vendors.deleted_at IS NULL
              AND vendors.status IN ('pending', 'active')
        ))
    )`;

const currentProfilePredicate = `
    (
        u.role = 'admin'
        OR (u.role = 'student' AND EXISTS (
            SELECT 1 FROM students WHERE students.user_id = u.id AND students.status = 'active'
        ))
        OR (u.role = 'vendor' AND EXISTS (
            SELECT 1 FROM vendors
            WHERE vendors.user_id = u.id
              AND vendors.deleted_at IS NULL
              AND vendors.status IN ('pending', 'active')
        ))
    )`;

/**
 * Transaction-scoped session writer. This is the only session-issuance SQL:
 * password and SSO sign-ins share it (no parallel session system). It uses
 * only the supplied client, so a caller that already holds the user lock
 * never needs a second pool connection. Password provenance writes NULL;
 * SSO callers overwrite the identity column in the same transaction.
 */
export async function issueSessionInTransaction(
    tx: PoolClient,
    payload: TokenPayload,
    rememberMe: boolean = false,
    expectedPasswordHash?: string,
): Promise<TokenPair> {
    // A fresh sign-in starts a new server-authoritative session family. Ignore
    // any sid supplied by a caller or stale profile object.
    const sid = randomUUID();
    const tokens = jwtService.generateTokenPair({ ...payload, sid }, rememberMe);
    const decoded = jwtService.verifyRefreshToken(tokens.refreshToken);
    const expiry = decoded.exp;

    if (typeof expiry !== 'number' || !Number.isFinite(expiry)) {
        throw new UnauthorizedError('Invalid refresh token expiry');
    }

    const result = await tx.query(
        `UPDATE users
         SET refresh_token_hash = $2,
             refresh_token_expires_at = $3,
             active_session_id = $6,
             active_session_auth_identity_id = NULL
         WHERE id = $1
           AND deleted_at IS NULL
           AND ($4::text IS NULL OR password_hash = $4)
           AND role = $5
           AND ${activeProfilePredicate}
         RETURNING id`,
        [
            payload.userId,
            refreshTokenHash(tokens.refreshToken),
            new Date(expiry * 1000),
            expectedPasswordHash ?? null,
            payload.role,
            sid,
        ],
    );

    if (result.rowCount === 0) {
        throw new UnauthorizedError('User session could not be issued');
    }

    return tokens;
}

export async function issueSession(
    payload: TokenPayload,
    rememberMe: boolean = false,
    expectedPasswordHash?: string,
): Promise<TokenPair> {
    const client = await db.getPool().connect();
    try {
        await client.query('BEGIN');
        const tokens = await issueSessionInTransaction(client, payload, rememberMe, expectedPasswordHash);
        await client.query('COMMIT');
        return tokens;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

export async function refreshSession(refreshToken: string): Promise<string> {
    let decoded: TokenPayload;
    try {
        decoded = jwtService.verifyRefreshToken(refreshToken);
    } catch {
        throw new UnauthorizedError('Invalid or expired refresh token');
    }

    const sid = isUuid(decoded.sid) ? decoded.sid : undefined;
    // Legacy tokens retain their existing non-Microsoft behavior, but cannot
    // refresh across a newly bound session family.
    const sidPredicate = sid === undefined ? 'AND u.active_session_id IS NULL' : 'AND u.active_session_id = $3::uuid';
    const result = await db.query<{ id: string; email: string; role: TokenPayload['role'] }>(
        `SELECT u.id, u.email, u.role
         FROM users u
         WHERE u.id = $1
           AND u.refresh_token_hash = $2
           AND u.refresh_token_expires_at > CURRENT_TIMESTAMP
           AND u.deleted_at IS NULL
           ${sidPredicate}
           AND ${currentProfilePredicate}`,
        sid === undefined ? [decoded.userId, refreshTokenHash(refreshToken)] : [decoded.userId, refreshTokenHash(refreshToken), sid],
    );

    if (result.rowCount === 0) {
        throw new UnauthorizedError('Refresh token not found or invalid');
    }

    const user = result.rows[0];
    if (!user) {
        throw new UnauthorizedError('Refresh token not found or invalid');
    }
    return jwtService.generateAccessToken({
        userId: user.id,
        email: user.email,
        role: user.role,
        ...(sid === undefined ? {} : { sid }),
    });
}

export async function revokeSession(userId: string): Promise<void> {
    await db.query(
        `UPDATE users
         SET refresh_token_hash = NULL,
             refresh_token_expires_at = NULL,
             active_session_id = NULL,
             active_session_auth_identity_id = NULL
         WHERE id = $1`,
        [userId],
    );
}

/** A captured refresh credential can revoke itself, never a replacement login. */
export async function revokeSessionByRefreshToken(refreshToken: string): Promise<void> {
    let decoded: TokenPayload;
    try { decoded = jwtService.verifyRefreshToken(refreshToken); }
    catch { throw new UnauthorizedError('Invalid or expired refresh token'); }
    await db.query(`UPDATE users SET refresh_token_hash = NULL, refresh_token_expires_at = NULL, active_session_id = NULL,
        active_session_auth_identity_id = NULL
        WHERE id = $1 AND refresh_token_hash = $2`, [decoded.userId, refreshTokenHash(refreshToken)]);
}

function isUuid(value: unknown): value is string {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
