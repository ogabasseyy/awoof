/**
 * Student Signup OTP Service
 *
 * Stores OTP plus the validated signup fields in Redis (one-time use, keyed by email).
 */

import { redis } from '../../config/redis.js';
import { generateOTP, OTP_EXPIRY_MINUTES } from '../auth/otp.service.js';

const OTP_PREFIX = 'student_signup_otp:';
const OTP_TTL_SECONDS = OTP_EXPIRY_MINUTES * 60;

export type StudentSignupClaim = {
    universityId: string;
    name: string;
    matricNumber: string;
};

/**
 * Store OTP for student signup (one-time use)
 */
export async function storeStudentSignupOTP(
    email: string,
    claim: StudentSignupClaim
): Promise<string> {
    const otp = generateOTP(6);
    const key = `${OTP_PREFIX}${email.toLowerCase()}`;

    if (redis.isConnected()) {
        const client = redis.getClient();
        await client.setex(key, OTP_TTL_SECONDS, JSON.stringify({ otp, ...claim }));
    }

    return otp;
}

/**
 * Verify OTP for student signup and delete on success (one-time use)
 */
export async function verifyStudentSignupOTP(
    email: string,
    otp: string
): Promise<StudentSignupClaim | null> {
    const key = `${OTP_PREFIX}${email.toLowerCase()}`;

    if (!redis.isConnected()) {
        return null;
    }

    const client = redis.getClient();
    const stored = await client.get(key);
    if (!stored) {
        return null;
    }

    let parsed: { otp?: string } & Partial<StudentSignupClaim>;
    try {
        parsed = JSON.parse(stored) as { otp?: string } & Partial<StudentSignupClaim>;
    } catch {
        if (stored !== otp) {
            return null;
        }
        await client.del(key);
        return null;
    }

    if (!parsed.otp || parsed.otp !== otp || !parsed.universityId || !parsed.name) {
        return null;
    }

    await client.del(key);
    return {
        universityId: parsed.universityId,
        name: parsed.name,
        matricNumber: parsed.matricNumber ?? '',
    };
}
