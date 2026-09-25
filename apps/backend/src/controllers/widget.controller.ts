/**
 * Widget Controller
 *
 * Public endpoints for the embeddable student verification widget.
 * Used by third-party vendor sites to check domain allowlist and integrate verification.
 */

import type { Request, Response } from 'express';
import { db } from '../config/database.js';
import { BadRequestError, ForbiddenError } from '../common/errors/AppError.js';
import { canonicalWidgetOrigin } from '../services/verification/eligibility-merchant-context.service.js';
import { success } from '../common/utils/response.js';
import { z } from 'zod';

const domainCheckSchema = z.object({
    domain: z.string().min(1, 'Domain is required'),
    apiKey: z.string().min(1, 'API key is required'),
    origin: z.string().optional(),
});
const contextSchema = z.object({ vendorId: z.string().uuid(), origin: z.string().max(512) }).strict();

/**
 * Check if a domain is allowed for a given widget API key.
 * Used by the widget on load to validate the vendor's domain allowlist.
 *
 * POST-only with a JSON body. The API key must never travel in the URL:
 * query strings land in access logs, proxy/CDN logs, browser history,
 * and Referer headers. Query parameters are deliberately not read here.
 */
export async function domainCheck(req: Request, res: Response): Promise<void> {
    const parsed = domainCheckSchema.safeParse({
        domain: req.body?.domain,
        apiKey: req.body?.apiKey ?? req.body?.api_key,
        origin: req.body?.origin,
    });

    if (!parsed.success) {
        throw new BadRequestError(parsed.error.errors.map((e) => e.message).join('; '));
    }

    const { domain, apiKey } = parsed.data;

    // Normalize domain: strip protocol and path, lowercase
    const hostname = (domain.replace(/^https?:\/\//, '').split('/')[0] ?? '').toLowerCase().trim();
    if (!hostname) {
        throw new BadRequestError('Invalid domain');
    }

    const origin = parsed.data.origin === undefined ? null : canonicalWidgetOrigin(parsed.data.origin);
    if (origin && new URL(origin).hostname !== hostname) throw new BadRequestError('Domain and origin differ');
    const result = await db.query(
        `SELECT wc.vendor_id FROM widget_configs wc
         JOIN vendors v ON v.id = wc.vendor_id AND v.status = 'active' AND v.deleted_at IS NULL
         WHERE wc.api_key = $1 AND wc.status = 'active' AND $2 = ANY(wc.allowed_domains)
           AND ($3::text IS NULL OR $3 = ANY(wc.allowed_origins))`,
        [apiKey, hostname, origin]
    );

    if (result.rows.length === 0) {
        throw new ForbiddenError('Domain is not allowed for this widget. Add this domain in your Awoof vendor dashboard.');
    }

    success(res, {
        message: 'Domain allowed',
        data: {
            allowed: true,
            vendorId: result.rows[0].vendor_id,
        },
    });
}

/** Public display context for the hosted pilot. Never returns a secret or a student result. */
export async function merchantContext(req: Request, res: Response): Promise<void> {
    const input = contextSchema.parse(req.body);
    const pilotVendors = (process.env.AWOOF_WIDGET_PILOT_VENDOR_IDS ?? '').split(',').map((id) => id.trim().toLowerCase());
    if (process.env.AWOOF_WIDGET_PILOT_ENABLED !== 'true' || !pilotVendors.includes(input.vendorId.toLowerCase())) {
        throw new ForbiddenError('Hosted merchant context is unavailable');
    }
    const origin = canonicalWidgetOrigin(input.origin);
    const result = await db.query<{ name: string }>(
        `SELECT v.name FROM vendors v JOIN widget_configs wc ON wc.vendor_id = v.id
         WHERE v.id = $1 AND v.status = 'active' AND v.deleted_at IS NULL
           AND wc.status = 'active' AND $2 = ANY(wc.allowed_origins)`,
        [input.vendorId, origin],
    );
    if (result.rowCount !== 1) throw new ForbiddenError('Merchant origin is unavailable');
    res.set('Cache-Control', 'no-store');
    success(res, { message: 'Merchant context', data: { vendorId: input.vendorId, origin, merchantName: result.rows[0]!.name } });
}
