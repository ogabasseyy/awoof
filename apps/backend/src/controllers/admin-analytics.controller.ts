/**
 * Admin Analytics Controller
 *
 * Platform-wide metrics for the admin dashboard.
 */

import type { Request, Response } from 'express';
import { db } from '../config/database.js';
import { success } from '../common/utils/response.js';

export class AdminAnalyticsController {
    /**
     * GET /api/admin/analytics
     * Returns platform-wide metrics for admin overview.
     */
    async getAnalytics(_req: Request, res: Response): Promise<void> {
        const [
            countsResult,
            transactionResult,
            savingsResult,
            supportResult,
            vendorsByStatusResult,
            last30Result,
        ] = await Promise.all([
            db.query(`
                SELECT
                    (SELECT COUNT(*)::int FROM students s JOIN users u ON u.id = s.user_id WHERE u.deleted_at IS NULL AND (s.status IS NULL OR s.status != 'deleted')) AS total_students,
                    (SELECT COUNT(*)::int FROM vendors WHERE deleted_at IS NULL) AS total_vendors,
                    (SELECT COUNT(*)::int FROM products WHERE deleted_at IS NULL) AS total_products,
                    (SELECT COUNT(*)::int FROM categories) AS total_categories,
                    (SELECT COUNT(*)::int FROM universities) AS total_universities
            `),
            db.query(`
                SELECT
                    COUNT(*)::int AS total_orders,
                    COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_orders,
                    COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0)::numeric(14,2) AS total_revenue,
                    COALESCE(SUM(commission) FILTER (WHERE status = 'completed'), 0)::numeric(14,2) AS total_commission
                FROM transactions
            `),
            db.query(`
                SELECT COALESCE(SUM(COALESCE(t.list_price_snapshot, p.price) - t.amount), 0)::numeric(14,2) AS total_student_savings
                FROM transactions t
                JOIN products p ON p.id = t.product_id
                WHERE t.status = 'completed'
            `),
            db.query(`
                SELECT COUNT(*)::int AS open_tickets
                FROM tickets
                WHERE status IN ('open', 'in-progress')
            `),
            db.query(`
                SELECT status, COUNT(*)::int AS count
                FROM vendors
                WHERE deleted_at IS NULL
                GROUP BY status
            `),
            db.query(`
                SELECT
                    COUNT(*)::int AS orders_last_30,
                    COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0)::numeric(14,2) AS revenue_last_30
                FROM transactions
                WHERE created_at >= NOW() - INTERVAL '30 days'
            `),
        ]);

        const counts = countsResult.rows[0];
        const tx = transactionResult.rows[0];
        const savings = savingsResult.rows[0];
        const support = supportResult.rows[0];
        const last30 = last30Result.rows[0];

        const totalOrders = parseInt(tx?.total_orders ?? '0');
        const completedOrders = parseInt(tx?.completed_orders ?? '0');
        const conversionRate = totalOrders > 0 ? (completedOrders / totalOrders) * 100 : 0;

        const vendorsByStatus: Record<string, number> = { active: 0, pending: 0, suspended: 0, rejected: 0 };
        for (const row of vendorsByStatusResult.rows) {
            vendorsByStatus[row.status || 'pending'] = parseInt(row.count ?? '0');
        }

        success(res, {
            message: 'Analytics retrieved successfully',
            data: {
                counts: {
                    totalStudents: parseInt(counts?.total_students ?? '0'),
                    totalVendors: parseInt(counts?.total_vendors ?? '0'),
                    totalProducts: parseInt(counts?.total_products ?? '0'),
                    totalCategories: parseInt(counts?.total_categories ?? '0'),
                    totalUniversities: parseInt(counts?.total_universities ?? '0'),
                },
                transactions: {
                    totalOrders,
                    completedOrders,
                    totalRevenue: parseFloat(tx?.total_revenue ?? '0'),
                    totalCommission: parseFloat(tx?.total_commission ?? '0'),
                    conversionRate: Math.round(conversionRate * 100) / 100,
                },
                studentImpact: {
                    totalStudentSavings: parseFloat(savings?.total_student_savings ?? '0'),
                },
                support: {
                    openTickets: parseInt(support?.open_tickets ?? '0'),
                },
                vendorsByStatus,
                last30Days: {
                    orders: parseInt(last30?.orders_last_30 ?? '0'),
                    revenue: parseFloat(last30?.revenue_last_30 ?? '0'),
                },
            },
        });
    }
}

export const adminAnalyticsController = new AdminAnalyticsController();
