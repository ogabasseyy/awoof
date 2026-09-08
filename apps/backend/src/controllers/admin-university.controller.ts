/**
 * Admin University Controller
 *
 * CRUD, pagination, search, CSV import, segment stats for universities
 */

import { deactivateInstitution } from './admin-institution-policy.controller.js';
import type { Request, Response } from 'express';
import { db } from '../config/database.js';
import { NotFoundError, BadRequestError } from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import { z } from 'zod';

const createUniversitySchema = z.object({
    name: z.string().min(2),
    domain: z.string().min(2),
    email_domains: z.union([z.string(), z.array(z.string())]).optional(),
    segment: z.enum(['federal', 'state', 'private']).optional(),
    country: z.string().optional(),
    is_active: z.boolean().optional().default(true),
});

const updateUniversitySchema = createUniversitySchema.partial();

function parseEmailDomains(val: string | string[] | undefined): string[] {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    try {
        const parsed = JSON.parse(val);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return val.split(',').map((s) => s.trim()).filter(Boolean);
    }
}

function domainToShortcode(domain: string): string {
    return domain.split('.')[0]?.toLowerCase() || '';
}

export class AdminUniversityController {
    async getUniversities(req: Request, res: Response): Promise<void> {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        const search = (req.query.search as string)?.trim();
        const offset = (page - 1) * limit;

        let countQuery = `SELECT COUNT(*)::int FROM universities WHERE 1=1`;
        let listQuery = `
            SELECT id, name, domain, email_domains, segment, shortcode, country, is_active, created_at,
                EXISTS (SELECT 1 FROM approved_student_email_domains d WHERE d.university_id = universities.id AND d.is_active) AS policy_configured
            FROM universities
            WHERE 1=1
        `;
        const params: unknown[] = [];
        let idx = 1;

        if (search) {
            const pattern = `%${search}%`;
            countQuery += ` AND (name ILIKE $${idx} OR domain ILIKE $${idx} OR shortcode ILIKE $${idx})`;
            listQuery += ` AND (name ILIKE $${idx} OR domain ILIKE $${idx} OR shortcode ILIKE $${idx})`;
            params.push(pattern);
            idx++;
        }

        const countResult = await db.query(countQuery, params);
        const total = countResult.rows[0]?.count ?? 0;

        listQuery += ` ORDER BY name ASC LIMIT $${idx} OFFSET $${idx + 1}`;
        params.push(limit, offset);

        const result = await db.query(listQuery, params);
        const universities = result.rows.map((u) => ({
            id: u.id,
            name: u.name,
            domain: u.domain,
            emailDomains: u.email_domains || [],
            policyConfigured: Boolean(u.policy_configured),
            segment: u.segment,
            shortcode: u.shortcode,
            country: u.country,
            isActive: u.is_active,
            createdAt: u.created_at,
        }));

        success(res, {
            message: 'Universities retrieved successfully',
            data: { universities, total, page, limit },
        });
    }

