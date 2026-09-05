/**
 * Verification Token Service
 * 
 * Handles verification token generation and validation for widget integration
 * Follows Single Responsibility Principle - only handles verification tokens
 */

import crypto from 'crypto';
import { db } from '../../config/database.js';
import {
    BadRequestError,
    NotFoundError,
    UnauthorizedError,
} from '../../common/errors/AppError.js';

/**
 * Verification token expiry time (30 minutes)
 */
export const VERIFICATION_TOKEN_EXPIRY_MINUTES = 30;

/**
 * Generate a secure verification token
 */
export function generateVerificationToken(): string {
    return `awoof_${crypto.randomBytes(32).toString('hex')}`;
}

/**
 * Calculate token expiry date
 */
export function getTokenExpiryDate(): Date {
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + VERIFICATION_TOKEN_EXPIRY_MINUTES);
    return expiresAt;
}

/**
 * Create a verification token for a student-vendor-product combination
 */
export async function createVerificationToken(
    studentId: string,
    vendorId: string,
    productId?: string
): Promise<{ token: string; expiresAt: Date }> {
    // Verify student exists and is verified
    const studentResult = await db.query(
        `SELECT s.id, s.status, u.verification_status
         FROM students s
         JOIN users u ON s.user_id = u.id
         WHERE s.id = $1 AND s.status = 'active'`,
        [studentId]
    );

    if (studentResult.rows.length === 0) {
        throw new NotFoundError('Student not found');
    }

    const student = studentResult.rows[0];
    if (student.verification_status !== 'verified') {
        throw new UnauthorizedError('Student must be verified to generate verification token');
    }

    // Verify vendor exists
    const vendorResult = await db.query(
        `SELECT id FROM vendors WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
        [vendorId]
    );

    if (vendorResult.rows.length === 0) {
        throw new NotFoundError('Vendor not found');
    }

    // Verify product exists if provided
    if (productId) {
        const productResult = await db.query(
            `SELECT id FROM products WHERE id = $1 AND vendor_id = $2 AND deleted_at IS NULL`,
            [productId, vendorId]
        );

        if (productResult.rows.length === 0) {
            throw new NotFoundError('Product not found or does not belong to vendor');
        }
    }

    // Generate token
    const token = generateVerificationToken();
    const expiresAt = getTokenExpiryDate();

    // Store token in database
    await db.query(
        `INSERT INTO verification_tokens (student_id, vendor_id, product_id, token, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [studentId, vendorId, productId || null, token, expiresAt]
    );

    return { token, expiresAt };
}

/**
 * Validate and consume a verification token
 */
export async function validateAndConsumeToken(
    token: string,
    vendorId: string
): Promise<{
    studentId: string;
    productId: string | null;
    vendorId: string;
}> {
    // Get token from database
    const tokenResult = await db.query(
        `SELECT id, student_id, vendor_id, product_id, expires_at, used_at
         FROM verification_tokens
         WHERE token = $1 AND EXISTS (
             SELECT 1 FROM vendors v WHERE v.id = verification_tokens.vendor_id
               AND v.status = 'active' AND v.deleted_at IS NULL
         )`,
        [token]
    );

    if (tokenResult.rows.length === 0) {
        throw new NotFoundError('Invalid verification token');
    }

    const tokenData = tokenResult.rows[0];

    // Check if token has expired
    if (new Date(tokenData.expires_at) < new Date()) {
        throw new BadRequestError('Verification token has expired');
    }

    // Check if token has already been used
    if (tokenData.used_at) {
        throw new BadRequestError('Verification token has already been used');
    }

    // Verify token belongs to the vendor
    if (tokenData.vendor_id !== vendorId) {
        throw new UnauthorizedError('Verification token does not belong to this vendor');
    }

    // Mark token as used
    await db.query(
        `UPDATE verification_tokens
         SET used_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [tokenData.id]
    );

    return {
        studentId: tokenData.student_id,
        productId: tokenData.product_id,
        vendorId: tokenData.vendor_id,
    };
}

/**
 * Check if a token is valid without consuming it
 */
export async function validateToken(
    token: string,
    vendorId: string
): Promise<{
    valid: boolean;
    studentId?: string;
    productId?: string | null;
    error?: string;
}> {
    try {
        const tokenResult = await db.query(
            `SELECT student_id, vendor_id, product_id, expires_at, used_at
             FROM verification_tokens
             WHERE token = $1`,
            [token]
        );

        if (tokenResult.rows.length === 0) {
            return { valid: false, error: 'Invalid verification token' };
        }

        const tokenData = tokenResult.rows[0];

        // Check if token has expired
        if (new Date(tokenData.expires_at) < new Date()) {
            return { valid: false, error: 'Verification token has expired' };
        }

        // Check if token has already been used
        if (tokenData.used_at) {
            return { valid: false, error: 'Verification token has already been used' };
        }

        // Verify token belongs to the vendor
        if (tokenData.vendor_id !== vendorId) {
            return { valid: false, error: 'Verification token does not belong to this vendor' };
        }

        return {
            valid: true,
            studentId: tokenData.student_id,
            productId: tokenData.product_id,
        };
    } catch (error) {
        return { valid: false, error: 'Error validating token' };
    }
}
