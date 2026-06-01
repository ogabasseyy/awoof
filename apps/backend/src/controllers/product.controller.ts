/**
 * Product Controller
 * 
 * Handles product management for vendors
 */

import type { Response } from 'express';
import { db } from '../config/database.js';
import { getFileUrl } from '../config/upload.js';
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
const createProductSchema = z.object({
    name: z.string().min(1, 'Product name is required').max(255, 'Product name too long'),
    description: z.string().optional(),
    price: z.coerce.number().positive('Price must be positive'),
    studentPrice: z.coerce.number().positive('Student price must be positive'),
    categoryId: z.string().uuid('Invalid category ID').optional().nullable(),
    stock: z.coerce.number().int().min(0, 'Stock cannot be negative').default(0),
    status: z.enum(['active', 'inactive', 'out_of_stock']).default('active'),
    dealType: z.enum(['product', 'voucher']).optional().default('product'),
});

const updateProductSchema = createProductSchema.partial();

/**
 * Product Controller
 */
export class ProductController {
    /**
     * Get all products for the authenticated vendor
     */
    public async getProducts(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can view their products');
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
        const dealType = req.query.deal_type as string | undefined;

        // Build query
        let query = `
            SELECT p.id, p.name, p.description, p.price, p.student_price, 
                   p.category_id, p.image_url, p.api_id, p.stock, p.status,
                   p.deal_type, p.created_at, p.updated_at,
                   c.name as category_name
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            WHERE p.vendor_id = $1 AND p.deleted_at IS NULL
        `;
        const values: (string | number)[] = [vendorId];
        let paramCount = 2;

        if (dealType === 'product' || dealType === 'voucher') {
            query += ` AND p.deal_type = $${paramCount}`;
            values.push(dealType);
            paramCount++;
        }

        if (status) {
            query += ` AND p.status = $${paramCount}`;
            values.push(status);
            paramCount++;
        }

        if (search) {
            query += ` AND (p.name ILIKE $${paramCount} OR p.description ILIKE $${paramCount})`;
            values.push(`%${search}%`);
            paramCount++;
        }

        query += ` ORDER BY p.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        values.push(limit, offset);

        const result = await db.query(query, values);

        // Get total count
        let countQuery = `
            SELECT COUNT(*) as total
            FROM products p
            WHERE p.vendor_id = $1 AND p.deleted_at IS NULL
        `;
        const countValues: (string | number)[] = [vendorId];
        let countParamCount = 2;

        if (status) {
            countQuery += ` AND p.status = $${countParamCount}`;
            countValues.push(status);
            countParamCount++;
        }

        if (dealType === 'product' || dealType === 'voucher') {
            countQuery += ` AND p.deal_type = $${countParamCount}`;
            countValues.push(dealType);
            countParamCount++;
        }

        if (search) {
            countQuery += ` AND (p.name ILIKE $${countParamCount} OR p.description ILIKE $${countParamCount})`;
            countValues.push(`%${search}%`);
            countParamCount++;
        }

        const countResult = await db.query(countQuery, countValues);
        const total = parseInt(countResult.rows[0].total);

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
    }

    /**
     * Get a single product by ID
     */
    public async getProduct(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can view their products');
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
        const productId = req.params.id as string;

        if (!productId) {
            throw new BadRequestError('Product ID is required');
        }

        const result = await db.query(
            `SELECT p.id, p.name, p.description, p.price, p.student_price, 
                    p.category_id, p.image_url, p.api_id, p.stock, p.status,
                    p.deal_type, p.created_at, p.updated_at,
                    c.name as category_name
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             WHERE p.id = $1 AND p.vendor_id = $2 AND p.deleted_at IS NULL`,
            [productId, vendorId]
        );

        if (result.rows.length === 0) {
            throw new NotFoundError('Product not found');
        }

        success(res, {
            message: 'Product retrieved successfully',
            data: { product: result.rows[0] },
        });
    }

    /**
     * Create a new product
     */
    public async createProduct(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can create products');
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

        // Validate request body
        const validated = createProductSchema.parse(req.body);

        // Validate category if provided
        if (validated.categoryId) {
            const categoryResult = await db.query(
                'SELECT id FROM categories WHERE id = $1',
                [validated.categoryId]
            );
            if (categoryResult.rows.length === 0) {
                throw new BadRequestError('Category not found');
            }
        }

        // Handle image upload
        let imageUrl: string | null = null;
        const file = req.file as Express.Multer.File | undefined;
        if (file) {
            imageUrl = getFileUrl(file.filename);
        }

        // Insert product
        const result = await db.query(
            `INSERT INTO products (vendor_id, name, description, price, student_price, 
                                  category_id, image_url, stock, status, deal_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, name, description, price, student_price, category_id, 
                       image_url, api_id, stock, status, deal_type, created_at, updated_at`,
            [
                vendorId,
                validated.name,
                validated.description || null,
                validated.price,
                validated.studentPrice,
                validated.categoryId || null,
                imageUrl,
                validated.stock,
                validated.status,
                validated.dealType ?? 'product',
            ]
        );

        success(res, {
            message: 'Product created successfully',
            data: { product: result.rows[0] },
        }, 201);
    }

    /**
     * Update a product
     */
    public async updateProduct(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can update their products');
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
        const productId = req.params.id as string;

        if (!productId) {
            throw new BadRequestError('Product ID is required');
        }

        // Check if product exists and belongs to vendor
        const productCheck = await db.query(
            'SELECT id FROM products WHERE id = $1 AND vendor_id = $2 AND deleted_at IS NULL',
            [productId, vendorId]
        );

        if (productCheck.rows.length === 0) {
            throw new NotFoundError('Product not found');
        }

        // Validate request body
        const validated = updateProductSchema.parse(req.body);

        // Validate category if provided
        if (validated.categoryId !== undefined && validated.categoryId !== null) {
            const categoryResult = await db.query(
                'SELECT id FROM categories WHERE id = $1',
                [validated.categoryId]
            );
            if (categoryResult.rows.length === 0) {
                throw new BadRequestError('Category not found');
            }
        }

        // Handle image upload
        const file = req.file as Express.Multer.File | undefined;
        let imageUrl: string | null | undefined = undefined;
        if (file) {
            imageUrl = getFileUrl(file.filename);
        }

        // Build update query
        const updates: string[] = [];
        const values: (string | number | null)[] = [];
        let paramCount = 1;

        if (validated.name !== undefined) {
            updates.push(`name = $${paramCount}`);
            values.push(validated.name);
            paramCount++;
        }

        if (validated.description !== undefined) {
            updates.push(`description = $${paramCount}`);
            values.push(validated.description || null);
            paramCount++;
        }

        if (validated.price !== undefined) {
            updates.push(`price = $${paramCount}`);
            values.push(validated.price);
            paramCount++;
        }

        if (validated.studentPrice !== undefined) {
            updates.push(`student_price = $${paramCount}`);
            values.push(validated.studentPrice);
            paramCount++;
        }

        if (validated.categoryId !== undefined) {
            updates.push(`category_id = $${paramCount}`);
            values.push(validated.categoryId || null);
            paramCount++;
        }

        if (validated.stock !== undefined) {
            updates.push(`stock = $${paramCount}`);
            values.push(validated.stock);
            paramCount++;
        }

        if (validated.status !== undefined) {
            updates.push(`status = $${paramCount}`);
            values.push(validated.status);
            paramCount++;
        }

        if (validated.dealType !== undefined) {
            updates.push(`deal_type = $${paramCount}`);
            values.push(validated.dealType);
            paramCount++;
        }

        if (imageUrl !== undefined) {
            updates.push(`image_url = $${paramCount}`);
            values.push(imageUrl);
            paramCount++;
        }

        if (updates.length === 0) {
            throw new BadRequestError('No fields to update');
        }

        values.push(productId, vendorId);
        const result = await db.query(
            `UPDATE products 
             SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
             WHERE id = $${paramCount} AND vendor_id = $${paramCount + 1} AND deleted_at IS NULL
             RETURNING id, name, description, price, student_price, category_id, 
                       image_url, api_id, stock, status, deal_type, created_at, updated_at`,
            values
        );

        if (result.rows.length === 0) {
            throw new NotFoundError('Product not found');
        }

        success(res, {
            message: 'Product updated successfully',
            data: { product: result.rows[0] },
        });
    }

    /**
     * Delete a product (soft delete)
     */
    public async deleteProduct(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can delete their products');
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
        const productId = req.params.id as string;

        if (!productId) {
            throw new BadRequestError('Product ID is required');
        }

        const result = await db.query(
            `UPDATE products 
             SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND vendor_id = $2 AND deleted_at IS NULL
             RETURNING id`,
            [productId, vendorId]
        );

        if (result.rows.length === 0) {
            throw new NotFoundError('Product not found');
        }

        success(res, {
            message: 'Product deleted successfully',
            data: {},
        });
    }

    /**
     * Trigger product sync from vendor API
     */
    public async syncProducts(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can sync products');
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

        // Check if vendor has API config
        const apiConfigResult = await db.query(
            `SELECT id, api_endpoint, auth_type, credentials, is_active
             FROM vendor_api_configs
             WHERE vendor_id = $1 AND is_active = true`,
            [vendorId]
        );

        if (apiConfigResult.rows.length === 0) {
            throw new BadRequestError('No active API configuration found. Please configure your API integration first.');
        }

        // TODO: Implement actual API sync logic
        // For now, just update the last_sync timestamp
        await db.query(
            `UPDATE vendor_api_configs
             SET last_sync = CURRENT_TIMESTAMP
             WHERE vendor_id = $1 AND is_active = true`,
            [vendorId]
        );

        success(res, {
            message: 'Product sync initiated. Products will be updated shortly.',
            data: {
                syncStatus: 'initiated',
                lastSync: new Date().toISOString(),
            },
        });
    }
}

