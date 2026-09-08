/**
 * Analytics Controller
 * 
 * Handles vendor analytics and reporting
 */

import type { Response } from 'express';
import { db } from '../config/database.js';
import { success } from '../common/utils/response.js';
import { NotFoundError, UnauthorizedError } from '../common/errors/AppError.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';

/**
 * Analytics Controller
 */
export class AnalyticsController {
    /**
     * Get vendor analytics
     */
    public async getAnalytics(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can access analytics');
        }

        // Get vendor ID
        const vendorResult = await db.query(
            'SELECT id FROM vendors WHERE user_id = $1 AND deleted_at IS NULL',
            [req.user.userId]
        );

        if (vendorResult.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        const vendorId = vendorResult.rows[0].id;

        // Get overall metrics
        const overallMetricsResult = await db.query(
            `SELECT 
                COUNT(DISTINCT t.id) as total_orders,
                COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END) as completed_orders,
                COALESCE(SUM(CASE WHEN t.status = 'completed' THEN t.amount ELSE 0 END), 0) as total_revenue,
                COALESCE(SUM(CASE WHEN t.status = 'completed' THEN t.commission ELSE 0 END), 0) as total_commission,
                COALESCE(SUM(CASE WHEN t.status = 'completed' THEN (t.amount - t.commission) ELSE 0 END), 0) as total_earnings,
                COUNT(DISTINCT t.student_id) as unique_customers,
                COALESCE(AVG(CASE WHEN t.status = 'completed' THEN t.amount ELSE NULL END), 0) as average_order_value
             FROM transactions t
             WHERE t.vendor_id = $1`,
            [vendorId]
        );

        const overallMetrics = overallMetricsResult.rows[0];

        // Get product analytics
        const productAnalyticsResult = await db.query(
            `SELECT 
                p.id,
                p.name,
                p.price,
                p.student_price,
                p.status,
                COUNT(DISTINCT t.id) as total_orders,
                COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END) as completed_orders,
                COALESCE(SUM(CASE WHEN t.status = 'completed' THEN t.amount ELSE 0 END), 0) as revenue,
                COALESCE(SUM(CASE WHEN t.status = 'completed' THEN t.commission ELSE 0 END), 0) as commission,
                COALESCE(SUM(CASE WHEN t.status = 'completed' THEN (t.amount - t.commission) ELSE 0 END), 0) as earnings,
                COUNT(DISTINCT t.student_id) as unique_customers
             FROM products p
             LEFT JOIN transactions t ON p.id = t.product_id
             WHERE p.vendor_id = $1 AND p.deleted_at IS NULL
             GROUP BY p.id, p.name, p.price, p.student_price, p.status
             ORDER BY revenue DESC, total_orders DESC`,
            [vendorId]
        );

        // Get time-based analytics (last 30 days)
        const timeBasedResult = await db.query(
            `SELECT 
                TO_CHAR(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') as date,
                COUNT(DISTINCT t.id) as orders,
                COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END) as completed_orders,
                COALESCE(SUM(CASE WHEN t.status = 'completed' THEN t.amount ELSE 0 END), 0) as revenue,
                COUNT(DISTINCT t.student_id) as unique_customers
             FROM transactions t
             WHERE t.vendor_id = $1 
             AND t.created_at >= NOW() - INTERVAL '30 days'
             GROUP BY TO_CHAR(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
             ORDER BY date ASC`,
            [vendorId]
        );

        // Get monthly summary (last 6 months)
        const monthlyResult = await db.query(
            `SELECT 
                DATE_TRUNC('month', t.created_at) as month,
                COUNT(DISTINCT t.id) as orders,
                COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.id END) as completed_orders,
                COALESCE(SUM(CASE WHEN t.status = 'completed' THEN t.amount ELSE 0 END), 0) as revenue,
                COALESCE(SUM(CASE WHEN t.status = 'completed' THEN t.commission ELSE 0 END), 0) as commission,
                COALESCE(SUM(CASE WHEN t.status = 'completed' THEN (t.amount - t.commission) ELSE 0 END), 0) as earnings,
                COUNT(DISTINCT t.student_id) as unique_customers
             FROM transactions t
             WHERE t.vendor_id = $1
             AND t.created_at >= NOW() - INTERVAL '6 months'
             GROUP BY DATE_TRUNC('month', t.created_at)
             ORDER BY month DESC`,
            [vendorId]
        );

        // Get student analytics
        const studentAnalyticsResult = await db.query(
            `SELECT 
                COUNT(DISTINCT t.student_id) as total_students,
                COUNT(DISTINCT CASE WHEN t.status = 'completed' THEN t.student_id END) as verified_students,
                COUNT(DISTINCT CASE 
                    WHEN t.student_id IN (
                        SELECT student_id 
                        FROM transactions 
                        WHERE vendor_id = $1 
                        GROUP BY student_id 
                        HAVING COUNT(*) > 1
                    ) THEN t.student_id 
                END) as repeat_customers
             FROM transactions t
             WHERE t.vendor_id = $1`,
            [vendorId]
        );

        // Get top products by revenue
        const topProductsResult = await db.query(
            `SELECT 
                p.id,
                p.name,
                p.image_url,
                COUNT(DISTINCT t.id) as orders,
                COALESCE(SUM(CASE WHEN t.status = 'completed' THEN t.amount ELSE 0 END), 0) as revenue
             FROM products p
             LEFT JOIN transactions t ON p.id = t.product_id AND t.status = 'completed'
             WHERE p.vendor_id = $1 AND p.deleted_at IS NULL
             GROUP BY p.id, p.name, p.image_url
             ORDER BY revenue DESC
             LIMIT 10`,
            [vendorId]
        );

        // Get conversion rate (completed orders / total orders)
        const conversionRate = overallMetrics.total_orders > 0
            ? (parseFloat(overallMetrics.completed_orders) / parseFloat(overallMetrics.total_orders)) * 100
            : 0;

        success(res, {
            message: 'Analytics retrieved successfully',
            data: {
                overall: {
                    totalOrders: parseInt(overallMetrics.total_orders),
                    completedOrders: parseInt(overallMetrics.completed_orders),
                    totalRevenue: parseFloat(overallMetrics.total_revenue),
                    totalCommission: parseFloat(overallMetrics.total_commission),
                    totalEarnings: parseFloat(overallMetrics.total_earnings),
                    uniqueCustomers: parseInt(overallMetrics.unique_customers),
                    averageOrderValue: parseFloat(overallMetrics.average_order_value),
                    conversionRate: parseFloat(conversionRate.toFixed(2)),
                },
                products: productAnalyticsResult.rows.map((row) => ({
                    id: row.id,
                    name: row.name,
                    price: parseFloat(row.price),
                    studentPrice: parseFloat(row.student_price),
                    status: row.status,
                    totalOrders: parseInt(row.total_orders),
                    completedOrders: parseInt(row.completed_orders),
                    revenue: parseFloat(row.revenue),
                    commission: parseFloat(row.commission),
                    earnings: parseFloat(row.earnings),
                    uniqueCustomers: parseInt(row.unique_customers),
                })),
                timeBased: timeBasedResult.rows.map((row) => ({
                    date: row.date,
                    orders: parseInt(row.orders),
                    completedOrders: parseInt(row.completed_orders),
                    revenue: parseFloat(row.revenue),
                    uniqueCustomers: parseInt(row.unique_customers),
                })),
                monthly: monthlyResult.rows.map((row) => ({
                    month: row.month,
                    orders: parseInt(row.orders),
                    completedOrders: parseInt(row.completed_orders),
                    revenue: parseFloat(row.revenue),
                    commission: parseFloat(row.commission),
                    earnings: parseFloat(row.earnings),
                    uniqueCustomers: parseInt(row.unique_customers),
                })),
                students: {
                    totalStudents: parseInt(studentAnalyticsResult.rows[0].total_students),
                    verifiedStudents: parseInt(studentAnalyticsResult.rows[0].verified_students),
                    repeatCustomers: parseInt(studentAnalyticsResult.rows[0].repeat_customers),
                },
                topProducts: topProductsResult.rows.map((row) => ({
                    id: row.id,
                    name: row.name,
                    imageUrl: row.image_url,
                    orders: parseInt(row.orders),
                    revenue: parseFloat(row.revenue),
                })),
            },
        });
    }
}

