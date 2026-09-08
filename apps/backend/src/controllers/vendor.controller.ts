/**
 * Vendor Controller
 * 
 * Handles vendor profile management and file uploads
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
const updateVendorProfileSchema = z.object({
    companyName: z.string().min(2, 'Company name must be at least 2 characters').optional(),
    phoneNumber: z.string().min(10, 'Invalid phone number').optional(),
    businessCategory: z.string().min(1, 'Business category is required').optional(),
    businessWebsite: z.string().url('Invalid website URL').optional().or(z.literal('')),
    description: z.string().optional(),
});

/**
 * Vendor Controller
 */
export class VendorController {
    /**
     * Upload vendor files (documents, logo, banner)
     */
    public async uploadFiles(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can upload files');
        }

        // Get vendor ID from user
        const vendorResult = await db.query(
            'SELECT id, logo_url FROM vendors WHERE user_id = $1 AND deleted_at IS NULL',
            [req.user.userId]
        );

        if (vendorResult.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        const vendorId = vendorResult.rows[0].id;
        const existingLogoUrl = vendorResult.rows[0].logo_url;
        const files = req.files as { [fieldname: string]: Express.Multer.File[] };

        // Check if logo is being uploaded (required for new vendors without logo)
        const logoFileArray = files['logoImage'];
        const hasLogoFile = logoFileArray && logoFileArray.length > 0;
        
        // If vendor doesn't have a logo yet and no logo is being uploaded, require it
        if (!existingLogoUrl && !hasLogoFile) {
            throw new BadRequestError('Logo image is required');
        }

        const fileUrls: Record<string, string> = {};

        // Process each file type
        const fileTypes = ['documentFront', 'documentBack', 'logoImage', 'bannerImage'];
        const dbColumns: Record<string, string> = {
            documentFront: 'document_front_url',
            documentBack: 'document_back_url',
            logoImage: 'logo_url',
            bannerImage: 'banner_url',
        };

        const updates: string[] = [];
        const values: (string | null)[] = [];
        let paramCount = 1;

        for (const fileType of fileTypes) {
            const fileArray = files[fileType];
            if (fileArray && fileArray.length > 0) {
                const file = fileArray[0];
                if (file && file.filename) {
                    const fileUrl = getFileUrl(file.filename, fileType === 'documentFront' || fileType === 'documentBack');
                    fileUrls[fileType] = fileUrl;

                    // Update database
                    const column = dbColumns[fileType];
                    updates.push(`${column} = $${paramCount}`);
                    values.push(fileUrl);
                    paramCount++;
                }
            }
        }

        if (updates.length > 0) {
            values.push(vendorId);
            await db.query(
                `UPDATE vendors 
                 SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $${paramCount}`,
                values
            );
        }

        success(res, {
            message: 'Files uploaded successfully',
            data: { fileUrls },
        });
    }

    /**
     * Update vendor profile
     */
    public async updateProfile(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can update their profile');
        }

        const validated = updateVendorProfileSchema.parse(req.body);

        // Get vendor ID
        const vendorResult = await db.query(
            'SELECT id FROM vendors WHERE user_id = $1 AND deleted_at IS NULL',
            [req.user.userId]
        );

        if (vendorResult.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        const vendorId = vendorResult.rows[0].id;

        // Build update query
        const updates: string[] = [];
        const values: (string | null)[] = [];
        let paramCount = 1;

        if (validated.companyName !== undefined) {
            updates.push(`company_name = $${paramCount}`);
            values.push(validated.companyName);
            paramCount++;
        }

        if (validated.phoneNumber !== undefined) {
            updates.push(`phone_number = $${paramCount}`);
            values.push(validated.phoneNumber);
            paramCount++;
        }

        if (validated.businessCategory !== undefined) {
            updates.push(`business_category = $${paramCount}`);
            values.push(validated.businessCategory);
            paramCount++;
        }

        if (validated.businessWebsite !== undefined) {
            updates.push(`business_website = $${paramCount}`);
            values.push(validated.businessWebsite || null);
            paramCount++;
        }

        if (validated.description !== undefined) {
            updates.push(`description = $${paramCount}`);
            values.push(validated.description || null);
            paramCount++;
        }

        if (updates.length === 0) {
            throw new BadRequestError('No fields to update');
        }

        values.push(vendorId);
        const result = await db.query(
            `UPDATE vendors 
             SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
             WHERE id = $${paramCount}
             RETURNING id, user_id, name, company_name, phone_number, business_category, 
                       business_website, description, status, logo_url, banner_url, 
                       document_front_url, document_back_url, created_at, updated_at`,
            values
        );

        success(res, {
            message: 'Vendor profile updated successfully',
            data: { vendor: result.rows[0] },
        });
    }

    /**
     * Get vendor profile
     */
    public async getProfile(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can view their profile');
        }

        const result = await db.query(
            `SELECT v.id, v.user_id, v.name, v.company_name, v.phone_number, 
                    v.business_category, v.business_website, v.description, v.status,
                    v.logo_url, v.banner_url, v.document_front_url, v.document_back_url,
                    v.commission_rate, v.created_at, v.updated_at,
                    u.email
             FROM vendors v
             JOIN users u ON v.user_id = u.id
             WHERE v.user_id = $1 AND v.deleted_at IS NULL`,
            [req.user.userId]
        );

        if (result.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        success(res, {
            message: 'Vendor profile retrieved successfully',
            data: { vendor: result.rows[0] },
        });
    }

    /**
     * Complete vendor registration (after initial user registration)
     * This endpoint accepts all vendor-specific data at once
     */
    public async completeRegistration(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can complete registration');
        }

        const schema = z.object({
            companyName: z.string().min(2, 'Company name must be at least 2 characters'),
            phoneNumber: z.string().min(10, 'Invalid phone number'),
            businessCategory: z.string().min(1, 'Business category is required'),
            businessWebsite: z.string().url('Invalid website URL').optional().or(z.literal('')),
            description: z.string().optional(),
        });

        const validated = schema.parse(req.body);

        // Get vendor ID
        const vendorResult = await db.query(
            'SELECT id FROM vendors WHERE user_id = $1 AND deleted_at IS NULL',
            [req.user.userId]
        );

        if (vendorResult.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        const vendorId = vendorResult.rows[0].id;

        // Update vendor profile with all data
        const result = await db.query(
            `UPDATE vendors 
             SET company_name = $1, phone_number = $2, business_category = $3,
                 business_website = $4, description = $5, updated_at = CURRENT_TIMESTAMP
             WHERE id = $6
             RETURNING id, user_id, name, company_name, phone_number, business_category, 
                       business_website, description, status, logo_url, banner_url, 
                       document_front_url, document_back_url, created_at, updated_at`,
            [
                validated.companyName,
                validated.phoneNumber,
                validated.businessCategory,
                validated.businessWebsite || null,
                validated.description || null,
                vendorId,
            ]
        );

        success(res, {
            message: 'Vendor registration completed successfully',
            data: { vendor: result.rows[0] },
        }, 200);
    }
}

