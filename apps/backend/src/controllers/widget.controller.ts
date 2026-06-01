/**
 * Widget Controller
 *
 * Public endpoints for the embeddable student verification widget.
 * Used by third-party vendor sites to check domain allowlist and integrate verification.
 */

import type { Request, Response } from 'express';
import { db } from '../config/database.js';
import { BadRequestError, ForbiddenError } from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import { z } from 'zod';

const domainCheckSchema = z.object({
    domain: z.string().min(1, 'Domain is required'),
    apiKey: z.string().min(1, 'API key is required'),
});

/**
 * Check if a domain is allowed for a given widget API key.
 * Used by the widget on load to validate the vendor's domain allowlist.
 */
export async function domainCheck(req: Request, res: Response): Promise<void> {
    const parsed = domainCheckSchema.safeParse({
        domain: req.query.domain ?? req.body?.domain,
        apiKey: req.query.apiKey ?? req.query.api_key ?? req.body?.apiKey ?? req.body?.api_key,
    });

    if (!parsed.success) {
        throw new BadRequestError(parsed.error.errors.map((e) => e.message).join('; '));
    }

    const { domain, apiKey } = parsed.data;

    // Normalize domain: strip protocol and path, lowercase
    const hostname = domain.replace(/^https?:\/\//, '').split('/')[0].toLowerCase().trim();
    if (!hostname) {
        throw new BadRequestError('Invalid domain');
    }

    const result = await db.query(
        `SELECT vendor_id FROM widget_configs
         WHERE api_key = $1 AND status = 'active' AND $2 = ANY(allowed_domains)`,
        [apiKey, hostname]
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
