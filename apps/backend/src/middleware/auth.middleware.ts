/**
 * Authentication Middleware
 *
 * Verifies JWT tokens and attaches user to request. We always call
 * verifyAccessToken (no user-controlled condition guarding it) so CodeQL
 * does not flag a "user-controlled bypass"; the only gate is the crypto check.
 */

import type { Request, Response, NextFunction } from 'express';
import { jwtService } from '../services/auth/jwt.service.js';
import { ServiceUnavailableError, UnauthorizedError } from '../common/errors/AppError.js';
import { getPool } from '../config/database.js';
import { authenticateReportingKey } from '../services/auth/reporting-key.service.js';

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
    void (async () => {
        try {
        const decoded = jwtService.verifyAccessToken(token);
        await requireCurrentStudentSession(decoded);
        req.user = {
            ...decoded,
            id: decoded.userId,
        };
            next();
        } catch (error) {
            next(error instanceof ServiceUnavailableError ? error : new UnauthorizedError('Authentication failed'));
        }
    })();
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
    void (async () => {
        try {
        const decoded = jwtService.verifyAccessToken(token);
        await requireCurrentStudentSession(decoded);
        req.user = {
            ...decoded,
            id: decoded.userId,
        };
        } catch (error) {
            // A cryptographically invalid token remains anonymous. A durable
            // student-session lookup outage must not attach a possibly stale
            // policy-account identity, so surface an explicit retryable 503.
            if (error instanceof ServiceUnavailableError) return next(error);
        }
        next();
    })();
};

/**
 * Student access tokens carrying a session id are bound to the server's
 * live session: password and SSO sign-ins share one session family, so a
 * token whose session rotated, logged out, or was revoked (recovery,
 * unlink of the issuing identity) is rejected here instead of surviving
 * until JWT expiry. Sid-less legacy tokens keep their existing semantics
 * except on recovered accounts, which stay session-bound permanently;
 * vendor/admin tokens never reach this gate.
 */
async function requireCurrentStudentSession(decoded: { userId: string; role: string; sid?: string }): Promise<void> {
    if (decoded.role !== 'student') return;
    let result;
    try {
        result = await getPool().query<{
            password_setup_requires_recovery_code: boolean;
            recovery_reenrollment_requires_password: boolean;
            recovery_session_binding_required: boolean;
            active_session_id: string | null;
            deleted_at: Date | null;
        }>(
            `SELECT password_setup_requires_recovery_code, recovery_reenrollment_requires_password,
                    recovery_session_binding_required, active_session_id, deleted_at
             FROM users WHERE id = $1`, [decoded.userId],
        );
    } catch {
        throw new ServiceUnavailableError('Student session validation is temporarily unavailable');
    }
    const account = result.rows[0];
    // Preserve downstream live-identity semantics for absent and ordinary
    // deleted accounts. Credential-policy accounts stay bound even without
    // a token session id, because recovery must invalidate their access
    // JWTs; every other sid-carrying token must match the live session.
    if (!account) return;
    // The re-enrollment marker clears at activation, but the binding it
    // imposed must outlive it: recovery_session_binding_required persists
    // so a legacy sid-less token can never resurrect after re-enrollment.
    const sessionBound = account.password_setup_requires_recovery_code || account.recovery_reenrollment_requires_password
        || account.recovery_session_binding_required;
    if (account.deleted_at !== null && !sessionBound) return;
    if ((!decoded.sid && sessionBound) || (decoded.sid && account.active_session_id !== decoded.sid)) {
        throw new UnauthorizedError('Authentication failed');
    }
}

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
        const row = await authenticateReportingKey(getPool(), token);
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
