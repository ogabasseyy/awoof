/**
 * Verification Token Service
 *
 * Legacy widget verification tokens are retired: issuance, validation and
 * consumption fail closed. Historical rows are preserved for audit; the
 * cutover maintenance script revokes unused rows through
 * revokeUnusedLegacyTokens. Product-bound merchant assertions and their
 * benefit authorizations replace this flow.
 */

import crypto from 'crypto';
import type { PoolClient } from 'pg';
import {
    BadRequestError,
} from '../../common/errors/AppError.js';

const RETIRED_MESSAGE = 'Verification tokens are retired. Exchange a product-bound merchant assertion and report with its benefit authorization.';

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
    _studentId: string,
    _vendorId: string,
    _productId?: string
): Promise<{ token: string; expiresAt: Date }> {
    throw new BadRequestError(RETIRED_MESSAGE);
}

/**
 * Validate and consume a verification token
 */
export async function validateAndConsumeToken(
    _token: string,
    _vendorId: string
): Promise<{
    studentId: string;
    productId: string | null;
    vendorId: string;
}> {
    throw new BadRequestError(RETIRED_MESSAGE);
}

/**
 * Check if a token is valid without consuming it
 */
export async function validateToken(
    _token: string,
    _vendorId: string
): Promise<{
    valid: boolean;
    studentId?: string;
    productId?: string | null;
    error?: string;
}> {
    return { valid: false, error: RETIRED_MESSAGE };
}

/**
 * Cutover maintenance: revoke unused legacy tokens. Used rows keep their
 * used_at marker and are never rewritten here.
 */
export async function revokeUnusedLegacyTokens(tx: PoolClient): Promise<number> {
    const revoked = await tx.query(
        `UPDATE verification_tokens SET revoked_at = clock_timestamp()
         WHERE used_at IS NULL AND revoked_at IS NULL`,
    );
    return revoked.rowCount ?? 0;
}
