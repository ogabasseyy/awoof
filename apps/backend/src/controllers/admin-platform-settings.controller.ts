/**
 * Admin Platform Settings Controller
 *
 * Manages platform-wide settings (e.g. Awoof commission % on discounted total).
 */

import type { Response } from 'express';
import { db } from '../config/database.js';
import { UnauthorizedError } from '../common/errors/AppError.js';
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

    await db.query(
        `INSERT INTO platform_settings (key, value, updated_at)
         VALUES ('platform_fee_percent', $1, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
        [String(validated.platform_fee_percent)]
    );

    success(res, {
        message: 'Platform settings updated',
        data: {
            platform_fee_percent: validated.platform_fee_percent,
        },
    });
}
