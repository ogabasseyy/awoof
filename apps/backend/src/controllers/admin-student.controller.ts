/**
 * Admin Student Controller
 *
 * List students with spend and savings for admin dashboard.
 */

import type { Request, Response } from 'express';
import { db } from '../config/database.js';
import { success } from '../common/utils/response.js';

export class AdminStudentController {
    /**
     * GET /api/admin/students
     * List students with pagination, search, total_spent and total_savings.
     */
    async getStudents(req: Request, res: Response): Promise<void> {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        const search = (req.query.search as string)?.trim();
        const offset = (page - 1) * limit;

        const params: unknown[] = [];
        let paramIdx = 1;
        let whereClause = " WHERE u.deleted_at IS NULL AND (s.status IS NULL OR s.status != 'deleted')";
        if (search) {
            const pattern = `%${search}%`;
            whereClause += ` AND (
                s.name ILIKE $${paramIdx} OR
                u.email ILIKE $${paramIdx} OR
                s.university ILIKE $${paramIdx} OR
                s.registration_number ILIKE $${paramIdx}
            )`;
            params.push(pattern);
            paramIdx++;
        }

        const countQuery = `
            SELECT COUNT(DISTINCT s.id)::int AS total
            FROM students s
            JOIN users u ON u.id = s.user_id
            ${whereClause}
        `;
        const countResult = await db.query(countQuery, params);
        const total = countResult.rows[0]?.total ?? 0;

        params.push(limit, offset);
        const listQuery = `
            SELECT
                s.id,
                s.user_id,
                s.name,
                s.university,
                s.registration_number,
                s.phone_number,
                s.status,
                s.verification_date,
                s.created_at,
                u.email,
                univ.name AS university_name,
                COALESCE(stats.total_spent, 0)::numeric(12,2) AS total_spent,
                COALESCE(stats.total_savings, 0)::numeric(12,2) AS total_savings,
                COALESCE(stats.unknown_savings_count, 0) AS unknown_savings_count
            FROM students s
            JOIN users u ON u.id = s.user_id
            LEFT JOIN universities univ ON univ.id = s.university_id
            LEFT JOIN (
                SELECT
                    t.student_id,
                    SUM(t.amount) AS total_spent,
                    SUM(t.recorded_savings_delta) AS total_savings,
                    COUNT(*) FILTER (WHERE t.recorded_savings_delta IS NULL) AS unknown_savings_count
                FROM transactions t
                WHERE t.status = 'completed'
                GROUP BY t.student_id
            ) stats ON stats.student_id = s.id
            ${whereClause}
            ORDER BY s.created_at DESC
            LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
        `;
        const result = await db.query(listQuery, params);

        const students = result.rows.map((row) => ({
            id: row.id,
            userId: row.user_id,
            name: row.name,
            email: row.email,
            university: row.university_name || row.university || null,
            registrationNumber: row.registration_number || null,
            phoneNumber: row.phone_number || null,
            status: row.status || 'active',
            verificationDate: row.verification_date || null,
            createdAt: row.created_at,
            totalSpent: parseFloat(row.total_spent ?? '0'),
            totalSavings: Number(row.unknown_savings_count) > 0 ? null : parseFloat(row.total_savings ?? '0'),
            recordedSavings: parseFloat(row.total_savings ?? '0'),
            unknownSavingsCount: Number(row.unknown_savings_count),
        }));

        success(res, {
            message: 'Students retrieved successfully',
            data: { students, total, page, limit },
            meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
    }
}

export const adminStudentController = new AdminStudentController();
