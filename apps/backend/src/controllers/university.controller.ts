/**
 * University Controller
 * 
 * Handles university listing and verification methods
 * Follows Single Responsibility Principle - only handles university operations
 */

import type { Request, Response } from 'express';
import { db } from '../config/database.js';
import { AppError } from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';

/**
 * University Controller
 */
export class UniversityController {
    /**
     * List all active universities
     */
    public async listUniversities(req: Request, res: Response): Promise<void> {
        // Get query params for filtering
        const country = req.query.country as string | undefined;
        const search = req.query.search as string | undefined;

        let query = `
            SELECT 
                id,
                name,
                domain,
                country,
                portal_url,
                database_api_url,
                shortcode,
                segment,
                COALESCE(email_domains, '[]'::jsonb) AS email_domains,
                is_active,
                created_at
            FROM universities
            WHERE is_active = true
        `;
        const params: unknown[] = [];
        let paramCount = 1;

        if (country) {
            query += ` AND country = $${paramCount++}`;
            params.push(country);
        }

        if (search) {
            const pattern = `%${search}%`;
            query += ` AND (name ILIKE $${paramCount} OR domain ILIKE $${paramCount} OR shortcode ILIKE $${paramCount})`;
            params.push(pattern);
            paramCount++;
        }

        query += ` ORDER BY name ASC`;

        const result = await db.query(query, params);

        const universities = result.rows.map((u: Record<string, unknown>) => ({
            id: u.id,
            name: u.name,
            domain: u.domain,
            country: u.country,
            portalUrl: u.portal_url,
            databaseApiUrl: u.database_api_url,
            shortcode: u.shortcode,
            segment: u.segment,
            emailDomains: u.email_domains || [],
            isActive: u.is_active,
            createdAt: u.created_at,
        }));

        success(res, {
            message: 'Universities retrieved successfully',
            data: {
                universities,
                total: universities.length,
            },
        });
    }

    /**
     * Get available verification methods for a university
     */
    public async getVerificationMethods(): Promise<void> {
        throw new AppError('Use the sanitized verification availability endpoint at /api/verification/methods/:universityId.', 410, 'VERIFICATION_ROUTE_RETIRED');
    }
}
