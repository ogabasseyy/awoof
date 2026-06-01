/**
 * Widget Config Controller
 *
 * Vendor-only: get and update widget_configs (allowed_domains, api_key).
 */

import type { Response } from 'express';
import { db } from '../config/database.js';
import { NotFoundError, UnauthorizedError } from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import { z } from 'zod';
import crypto from 'crypto';

const updateWidgetConfigSchema = z.object({
    allowedDomains: z.array(z.string().min(1)).min(1, 'At least one domain is required'),
});

function generateWidgetApiKey(): string {
    return `awoof_widget_${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * Get current vendor's widget config. Creates one with default if missing.
 */
export async function getWidgetConfig(req: AuthRequest, res: Response): Promise<void> {
    if (!req.user || req.user.role !== 'vendor') {
        throw new UnauthorizedError('Only vendors can access widget config');
    }

    const vendorResult = await db.query(
        `SELECT id FROM vendors WHERE user_id = $1 AND deleted_at IS NULL`,
        [req.user.userId]
    );
    if (vendorResult.rows.length === 0) {
        throw new NotFoundError('Vendor profile not found');
    }
    const vendorId = vendorResult.rows[0].id;

    let row = await db.query(
        `SELECT id, allowed_domains, api_key, status, created_at, updated_at
         FROM widget_configs WHERE vendor_id = $1`,
        [vendorId]
    );

    if (row.rows.length === 0) {
        const apiKey = generateWidgetApiKey();
        await db.query(
            `INSERT INTO widget_configs (vendor_id, allowed_domains, api_key, status)
             VALUES ($1, $2, $3, 'active')`,
            [vendorId, ['localhost'], apiKey]
        );
        row = await db.query(
            `SELECT id, allowed_domains, api_key, status, created_at, updated_at
             FROM widget_configs WHERE vendor_id = $1`,
            [vendorId]
        );
    }

    const c = row.rows[0];
    success(res, {
        message: 'Widget config retrieved',
        data: {
            vendorId,
            allowedDomains: c.allowed_domains || [],
            apiKey: c.api_key,
            status: c.status,
            createdAt: c.created_at,
            updatedAt: c.updated_at,
        },
    });
}

/**
 * Update allowed domains. Optionally regenerate API key.
 */
export async function updateWidgetConfig(req: AuthRequest, res: Response): Promise<void> {
    if (!req.user || req.user.role !== 'vendor') {
        throw new UnauthorizedError('Only vendors can update widget config');
    }

    const vendorResult = await db.query(
        `SELECT id FROM vendors WHERE user_id = $1 AND deleted_at IS NULL`,
        [req.user.userId]
    );
    if (vendorResult.rows.length === 0) {
        throw new NotFoundError('Vendor profile not found');
    }
    const vendorId = vendorResult.rows[0].id;

    const validated = updateWidgetConfigSchema.parse(req.body);
    const domains = validated.allowedDomains.map((d) => d.replace(/^https?:\/\//, '').split('/')[0].toLowerCase().trim()).filter(Boolean);
    if (domains.length === 0) {
        throw new Error('At least one valid domain is required');
    }

    const regenerateKey = Boolean(req.body.regenerateApiKey);

    let row = await db.query(
        `SELECT id, api_key FROM widget_configs WHERE vendor_id = $1`,
        [vendorId]
    );

    let apiKey: string;
    if (row.rows.length === 0) {
        apiKey = generateWidgetApiKey();
        await db.query(
            `INSERT INTO widget_configs (vendor_id, allowed_domains, api_key, status)
             VALUES ($1, $2, $3, 'active')`,
            [vendorId, domains, apiKey]
        );
    } else {
        apiKey = regenerateKey ? generateWidgetApiKey() : row.rows[0].api_key;
        await db.query(
            `UPDATE widget_configs SET allowed_domains = $1, api_key = $2, updated_at = CURRENT_TIMESTAMP WHERE vendor_id = $3`,
            [domains, apiKey, vendorId]
        );
    }

    success(res, {
        message: 'Widget config updated',
        data: {
            vendorId,
            allowedDomains: domains,
            apiKey: regenerateKey ? apiKey : undefined,
            status: 'active',
        },
    });
}
