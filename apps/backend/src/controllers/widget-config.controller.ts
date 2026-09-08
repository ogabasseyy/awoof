/**
 * Widget Config Controller
 *
 * Vendor-only: get and update widget_configs (allowed_domains, api_key).
 */

import type { Response } from 'express';
import { db } from '../config/database.js';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../common/errors/AppError.js';
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
        `SELECT id FROM vendors WHERE user_id = $1 AND status = 'active' AND deleted_at IS NULL`,
        [req.user.userId]
    );
    if (vendorResult.rows.length === 0) {
        throw new NotFoundError('Vendor profile not found');
    }
    const vendorId = vendorResult.rows[0].id;

    await db.query(
        `INSERT INTO widget_configs (vendor_id, allowed_domains, allowed_origins, api_key, status)
         VALUES ($1, $2, $3, $4, 'active') ON CONFLICT (vendor_id) DO NOTHING`,
        [vendorId, ['localhost'], ['https://localhost'], generateWidgetApiKey()]);
    const row = await db.query(
        `SELECT id, allowed_domains, allowed_origins, api_key, status, created_at, updated_at
         FROM widget_configs WHERE vendor_id = $1`, [vendorId]);

    const c = row.rows[0];
    success(res, {
        message: 'Widget config retrieved',
        data: {
            vendorId,
            allowedDomains: c.allowed_domains || [],
            allowedOrigins: c.allowed_origins || [],
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
        `SELECT id FROM vendors WHERE user_id = $1 AND status = 'active' AND deleted_at IS NULL`,
        [req.user.userId]
    );
    if (vendorResult.rows.length === 0) {
        throw new NotFoundError('Vendor profile not found');
    }
    const vendorId = vendorResult.rows[0].id;

    const validated = updateWidgetConfigSchema.parse(req.body);
    const domains = [...new Set(validated.allowedDomains.map((value) => {
        let parsed: URL;
        try { parsed = new URL(value.trim().includes('://') ? value.trim() : `https://${value.trim()}`); }
        catch { throw new BadRequestError('Enter a valid HTTPS hostname'); }
        if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password
            || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.hostname.includes('*')) {
            throw new BadRequestError('Widget domains must be HTTPS hostnames without ports, paths or credentials');
        }
        return parsed.hostname.toLowerCase();
    }))];
    const origins = domains.map((hostname) => `https://${hostname}`);

    const regenerateKey = Boolean(req.body.regenerateApiKey);

    const row = await db.query(
        `INSERT INTO widget_configs (vendor_id, allowed_domains, allowed_origins, api_key, status)
         VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT (vendor_id) DO UPDATE
         SET allowed_domains = EXCLUDED.allowed_domains, allowed_origins = EXCLUDED.allowed_origins,
             api_key = CASE WHEN $5 THEN EXCLUDED.api_key ELSE widget_configs.api_key END,
             updated_at = CURRENT_TIMESTAMP
         RETURNING api_key, status`,
        [vendorId, domains, origins, generateWidgetApiKey(), regenerateKey]);
    const apiKey = row.rows[0].api_key;

    success(res, {
        message: 'Widget config updated',
        data: {
            vendorId,
            allowedDomains: domains,
            allowedOrigins: origins,
            apiKey: regenerateKey ? apiKey : undefined,
            status: row.rows[0].status,
        },
    });
}
