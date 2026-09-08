/**
 * Admin Platform Settings Controller
 *
 * Manages platform-wide settings (e.g. Awoof commission % on discounted total).
 */

import type { Response } from 'express';
import { db } from '../config/database.js';
import { ForbiddenError, UnauthorizedError } from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import { z } from 'zod';

const updatePlatformSettingsSchema = z.object({
    platform_fee_percent: z.coerce.number().min(0, 'Must be 0 or more').max(100, 'Must be 100 or less'),
});

export async function getPlatformSettings(req: AuthRequest, res: Response): Promise<void> {
    if (!req.user || req.user.role !== 'admin') {
        throw new UnauthorizedError('Admin access required');
    }

    const result = await db.query(
        'SELECT key, value, updated_at FROM platform_settings WHERE key = $1',
        ['platform_fee_percent']
    );

    const row = result.rows[0];
    const value = row ? parseFloat(row.value) : 10;

    success(res, {
        message: 'Platform settings retrieved',
        data: {
            platform_fee_percent: value,
            updated_at: row?.updated_at ?? null,
        },
    });
}

export async function updatePlatformSettings(req: AuthRequest, res: Response): Promise<void> {
    if (!req.user || req.user.role !== 'admin') {
        throw new UnauthorizedError('Admin access required');
    }

    const validated = updatePlatformSettingsSchema.parse(req.body);

    const client = await db.getPool().connect();
    try {
        await client.query('BEGIN');
        const actor = await client.query<{ role: string; deleted_at: Date | null }>(
            'SELECT role, deleted_at FROM users WHERE id = $1 FOR UPDATE', [req.user.userId],
        );
        if (actor.rows[0]?.role !== 'admin' || actor.rows[0].deleted_at !== null) {
            throw new ForbiddenError('Current administrator authority required');
        }
        await client.query(
            `INSERT INTO platform_settings (key, value, updated_at)
             VALUES ('platform_fee_percent', $1, CURRENT_TIMESTAMP)
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
            [String(validated.platform_fee_percent)],
        );
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }

    success(res, {
        message: 'Platform settings updated',
        data: {
            platform_fee_percent: validated.platform_fee_percent,
        },
    });
}
