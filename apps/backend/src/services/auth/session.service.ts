import { createHash } from 'node:crypto';
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

export async function issueSession(
    payload: TokenPayload,
    rememberMe: boolean = false,
    expectedPasswordHash?: string,
): Promise<TokenPair> {
    const tokens = jwtService.generateTokenPair(payload, rememberMe);
    const decoded = jwtService.verifyRefreshToken(tokens.refreshToken);
    const expiry = decoded.exp;

    if (typeof expiry !== 'number' || !Number.isFinite(expiry)) {
        throw new UnauthorizedError('Invalid refresh token expiry');
    }

    const result = await db.query(
        `UPDATE users
         SET refresh_token_hash = $2,
             refresh_token_expires_at = $3
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
        ],
    );

    if (result.rowCount === 0) {
        throw new UnauthorizedError('User session could not be issued');
    }

    return tokens;
}

export async function refreshSession(refreshToken: string): Promise<string> {
    let decoded: TokenPayload;
    try {
        decoded = jwtService.verifyRefreshToken(refreshToken);
    } catch {
        throw new UnauthorizedError('Invalid or expired refresh token');
    }

    const result = await db.query<{ id: string; email: string; role: TokenPayload['role'] }>(
        `SELECT u.id, u.email, u.role
         FROM users u
         WHERE u.id = $1
           AND u.refresh_token_hash = $2
           AND u.refresh_token_expires_at > CURRENT_TIMESTAMP
           AND u.deleted_at IS NULL
           AND ${currentProfilePredicate}`,
        [decoded.userId, refreshTokenHash(refreshToken)],
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
    });
}

export async function revokeSession(userId: string): Promise<void> {
    await db.query(
        `UPDATE users
         SET refresh_token_hash = NULL,
             refresh_token_expires_at = NULL
         WHERE id = $1`,
        [userId],
    );
}
