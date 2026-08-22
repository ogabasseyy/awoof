/**
 * Products Routes
 * 
 * Handles public product endpoints
 */

import { Router } from 'express';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { db } from '../config/database.js';
import { success } from '../common/utils/response.js';
import { NotFoundError } from '../common/errors/AppError.js';

const router = Router();

/**
 * @route   GET /api/products
 * @desc    Get all active products (public marketplace)
 * @access  Public
 */
router.get(
    '/',
    asyncHandler(async (req, res) => {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;
        const categoryId = req.query.categoryId as string | undefined;
        const search = req.query.search as string | undefined;
        const minPrice = req.query.minPrice ? parseFloat(req.query.minPrice as string) : undefined;
        const maxPrice = req.query.maxPrice ? parseFloat(req.query.maxPrice as string) : undefined;
        const dealType = req.query.deal_type as string | undefined;

        // Build query
        let query = `
            SELECT 
                p.id, p.name, p.description, p.price, p.student_price, 
                p.category_id, p.image_url, p.stock, p.status, p.deal_type,
                p.created_at, p.updated_at,
                c.name as category_name,
                v.id as vendor_id, v.name as vendor_name, v.logo_url as vendor_logo_url,
                COALESCE(v.payment_method, 'awoof') as vendor_payment_method
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            LEFT JOIN vendors v ON p.vendor_id = v.id
            WHERE p.status = 'active' AND p.deleted_at IS NULL AND v.deleted_at IS NULL AND v.status = 'active'
        `;
        const values: (string | number)[] = [];
        let paramCount = 1;

        if (dealType === 'product' || dealType === 'voucher') {
            query += ` AND p.deal_type = $${paramCount}`;
            values.push(dealType);
            paramCount++;
        }

        if (categoryId) {
            query += ` AND p.category_id = $${paramCount}`;
            values.push(categoryId);
            paramCount++;
        }

        if (search) {
            query += ` AND (p.name ILIKE $${paramCount} OR p.description ILIKE $${paramCount} OR v.name ILIKE $${paramCount})`;
            values.push(`%${search}%`);
            paramCount++;
        }

        if (minPrice !== undefined) {
            query += ` AND p.student_price >= $${paramCount}`;
            values.push(minPrice);
            paramCount++;
        }

        if (maxPrice !== undefined) {
            query += ` AND p.student_price <= $${paramCount}`;
            values.push(maxPrice);
            paramCount++;
        }

        // Get total count for pagination
        const countQuery = query.replace(
            /SELECT[\s\S]*?FROM/,
            'SELECT COUNT(*) as total FROM'
        );
        const countResult = await db.query(countQuery, values);
        const total = parseInt(countResult.rows[0].total);

        // Add pagination and ordering
        query += ` ORDER BY p.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        values.push(limit, offset);

        const result = await db.query(query, values);

        success(res, {
            message: 'Products retrieved successfully',
            data: {
                products: result.rows,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                },
            },
        });
    })
);

/**
 * @route   GET /api/products/categories
 * @desc    Get all product categories
 * @access  Public
 * 
 * NOTE: This route must be defined BEFORE /:id to avoid route conflicts
 */
router.get(
    '/categories',
    asyncHandler(async (_req, res) => {
        const result = await db.query(
            'SELECT id, name, description, slug FROM categories ORDER BY name ASC'
        );

        success(res, {
            message: 'Categories retrieved successfully',
            data: result.rows,
        });
    })
);

/**
 * @route   GET /api/products/:id
 * @desc    Get a single product by ID (public)
 * @access  Public
 */
router.get(
    '/:id',
    asyncHandler(async (req, res) => {
        const productId = req.params.id;

        const result = await db.query(
            `SELECT 
                p.id, p.name, p.description, p.price, p.student_price, 
                p.category_id, p.image_url, p.stock, p.status, p.deal_type,
                p.created_at, p.updated_at,
                c.id as category_id, c.name as category_name, c.slug as category_slug,
                v.id as vendor_id, v.name as vendor_name, v.description as vendor_description,
                v.logo_url as vendor_logo_url,
                COALESCE(v.payment_method, 'awoof') as vendor_payment_method
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            LEFT JOIN vendors v ON p.vendor_id = v.id
            WHERE p.id = $1 AND p.status = 'active' AND p.deleted_at IS NULL AND v.deleted_at IS NULL AND v.status = 'active'`,
            [productId]
        );

        if (result.rows.length === 0) {
            throw new NotFoundError('Product not found');
        }

        success(res, {
            message: 'Product retrieved successfully',
            data: { product: result.rows[0] },
        });
    })
);

export default router;

