import type { Request, Response, NextFunction } from 'express';
import { db } from '../config/database.js';
import { ForbiddenError } from '../common/errors/AppError.js';

/** Cached JWT roles cannot retain access to admin data after demotion/deletion. */
export async function requireCurrentAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
        const actor = await db.query<{ role: string; deleted_at: Date | null }>(
            'SELECT role, deleted_at FROM users WHERE id = $1', [req.user?.userId],
        );
        if (actor.rows[0]?.role !== 'admin' || actor.rows[0].deleted_at !== null) {
            throw new ForbiddenError('Current administrator authority required');
        }
        next();
    } catch (error) { next(error); }
}
