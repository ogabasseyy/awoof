/**
 * Student Controller
 * 
 * Handles student profile and related business logic
 * Follows Single Responsibility Principle - only handles student operations
 */

import type { Response } from 'express';
import { db } from '../config/database.js';
import {
    NotFoundError,
    BadRequestError,
    UnauthorizedError,
} from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import { z } from 'zod';

/**
 * Validation schemas
 */
const updateProfileSchema = z.object({
    name: z.string().min(2, 'Name must be at least 2 characters').optional(),
    university: z.string().min(1, 'University is required').optional(),
    registration_number: z.string().min(1, 'Registration number is required').optional(),
    phone_number: z.string().regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number format').optional(),
});

/**
 * Student Controller
 */
export class StudentController {
    /**
     * Get student profile
     */
    public async getProfile(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) {
            throw new UnauthorizedError('User not authenticated');
        }

        // Get user with student profile
        const userResult = await db.query(
            `SELECT 
                u.id,
                u.email,
                u.role,
                u.verification_status,
                u.created_at,
                s.id as student_id,
                s.name,
                s.university,
                s.registration_number,
                s.phone_number,
                s.verification_date,
                s.status
            FROM users u
            LEFT JOIN students s ON s.user_id = u.id
            WHERE u.id = $1 AND u.deleted_at IS NULL`,
            [req.user.userId]
        );

        if (userResult.rows.length === 0) {
            throw new NotFoundError('User not found');
        }

        const user = userResult.rows[0];

        // If student profile doesn't exist, return user with empty profile
        const profile = user.student_id ? {
            name: user.name,
            university: user.university,
            registrationNumber: user.registration_number,
            phoneNumber: user.phone_number,
            verificationDate: user.verification_date,
            status: user.status,
        } : null;

