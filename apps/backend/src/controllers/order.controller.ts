/**
 * Order Controller
 * 
 * Handles order management for vendors
 */

import type { Response } from 'express';
import { db } from '../config/database.js';
import {
    BadRequestError,
    NotFoundError,
    UnauthorizedError,
} from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import { z } from 'zod';

/**
 * Validation schemas
 */
const updateOrderStatusSchema = z.object({
    status: z.enum(['pending', 'completed', 'failed', 'refunded']),
});

/**
 * Order Controller
 */
export class OrderController {
    /**
     * Get all orders for the authenticated vendor
     */
    public async getOrders(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can view their orders');
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

        // Get query parameters
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;
        const status = req.query.status as string | undefined;
        const search = req.query.search as string | undefined;

        // Build query
        let query = `
            SELECT 
                t.id,
                t.amount,
                t.commission,
                t.status,
                t.paystack_reference,
                t.payment_source,
                t.created_at,
                t.updated_at,
                p.id as product_id,
                p.name as product_name,
                p.image_url as product_image,
                s.id as student_id,
                s.name as student_name,
                u.email as student_email
            FROM transactions t
            JOIN products p ON t.product_id = p.id
            JOIN students s ON t.student_id = s.id
            JOIN users u ON s.user_id = u.id
            WHERE t.vendor_id = $1
        `;
        const values: (string | number)[] = [vendorId];
        let paramCount = 2;

        if (status) {
            query += ` AND t.status = $${paramCount}`;
            values.push(status);
            paramCount++;
        }

        if (search) {
            query += ` AND (
                p.name ILIKE $${paramCount} OR 
                s.name ILIKE $${paramCount} OR 
                u.email ILIKE $${paramCount} OR
                t.paystack_reference ILIKE $${paramCount} OR
                t.id::text ILIKE $${paramCount}
            )`;
            values.push(`%${search}%`);
            paramCount++;
        }

        query += ` ORDER BY t.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        values.push(limit, offset);

        const result = await db.query(query, values);

        // Get total count
        let countQuery = `
            SELECT COUNT(*) as total
            FROM transactions t
            WHERE t.vendor_id = $1
        `;
        const countValues: (string | number)[] = [vendorId];
        let countParamCount = 2;

        if (status) {
            countQuery += ` AND t.status = $${countParamCount}`;
            countValues.push(status);
            countParamCount++;
        }

        if (search) {
            countQuery += ` AND EXISTS (
                SELECT 1 FROM products p
                JOIN students s ON t.student_id = s.id
                JOIN users u ON s.user_id = u.id
                WHERE t.product_id = p.id AND (
                    p.name ILIKE $${countParamCount} OR 
                    s.name ILIKE $${countParamCount} OR 
                    u.email ILIKE $${countParamCount} OR
                    t.paystack_reference ILIKE $${countParamCount} OR
                    t.id::text ILIKE $${countParamCount}
                )
            )`;
            countValues.push(`%${search}%`);
        }

        const countResult = await db.query(countQuery, countValues);
        const total = parseInt(countResult.rows[0].total);
        const totalPages = Math.ceil(total / limit);

        // Format orders
        const orders = result.rows.map((row) => ({
            id: row.id,
            amount: parseFloat(row.amount),
            commission: parseFloat(row.commission),
            status: row.status,
            paystackReference: row.paystack_reference,
            managedPayment: row.payment_source === 'awoof' && Boolean(row.paystack_reference),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            product: {
                id: row.product_id,
                name: row.product_name,
                imageUrl: row.product_image,
            },
            student: {
                id: row.student_id,
                name: row.student_name,
                email: row.student_email,
            },
        }));

        success(res, {
            message: 'Orders retrieved successfully',
            data: {
                orders,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages,
                },
            },
        });
    }

    /**
     * Get a single order by ID
     */
    public async getOrder(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can view their orders');
        }

        // Get vendor ID
        const vendorResult = await db.query(
            'SELECT id FROM vendors WHERE user_id = $1 AND deleted_at IS NULL',
            [req.user.userId]
        );

        if (vendorResult.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        const vendorId = vendorResult.rows[0].id as string;
        const orderId = req.params.id as string;

        if (!orderId) {
            throw new BadRequestError('Order ID is required');
        }

        const result = await db.query(
            `SELECT 
                t.id,
                t.amount,
                t.commission,
                t.status,
                t.paystack_reference,
                t.payment_source,
                t.created_at,
                t.updated_at,
                p.id as product_id,
                p.name as product_name,
                p.description as product_description,
                p.image_url as product_image,
                p.price as product_price,
                p.student_price as product_student_price,
                s.id as student_id,
                s.name as student_name,
                s.phone_number as student_phone,
                u.email as student_email
            FROM transactions t
            JOIN products p ON t.product_id = p.id
            JOIN students s ON t.student_id = s.id
            JOIN users u ON s.user_id = u.id
            WHERE t.id = $1 AND t.vendor_id = $2`,
            [orderId, vendorId]
        );

        if (result.rows.length === 0) {
            throw new NotFoundError('Order not found');
        }

        const row = result.rows[0];

        const order = {
            id: row.id,
            amount: parseFloat(row.amount),
            commission: parseFloat(row.commission),
            status: row.status,
            paystackReference: row.paystack_reference,
            managedPayment: row.payment_source === 'awoof' && Boolean(row.paystack_reference),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            product: {
                id: row.product_id,
                name: row.product_name,
                description: row.product_description,
                imageUrl: row.product_image,
                price: parseFloat(row.product_price),
                studentPrice: parseFloat(row.product_student_price),
            },
            student: {
                id: row.student_id,
                name: row.student_name,
                email: row.student_email,
                phoneNumber: row.student_phone,
            },
        };

        success(res, {
            message: 'Order retrieved successfully',
            data: { order },
        });
    }

    /**
     * Update order status
     */
    public async updateOrderStatus(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can update order status');
        }

        // Get vendor ID
        const vendorResult = await db.query(
            'SELECT id FROM vendors WHERE user_id = $1 AND deleted_at IS NULL',
            [req.user.userId]
        );

        if (vendorResult.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        const vendorId = vendorResult.rows[0].id as string;
        const orderId = req.params.id as string;

        if (!orderId) {
            throw new BadRequestError('Order ID is required');
        }

        // Validate request body
        const validated = updateOrderStatusSchema.parse(req.body);

        // Check if order exists and belongs to vendor
        const orderCheck = await db.query(
            `SELECT id, status, payment_source, paystack_reference
             FROM transactions WHERE id = $1 AND vendor_id = $2`,
            [orderId, vendorId]
        );

        if (orderCheck.rows.length === 0) {
            throw new NotFoundError('Order not found');
        }

        const order = orderCheck.rows[0];
        if (order.payment_source === 'awoof' && order.paystack_reference) {
            throw new BadRequestError('Awoof-managed payment states cannot be changed by vendors');
        }

        // Update order status
        const result = await db.query(
            `UPDATE transactions 
             SET status = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND vendor_id = $3
             RETURNING id, status, updated_at`,
            [validated.status, orderId, vendorId]
        );

        if (result.rows.length === 0) {
            throw new NotFoundError('Order not found');
        }

        success(res, {
            message: 'Order status updated successfully',
            data: {
                order: {
                    id: result.rows[0].id,
                    status: result.rows[0].status,
                    updatedAt: result.rows[0].updated_at,
                },
            },
        });
    }
}
