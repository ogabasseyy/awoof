import type { NextFunction, Request, Response } from 'express';
import { getPool } from '../config/database.js';
import { jwtService } from '../services/auth/jwt.service.js';
import { withMicrosoftSession, type MicrosoftSessionUse } from '../services/verification/microsoft-session.service.js';
import { UnauthorizedError } from '../common/errors/AppError.js';

function bearer(req: Request): string {
    const value = req.headers.authorization;
    return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
}

/** Scoped only: existing auth routes retain their historic authorization semantics. */
export function requireMicrosoftSession(use: MicrosoftSessionUse = 'issuance') {
    return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
        let decoded;
        try {
            decoded = jwtService.verifyAccessToken(bearer(req));
        } catch {
            next(new UnauthorizedError('Authentication failed'));
            return;
        }
        try {
            const session = await withMicrosoftSession(getPool(), { userId: decoded.userId, sid: decoded.sid, use }, async (_tx, live) => live);
            req.user = { ...decoded, id: decoded.userId };
            // Keep the signed value explicitly present for future route handlers.
            req.user.sid = session.sid;
            next();
        } catch (error) {
            // Preserve operational database failures; only JWT verification is
            // normalized above so it cannot become a 500.
            next(error);
        }
    };
}