        success(res, {
            message: 'Student profile retrieved successfully',
            data: {
                user: {
                    id: user.id,
                    email: user.email,
                    role: user.role,
                    verificationStatus: user.verification_status,
                    createdAt: user.created_at,
                    profile,
                },
            },
        });
    }

    /**
     * Update student profile
     */
    public async updateProfile(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) {
            throw new UnauthorizedError('User not authenticated');
        }

        // Validate input
        const validated = updateProfileSchema.parse(req.body);

        // Check if user exists
        const userResult = await db.query(
            `SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL`,
            [req.user.userId]
        );

        if (userResult.rows.length === 0) {
            throw new NotFoundError('User not found');
        }

        // Check if student profile exists
        const studentResult = await db.query(
            `SELECT id FROM students WHERE user_id = $1`,
            [req.user.userId]
        );

        const client = await db.getPool().connect();

        try {
            await client.query('BEGIN');

            if (studentResult.rows.length === 0) {
                // Create student profile if it doesn't exist
                await client.query(
                    `INSERT INTO students (user_id, name, university, registration_number, phone_number, status, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                     RETURNING id, name, university, registration_number, phone_number, verification_date, status`,
                    [
                        req.user.userId,
                        validated.name || null,
                        validated.university || null,
                        validated.registration_number || null,
                        validated.phone_number || null,
                    ]
                );
            } else {
                // Update existing student profile
                const updateFields: string[] = [];
                const values: any[] = [];
                let paramCount = 1;

                if (validated.name !== undefined) {
                    updateFields.push(`name = $${paramCount++}`);
                    values.push(validated.name);
                }
                if (validated.university !== undefined) {
                    updateFields.push(`university = $${paramCount++}`);
                    values.push(validated.university);
                }
                if (validated.registration_number !== undefined) {
                    updateFields.push(`registration_number = $${paramCount++}`);
                    values.push(validated.registration_number);
                }
                if (validated.phone_number !== undefined) {
                    updateFields.push(`phone_number = $${paramCount++}`);
                    values.push(validated.phone_number);
                }

                if (updateFields.length === 0) {
                    throw new BadRequestError('No fields to update');
                }

                updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
                values.push(req.user.userId);

                await client.query(
                    `UPDATE students 
                     SET ${updateFields.join(', ')}
                     WHERE user_id = $${paramCount}
                     RETURNING id, name, university, registration_number, phone_number, verification_date, status`,
                    values
                );
            }

            await client.query('COMMIT');

            // Fetch updated profile
            const updatedResult = await db.query(
                `SELECT 
                    u.id,
                    u.email,
                    u.role,
                    u.verification_status,
                    u.created_at,
                    s.id as student_id,
                    s.name,
                    s.university,
                    s.registration_number,
                    s.phone_number,
                    s.verification_date,
                    s.status
                FROM users u
                LEFT JOIN students s ON s.user_id = u.id
                WHERE u.id = $1 AND u.deleted_at IS NULL`,
                [req.user.userId]
            );

            const updatedUser = updatedResult.rows[0];
            const profile = updatedUser.student_id ? {
                name: updatedUser.name,
                university: updatedUser.university,
                registrationNumber: updatedUser.registration_number,
                phoneNumber: updatedUser.phone_number,
                verificationDate: updatedUser.verification_date,
                status: updatedUser.status,
            } : null;

            success(res, {
                message: 'Profile updated successfully',
                data: {
                    user: {
                        id: updatedUser.id,
                        email: updatedUser.email,
                        role: updatedUser.role,
                        verificationStatus: updatedUser.verification_status,
                        createdAt: updatedUser.created_at,
                        profile,
                    },
                },
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Get student purchase history
     */
    public async getPurchases(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) {
            throw new UnauthorizedError('User not authenticated');
        }

        // Get pagination params
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;

        // Get student ID
        const studentResult = await db.query(
            'SELECT id FROM students WHERE user_id = $1',
            [req.user.userId]
        );

        if (studentResult.rows.length === 0) {
            throw new NotFoundError('Student profile not found');
        }

        const studentId = studentResult.rows[0].id;

        // Get total count
        const countResult = await db.query(
            `SELECT COUNT(*) as total
             FROM transactions t
             WHERE t.student_id = $1`,
            [studentId]
        );

        const total = parseInt(countResult.rows[0].total);

        // Get transactions with product and vendor info
        const transactionsResult = await db.query(
            `SELECT 
                t.id,
                t.amount,
                t.status,
                t.created_at,
                p.id as product_id,
                p.name as product_name,
                COALESCE(t.list_price_snapshot, t.amount) as product_price,
                t.amount as student_price,
                p.category_id,
                v.id as vendor_id,
                v.name as vendor_name,
                c.name as category_name
             FROM transactions t
             LEFT JOIN products p ON t.product_id = p.id AND p.deleted_at IS NULL
             LEFT JOIN vendors v ON t.vendor_id = v.id
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE t.student_id = $1
             ORDER BY t.created_at DESC
             LIMIT $2 OFFSET $3`,
            [studentId, limit, offset]
        );

        const transactions = transactionsResult.rows.map(t => {
            const originalPrice = parseFloat(t.product_price || t.amount || '0');
            const studentPrice = parseFloat(t.student_price || t.amount || '0');
            const discountAmount = originalPrice - studentPrice;

            return {
                id: t.id,
                transactionId: t.id, // Use transaction id as transaction_id
                amount: originalPrice,
                discountAmount: discountAmount > 0 ? discountAmount : 0,
                finalAmount: studentPrice,
                status: t.status,
                createdAt: t.created_at,
                product: t.product_id ? {
                    id: t.product_id,
                    name: t.product_name,
                    vendorId: t.vendor_id,
                    vendorName: t.vendor_name,
                    categoryName: t.category_name,
                } : null,
            };
        });

        success(res, {
            message: 'Purchase history retrieved successfully',
            data: {
                transactions,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                },
            },
        });
    }

    /**
     * Get student savings statistics
     */
    public async getSavings(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) {
            throw new UnauthorizedError('User not authenticated');
        }

        // Get savings stats from transactions
        // Join through students table to get to users, and calculate discount from product prices
        const statsResult = await db.query(
            `SELECT 
                COUNT(*) as total_purchases,
                COALESCE(SUM(p.price - p.student_price), 0) as total_savings,
                COALESCE(SUM(t.amount), 0) as total_spent,
                COALESCE(SUM(p.price), 0) as total_value
             FROM transactions t
             JOIN students s ON t.student_id = s.id
             JOIN users u ON s.user_id = u.id
             JOIN products p ON t.product_id = p.id
             WHERE u.id = $1 
               AND u.deleted_at IS NULL 
               AND t.status = 'completed'`,
            [req.user.userId]
        );

        const stats = statsResult.rows[0];

        // Get savings by category
        const categoryStatsResult = await db.query(
            `SELECT 
                c.name as category_name,
                COUNT(*) as purchase_count,
                COALESCE(SUM(p.price - p.student_price), 0) as savings
             FROM transactions t
             JOIN students s ON t.student_id = s.id
             JOIN users u ON s.user_id = u.id
             LEFT JOIN products p ON t.product_id = p.id
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE u.id = $1 
               AND u.deleted_at IS NULL 
               AND t.status = 'completed'
             GROUP BY c.name
             ORDER BY savings DESC`,
            [req.user.userId]
        );

        const categoryStats = categoryStatsResult.rows.map(c => ({
            categoryName: c.category_name || 'Uncategorized',
            purchaseCount: parseInt(c.purchase_count),
            savings: parseFloat(c.savings || '0'),
        }));

        success(res, {
            message: 'Savings statistics retrieved successfully',
            data: {
                summary: {
                    totalPurchases: parseInt(stats.total_purchases),
                    totalSavings: parseFloat(stats.total_savings),
                    totalSpent: parseFloat(stats.total_spent),
                    totalValue: parseFloat(stats.total_value),
                },
                byCategory: categoryStats,
            },
        });
    }
}
