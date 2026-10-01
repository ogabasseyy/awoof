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
import { canonicalWidgetOrigin } from '../services/verification/eligibility-merchant-context.service.js';

const updateWidgetConfigSchema = z.object({
    allowedDomains: z.array(z.string().min(1)).min(1, 'At least one domain is required'),
    allowedOrigins: z.array(z.string().min(1).max(512)).min(1, 'At least one origin is required').optional(),
    regenerateApiKey: z.boolean().optional(),
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
 * Origins to store when an update omits allowedOrigins.
 *
 * Stored origins whose hostname is still in the new domain list are kept
 * byte-identical: enforcement compares exact canonical strings, so keeping
 * them unchanged cannot newly authorize anything. Hostnames with no kept
 * origin get the historical derived https form. Entries that no longer
 * parse, or whose hostname was removed, are dropped: unparseable entries
 * can never match enforcement because the enforcement input is always
 * canonicalized before comparison.
 */
async function omittedOrigins(vendorId: string, domains: string[]): Promise<string[]> {
    const existing = await db.query<{ allowed_origins: unknown }>(
        `SELECT allowed_origins FROM widget_configs WHERE vendor_id = $1`,
        [vendorId]
    );
    const wanted = new Set(domains);
    const kept: string[] = [];
    const covered = new Set<string>();
    const stored = existing.rows[0]?.allowed_origins;
    if (Array.isArray(stored)) {
        for (const origin of stored) {
            if (typeof origin !== 'string') continue;
            let hostname: string;
            try {
                hostname = new URL(origin).hostname.toLowerCase();
            } catch {
                continue;
            }
            if (!wanted.has(hostname)) continue;
            kept.push(origin);
            covered.add(hostname);
        }
    }
    for (const hostname of domains) {
        if (!covered.has(hostname)) kept.push(`https://${hostname}`);
    }
    return [...new Set(kept)];
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
    // Exact origins (ports, localhost HTTP in development) use the same
    // canonicalization the enforcement path applies, so anything stored
    // here can actually match a later domain-check or merchant-context
    // call. An explicit list replaces the stored origins, but every origin
    // must belong to a submitted domain: domain-check requires both lists
    // to match while merchant-context consults origins alone, so a
    // mismatched pair would leave a contradictory configuration. An
    // omitted list keeps stored origins whose hostname is still allowed —
    // so adding or removing an unrelated domain cannot silently delete a
    // custom origin such as https://shop.example.com:8443 — and derives
    // default https forms only for newly uncovered hostnames.
    const wanted = new Set(domains);
    const origins = validated.allowedOrigins === undefined
        ? await omittedOrigins(vendorId, domains)
        : [...new Set(validated.allowedOrigins.map((origin) => {
            const canonical = canonicalWidgetOrigin(origin);
            if (!wanted.has(new URL(canonical).hostname.toLowerCase())) {
                throw new BadRequestError('Each allowed origin must belong to a submitted allowed domain');
            }
            return canonical;
        }))];

    const regenerateKey = validated.regenerateApiKey === true;

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
