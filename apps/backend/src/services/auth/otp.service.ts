import { randomInt } from "crypto";
/**
 * OTP Service
 * 
 * Handles OTP generation and validation
 * Follows Single Responsibility Principle - only handles OTP operations
 */

/**
 * Generate an OTP
 * @param length - Length of OTP (default: 6)
 */
export function generateOTP(length: number = 6): string {
    const min = Math.pow(10, length - 1);
    const max = Math.pow(10, length) - 1;
    return randomInt(min, max + 1).toString();
}

/**
 * Check if OTP is expired
 */
export function isOTPExpired(expiresAt: Date | null): boolean {
    if (!expiresAt) {
        return true;
    }
    return new Date() > expiresAt;
}

/**
 * OTP expiry time (10 minutes)
 */
export const OTP_EXPIRY_MINUTES = 10;

/**
 * Calculate OTP expiry date
 */
export function getOTPExpiryDate(): Date {
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + OTP_EXPIRY_MINUTES);
    return expiresAt;
}

