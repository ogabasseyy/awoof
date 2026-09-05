/**
 * Authentication Middleware
 *
 * Verifies JWT tokens and attaches user to request. We always call
 * verifyAccessToken (no user-controlled condition guarding it) so CodeQL
 * does not flag a "user-controlled bypass"; the only gate is the crypto check.
 */

import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { jwtService } from '../services/auth/jwt.service.js';
import { UnauthorizedError } from '../common/errors/AppError.js';
import { db } from '../config/database.js';

/**
 * Extended Express Request with user data
 */
export type AuthRequest = Request;

/** Extract Bearer token from request; returns empty string if missing/invalid format. */
function getBearerToken(req: Request): string {
    const h = req.headers.authorization;
    if (typeof h !== 'string' || !h.startsWith('Bearer ')) return '';
    return h.substring(7);
}

export const authenticate = (
    req: AuthRequest,
    _res: Response,
    next: NextFunction
): void => {
    const token = getBearerToken(req);
    try {
        const decoded = jwtService.verifyAccessToken(token);
        req.user = {
            ...decoded,
            id: decoded.userId,
        };
        next();
    } catch {
        next(new UnauthorizedError('Authentication failed'));
    }
};

/**
 * Optional authentication: try to verify and attach user; ignore failures.
 * Always calls verifyAccessToken (no user-controlled if guarding it).
 */
export const optionalAuth = (
    req: AuthRequest,
    _res: Response,
    next: NextFunction
): void => {
    const token = getBearerToken(req);
    try {
        const decoded = jwtService.verifyAccessToken(token);
        req.user = {
            ...decoded,
            id: decoded.userId,
        };
    } catch {
        // Invalid or expired – optional auth, ignore
    }
    next();
};

/**
 * Role-based authorization middleware factory
 */
export const requireRole = (...allowedRoles: string[]) => {
    return (req: AuthRequest, _res: Response, next: NextFunction): void => {
        if (!req.user) {
            return next(new UnauthorizedError('Authentication required'));
        }

        if (!allowedRoles.includes(req.user.role)) {
            return next(new UnauthorizedError('Insufficient permissions'));
        }

        next();
    };
};

/**
 * Vendor JWT or hashed reporting API key (`awoof_...`).
 */
export const authenticateVendorJwtOrApiKey = async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
): Promise<void> => {
    const token = getBearerToken(req);
    if (!token.startsWith('awoof_')) {
        authenticate(req, res, next);
        return;
    }

    try {
        const keys = await db.query(
            `SELECT k.key_hash, v.user_id, u.email
             FROM api_keys k
             JOIN vendors v ON v.id = k.vendor_id
             JOIN users u ON u.id = v.user_id
             WHERE k.status = 'active'
               AND k.lookup_hash = $1
               AND v.deleted_at IS NULL
               AND v.status = 'active'
               AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP)`,
            [crypto.createHash('sha256').update(token).digest('hex')]
        );
        if (keys.rows.length !== 1) {
            next(new UnauthorizedError('Authentication failed'));
            return;
        }
        const row = keys.rows[0];
        const [hashHex, saltHex] = String(row.key_hash).split(':');
        if (!hashHex || !saltHex) {
            next(new UnauthorizedError('Authentication failed'));
            return;
        }
        const computed = await new Promise<Buffer>((resolve, reject) => {
            crypto.pbkdf2(token, Buffer.from(saltHex, 'hex'), 100000, 32, 'sha256', (err, derived) => {
                if (err) reject(err);
                else resolve(derived);
            });
        });
        const expected = Buffer.from(hashHex, 'hex');
        if (computed.length !== expected.length || !crypto.timingSafeEqual(computed, expected)) {
            next(new UnauthorizedError('Authentication failed'));
            return;
        }
        req.user = {
            id: row.user_id,
            userId: row.user_id,
            email: row.email,
            role: 'vendor',
        };
        next();
    } catch (error) {
        next(error);
    }
};