    async getUniversity(req: Request, res: Response): Promise<void> {
        const { id } = req.params;
        const result = await db.query(
            `SELECT id, name, domain, email_domains, segment, shortcode, country, is_active, created_at, updated_at
             FROM universities WHERE id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            throw new NotFoundError('University not found');
        }

        const u = result.rows[0];
        success(res, {
            message: 'University retrieved successfully',
            data: {
                id: u.id,
                name: u.name,
                domain: u.domain,
                emailDomains: u.email_domains || [],
                segment: u.segment,
                shortcode: u.shortcode,
                country: u.country,
                isActive: u.is_active,
                createdAt: u.created_at,
                updatedAt: u.updated_at,
            },
        });
    }

    async createUniversity(req: Request, res: Response): Promise<void> {
        const parsed = createUniversitySchema.parse(req.body);
        const emailDomains = parseEmailDomains(parsed.email_domains);
        const shortcode = domainToShortcode(parsed.domain);

        const result = await db.query(
            `INSERT INTO universities (name, domain, email_domains, segment, shortcode, country, is_active)
             VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
             RETURNING id, name, domain, email_domains, segment, shortcode, country, is_active, created_at`,
            [
                parsed.name,
                parsed.domain,
                JSON.stringify(emailDomains),
                parsed.segment || null,
                shortcode,
                parsed.country || null,
                parsed.is_active ?? true,
            ]
        );

        const u = result.rows[0];
        success(
            res,
            {
                message: 'University created successfully',
                data: {
                    id: u.id,
                    name: u.name,
                    domain: u.domain,
                    emailDomains: u.email_domains || [],
                    segment: u.segment,
                    shortcode: u.shortcode,
                    country: u.country,
                    isActive: u.is_active,
                    createdAt: u.created_at,
                },
            },
            201
        );
    }

    async updateUniversity(req: Request, res: Response): Promise<void> {
        const { id } = req.params;
        const parsed = updateUniversitySchema.parse(req.body);

        const existing = await db.query('SELECT id, domain FROM universities WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
            throw new NotFoundError('University not found');
        }

        const domain = parsed.domain ?? existing.rows[0].domain;
        const shortcode = domainToShortcode(domain);

        let emailDomains: string[] | undefined;
        if (parsed.email_domains !== undefined) {
            emailDomains = parseEmailDomains(parsed.email_domains);
        }

        const updates: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (parsed.name !== undefined) {
            updates.push(`name = $${idx++}`);
            values.push(parsed.name);
        }
        if (parsed.domain !== undefined) {
            updates.push(`domain = $${idx++}`);
            values.push(parsed.domain);
        }
        if (emailDomains !== undefined) {
            updates.push(`email_domains = $${idx++}::jsonb`);
            values.push(JSON.stringify(emailDomains));
        }
        if (parsed.segment !== undefined) {
            updates.push(`segment = $${idx++}`);
            values.push(parsed.segment);
        }
        updates.push(`shortcode = $${idx++}`);
        values.push(shortcode);
        if (parsed.country !== undefined) {
            updates.push(`country = $${idx++}`);
            values.push(parsed.country);
        }
        if (parsed.is_active !== undefined) {
            updates.push(`is_active = $${idx++}`);
            values.push(parsed.is_active);
        }

        values.push(id);
        const result = await db.query(
            `UPDATE universities SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
             WHERE id = $${idx} RETURNING id, name, domain, email_domains, segment, shortcode, country, is_active, created_at, updated_at`,
            values
        );

        const u = result.rows[0];
        success(res, {
            message: 'University updated successfully',
            data: {
                id: u.id,
                name: u.name,
                domain: u.domain,
                emailDomains: u.email_domains || [],
                segment: u.segment,
                shortcode: u.shortcode,
                country: u.country,
                isActive: u.is_active,
                createdAt: u.created_at,
                updatedAt: u.updated_at,
            },
        });
    }

    async deleteUniversity(req: Request, res: Response): Promise<void> {
        await deactivateInstitution(req, res);
    }

    async getSegmentStats(_req: Request, res: Response): Promise<void> {
        const result = await db.query(`
            SELECT u.segment, COUNT(DISTINCT u.id) AS university_count, COUNT(DISTINCT s.id) AS student_count
            FROM universities u
            LEFT JOIN students s ON s.university_id = u.id AND s.status = 'active'
            WHERE u.segment IS NOT NULL
            GROUP BY u.segment
        `);

        const stats: Record<string, { universityCount: number; studentCount: number }> = {};
        for (const row of result.rows) {
            stats[row.segment] = {
                universityCount: parseInt(row.university_count, 10) || 0,
                studentCount: parseInt(row.student_count, 10) || 0,
            };
        }

        success(res, {
            message: 'Segment stats retrieved successfully',
            data: { segmentStats: stats },
        });
    }

    async getCsvSample(_req: Request, res: Response): Promise<void> {
        const sample =
            'name,domain,email_domains,segment,country\nUniversity of Lagos,unilag.edu.ng,"[""unilag.edu.ng"",""live.unilag.edu.ng""]",federal,Nigeria';
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="universities_sample.csv"');
        res.send(sample);
    }

    async importCsv(req: Request, res: Response): Promise<void> {
        const file = (req as any).file;
        if (!file || !file.buffer) {
            throw new BadRequestError('No CSV file uploaded');
        }

        const csv = file.buffer.toString('utf-8');
        const lines = csv.split(/\r?\n/).filter((l: string) => l.trim());
        if (lines.length < 2) {
            throw new BadRequestError('CSV must have header and at least one row');
        }

        const header = lines[0].toLowerCase();
        const rows = lines.slice(1);
        const policyReview: Array<{ id: string; name: string; emailDomains: string[]; isActive: boolean }> = [];
        let inserted = 0;
        let updated = 0;

        const MAX_LINE_LENGTH = 64 * 1024; // 64KB per line to prevent loop-bound DoS
        for (const line of rows) {
            if (line.length > MAX_LINE_LENGTH) continue;
            const cols = this.parseCsvLine(line);
            if (cols.length < 2) continue;

            const getCol = (name: string): string => {
                const i = header.split(',').map((h: string) => h.trim()).indexOf(name);
                return i >= 0 ? (cols[i] || '').trim() : '';
            };

            const name = getCol('name') || cols[0];
            const domain = getCol('domain') || cols[1];
            if (!name || !domain) continue;

            let emailDomains: string[] = [];
            try {
                const ed = getCol('email_domains') || cols[2] || '[]';
                const parsed = typeof ed === 'string' && ed.startsWith('[') ? JSON.parse(ed) : [domain];
                emailDomains = Array.isArray(parsed) ? parsed : [domain];
            } catch {
                emailDomains = [domain];
            }

            const segment = (getCol('segment') || cols[3] || '').toLowerCase();
            const validSegment = ['federal', 'state', 'private'].includes(segment) ? segment : null;
            const country = getCol('country') || cols[4] || 'Nigeria';
            const shortcode = domainToShortcode(domain);

            const existing = await db.query('SELECT id, is_active FROM universities WHERE name = $1', [name]);
            if (existing.rows.length > 0) {
                await db.query(
                    `UPDATE universities SET domain = $1, email_domains = $2::jsonb, segment = $3, shortcode = $4, country = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6`,
                    [domain, JSON.stringify(emailDomains), validSegment, shortcode, country, existing.rows[0].id]
                );
                policyReview.push({ id: existing.rows[0].id, name, emailDomains, isActive: existing.rows[0].is_active });
                updated++;
            } else {
                const created = await db.query(
                    `INSERT INTO universities (name, domain, email_domains, segment, shortcode, country, is_active)
                     VALUES ($1, $2, $3::jsonb, $4, $5, $6, true) RETURNING id`,
                    [name, domain, JSON.stringify(emailDomains), validSegment, shortcode, country]
                );
                policyReview.push({ id: created.rows[0].id, name, emailDomains, isActive: true });
                inserted++;
            }
        }

        success(res, {
            message: 'Directory imported. Review verification policies before enabling student signup.',
            data: { inserted, updated, policyReview: [...new Map(policyReview.map((school) => [school.id, school])).values()] },
        });
    }

    private parseCsvLine(line: string): string[] {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === '"') {
                inQuotes = !inQuotes;
            } else if (inQuotes) {
                current += c;
            } else if (c === ',') {
                result.push(current.trim());
                current = '';
            } else {
                current += c;
            }
        }
        result.push(current.trim());
        return result;
    }
}

export const adminUniversityController = new AdminUniversityController();
