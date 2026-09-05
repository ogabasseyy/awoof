/**
 * Verification Controller
 * 
 * Handles student verification with 4-tier fallback system
 * Follows Single Responsibility Principle - only handles verification operations
 */

import type { Request, Response } from 'express';
import { db } from '../config/database.js';
import { config } from '../config/env.js';
import { jwtService } from '../services/auth/jwt.service.js';
import {
    validateStudentEmailDomain,
    generateMagicLinkToken,
    getMagicLinkExpiryDate,
    sendMagicLinkEmail,
} from '../services/verification/email-verification.service.js';
import {
    sendWhatsAppOTP,
    verifyOTPFromRedis,
} from '../services/verification/whatsapp-otp.service.js';
import { verifyRegistrationNumber } from '../services/verification/registration-lookup.service.js';
import {
    getAvailableVerificationMethods,
    determineBestVerificationMethod,
    getStudentVerificationStatus,
} from '../services/verification/verification-orchestrator.service.js';
import {
    createVerificationToken,
} from '../services/verification/verification-token.service.js';
import {
    BadRequestError,
    ForbiddenError,
    UnauthorizedError,
} from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import { appLogger } from '../common/logger.js';
import { z } from 'zod';
import { generateOTP } from '../services/auth/otp.service.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';

/**
 * Validation schemas
 */
const initiateVerificationSchema = z.object({
    universityId: z.string().uuid('Invalid university ID'),
    email: z.string().email('Invalid email address').optional(),
    registrationNumber: z.string().optional(),
    phoneNumber: z.string().regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number format').optional(),
    ndprConsent: z.boolean().refine(val => val === true, 'NDPR consent is required'),
    studentName: z.string().min(2, 'Name must be at least 2 characters').optional(),
});

const verifyRegistrationSchema = z.object({
    universityId: z.string().uuid('Invalid university ID'),
    registrationNumber: z.string().min(1, 'Registration number is required'),
    studentName: z.string().min(2, 'Name must be at least 2 characters').optional(),
    studentEmail: z.string().email('Invalid email address').optional(),
});

const verifyWhatsAppSchema = z.object({
    universityId: z.string().uuid('Invalid university ID'),
    registrationNumber: z.string().min(1, 'Registration number is required'),
    phoneNumber: z.string().regex(/^\+?[1-9]\d{1,14}$/, 'Invalid phone number format'),
    otp: z.string().length(6, 'OTP must be 6 digits'),
});

const generateWidgetTokenSchema = z.object({
    vendorId: z.string().uuid('Invalid vendor ID'),
    productId: z.string().uuid('Invalid product ID').optional(),
    apiKey: z.string().min(1, 'Widget API key is required'),
    origin: z.string().url('Valid vendor origin is required'),
});

/**
 * Verification Controller
 */
export class VerificationController {
    /**
     * Get available verification methods for a university
     */
    public async getVerificationMethods(req: Request, res: Response): Promise<void> {
        const universityId = req.params.universityId;
        const id = typeof universityId === 'string' ? universityId : universityId?.[0];

        if (!id) {
            throw new BadRequestError('University ID is required');
        }

        const methods = await getAvailableVerificationMethods(id);

        success(res, {
            message: 'Verification methods retrieved successfully',
            data: {
                universityId: id,
                methods,
            },
        });
    }

    /**
     * Initiate verification process
     * Determines best method and starts verification
     */
    public async initiateVerification(req: Request, res: Response): Promise<void> {
        const validated = initiateVerificationSchema.parse(req.body);

        // Check NDPR consent
        if (!validated.ndprConsent) {
            throw new BadRequestError('NDPR consent is required to proceed with verification');
        }

        // Get available methods
        const availableMethods = await getAvailableVerificationMethods(validated.universityId);

        // Determine best method
        const bestMethod = await determineBestVerificationMethod(
            validated.universityId,
            validated.email,
            !!validated.registrationNumber,
            !!validated.phoneNumber
        );

        if (!bestMethod) {
            throw new BadRequestError('No suitable verification method available. Please provide email, registration number, or phone number.');
        }

        // Return next steps based on method
        success(res, {
            message: 'Verification method determined',
            data: {
                recommendedMethod: bestMethod,
                availableMethods: availableMethods.map(m => m.methodType),
                nextStep: this.getNextStepForMethod(bestMethod, validated),
            },
        });
    }

    /**
     * Verify student via email (magic link)
     */
    public async verifyEmail(req: Request, res: Response): Promise<void> {
        const { email, universityId } = req.body;

        if (!email || !universityId) {
            // Magic-link verification is a separate flow: use GET /api/verification/email/verify?token=...
            throw new BadRequestError('Email and university ID are required');
        }

        // Validate email domain
        const emailValidation = await validateStudentEmailDomain(email, universityId);
        if (!emailValidation.valid) {
            throw new BadRequestError('Invalid student email domain. Please use your university email (.edu, .edu.ng)');
        }

        // Generate magic link token
        const magicLinkToken = generateMagicLinkToken();
        const expiresAt = getMagicLinkExpiryDate();

        // Find or create student (we'll create user and student if needed)
        let studentId: string;
        let userId: string;

        const client = await db.getPool().connect();

        // Check if user exists
        const userResult = await client.query(
            `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`,
            [email]
        );

        try {
            await client.query('BEGIN');

            if (userResult.rows.length === 0) {
                // Create user (will be updated after verification)
                const newUserResult = await client.query(
                    `INSERT INTO users (email, role, verification_status, ndpr_consent, consent_timestamp)
                     VALUES ($1, 'student', 'unverified', true, CURRENT_TIMESTAMP)
                     RETURNING id`,
                    [email]
                );
                userId = newUserResult.rows[0].id;

                // Create student profile
                const newStudentResult = await client.query(
                    `INSERT INTO students (user_id, name, university, status)
                     VALUES ($1, $2, $3, 'active')
                     RETURNING id`,
                    [userId, emailValidation.universityName || 'Student', emailValidation.universityName || '']
                );
                studentId = newStudentResult.rows[0].id;
            } else {
                userId = userResult.rows[0].id;

                // Get student
                const studentResult = await client.query(
                    `SELECT id FROM students WHERE user_id = $1`,
                    [userId]
                );

                if (studentResult.rows.length === 0) {
                    const newStudentResult = await client.query(
                        `INSERT INTO students (user_id, name, university, status)
                         VALUES ($1, $2, $3, 'active')
                         RETURNING id`,
                        [userId, emailValidation.universityName || 'Student', emailValidation.universityName || '']
                    );
                    studentId = newStudentResult.rows[0].id;
                } else {
                    studentId = studentResult.rows[0].id;
                }

                // Update NDPR consent
                await client.query(
                    `UPDATE users SET ndpr_consent = true, consent_timestamp = CURRENT_TIMESTAMP WHERE id = $1`,
                    [userId]
                );
            }

            // Create verification record
            await client.query(
                `INSERT INTO verifications (student_id, method, status, magic_link_token, expires_at, ndpr_consent, consent_timestamp)
                 VALUES ($1, 'email', 'pending', $2, $3, true, CURRENT_TIMESTAMP)`,
                [studentId, magicLinkToken, expiresAt]
            );

            await client.query('COMMIT');

            // Send magic link email
            const emailResult = await sendMagicLinkEmail(email, magicLinkToken, emailValidation.universityName);

            if (!emailResult.success) {
                appLogger.error('Failed to send magic link:', emailResult.error);
            }

            success(res, {
                message: 'Magic link sent to your email. Please check your inbox.',
                data: {
                    email,
                    expiresInMinutes: 15,
                },
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Verify magic link token
     */
    public async verifyMagicLink(req: Request, res: Response): Promise<void> {
        const { token } = req.query;

        if (!token || typeof token !== 'string') {
            throw new BadRequestError('Token is required');
        }

        // Find verification by token
        const verificationResult = await db.query(
            `SELECT v.id, v.student_id, v.expires_at, s.user_id, u.email
             FROM verifications v
             JOIN students s ON s.id = v.student_id
             JOIN users u ON u.id = s.user_id
             WHERE v.magic_link_token = $1 AND v.method = 'email' AND v.status = 'pending'
             LIMIT 1`,
            [token]
        );

        if (verificationResult.rows.length === 0) {
            throw new UnauthorizedError('Invalid or expired verification token');
        }

        const verification = verificationResult.rows[0];

        // Check if expired
        if (new Date() > new Date(verification.expires_at)) {
            throw new UnauthorizedError('Verification token has expired');
        }

        const client = await db.getPool().connect();

        try {
            await client.query('BEGIN');

            // Mark verification as verified
            await client.query(
                `UPDATE verifications 
                 SET status = 'verified', verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [verification.id]
            );

            // Update student verification date
            await client.query(
                `UPDATE students 
                 SET verification_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [verification.student_id]
            );

            // Update user verification status
            await client.query(
                `UPDATE users 
                 SET verification_status = 'verified', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [verification.user_id]
            );

            await client.query('COMMIT');

            // Generate tokens for the user
            const tokens = jwtService.generateTokenPair({
                userId: verification.user_id,
                email: verification.email,
                role: 'student',
            });

            // Create verification success notification
            try {
                const { NotificationService } = await import('../services/notification/notification.service.js');
                await NotificationService.notifyVerificationSuccess(verification.student_id);
            } catch (error) {
                // Log error but don't fail the verification
                appLogger.error('Error creating verification notification:', error);
            }

            success(res, {
                message: 'Email verified successfully',
                data: {
                    verified: true,
                    tokens,
                },
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Verify student via registration number
     */
    public async verifyRegistrationNumber(req: Request, res: Response): Promise<void> {
        const validated = verifyRegistrationSchema.parse(req.body);

        // Verify registration number with university database
        const verificationResult = await verifyRegistrationNumber(
            validated.universityId,
            validated.registrationNumber,
            validated.studentName,
            validated.studentEmail
        );

        if (!verificationResult.verified) {
            throw new UnauthorizedError(verificationResult.error || 'Registration number verification failed');
        }

        // Find or create user and student
        let studentId: string;
        let userId: string;
        const email = validated.studentEmail || `${validated.registrationNumber}@university.edu`;

        const client = await db.getPool().connect();

        try {
            await client.query('BEGIN');

            // Check if user exists
            const userResult = await client.query(
                `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`,
                [email]
            );

            if (userResult.rows.length === 0) {
                // Create user
                const newUserResult = await client.query(
                    `INSERT INTO users (email, role, verification_status, ndpr_consent, consent_timestamp)
                     VALUES ($1, 'student', 'unverified', true, CURRENT_TIMESTAMP)
                     RETURNING id`,
                    [email]
                );
                userId = newUserResult.rows[0].id;

                // Create student
                const newStudentResult = await client.query(
                    `INSERT INTO students (user_id, name, university, registration_number, status)
                     VALUES ($1, $2, $3, $4, 'active')
                     RETURNING id`,
                    [userId, verificationResult.studentData?.name || validated.studentName || 'Student', '', validated.registrationNumber]
                );
                studentId = newStudentResult.rows[0].id;
            } else {
                userId = userResult.rows[0].id;

                const studentResult = await client.query(
                    `SELECT id FROM students WHERE user_id = $1`,
                    [userId]
                );

                if (studentResult.rows.length === 0) {
                    const newStudentResult = await client.query(
                        `INSERT INTO students (user_id, name, university, registration_number, status)
                         VALUES ($1, $2, $3, $4, 'active')
                         RETURNING id`,
                        [userId, verificationResult.studentData?.name || validated.studentName || 'Student', '', validated.registrationNumber]
                    );
                    studentId = newStudentResult.rows[0].id;
                } else {
                    studentId = studentResult.rows[0].id;
                    // Update registration number
                    await client.query(
                        `UPDATE students SET registration_number = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                        [validated.registrationNumber, studentId]
                    );
                }

                await client.query(
                    `UPDATE users SET ndpr_consent = true, consent_timestamp = CURRENT_TIMESTAMP WHERE id = $1`,
                    [userId]
                );
            }

            // Create verification record
            const expiresAt = new Date();
            expiresAt.setMinutes(expiresAt.getMinutes() + 15); // 15 minute token

            await client.query(
                `INSERT INTO verifications (student_id, method, status, registration_number, verified_at, expires_at, university_data, ndpr_consent, consent_timestamp)
                 VALUES ($1, 'registration', 'verified', $2, CURRENT_TIMESTAMP, $3, $4, true, CURRENT_TIMESTAMP)
                 ON CONFLICT DO NOTHING`,
                [studentId, validated.registrationNumber, expiresAt, JSON.stringify(verificationResult.studentData || {})]
            );

            // Update student verification
            await client.query(
                `UPDATE students SET verification_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [studentId]
            );

            // Update user verification status
            await client.query(
                `UPDATE users SET verification_status = 'verified', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [userId]
            );

            await client.query('COMMIT');

            // Generate tokens
            const userEmailResult = await client.query(`SELECT email FROM users WHERE id = $1`, [userId]);
            const tokens = jwtService.generateTokenPair({
                userId,
                email: userEmailResult.rows[0].email,
                role: 'student',
            });

            // Create verification success notification
            try {
                const { NotificationService } = await import('../services/notification/notification.service.js');
                await NotificationService.notifyVerificationSuccess(studentId);
            } catch (error) {
                // Log error but don't fail the verification
                appLogger.error('Error creating verification notification:', error);
            }

            success(res, {
                message: 'Registration number verified successfully',
                data: {
                    verified: true,
                    studentData: verificationResult.studentData,
                    tokens,
                },
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Request WhatsApp OTP for verification
     */
    public async requestWhatsAppOTP(req: Request, res: Response): Promise<void> {
        const { phoneNumber, universityId } = req.body;

        if (!phoneNumber || !universityId) {
            throw new BadRequestError('Phone number and university ID are required');
        }

        // Generate OTP
        const otp = generateOTP();

        // Find or create student (similar to email flow)
        // For now, create verification record and send OTP
        // User/student creation will happen on OTP verification

        // Send WhatsApp OTP
        const result = await sendWhatsAppOTP(phoneNumber, otp);

        if (!result.success && !result.error?.includes('not configured')) {
            throw new BadRequestError(result.error || 'Failed to send WhatsApp OTP');
        }

        success(res, {
            message: 'OTP sent to your WhatsApp. Please check your messages.',
            data: {
                phoneNumber,
                expiresInMinutes: 5,
                ...(result.error?.includes('not configured') && { note: 'WhatsApp service not configured. OTP is available for testing.' }),
            },
        });
    }

    /**
     * Verify WhatsApp OTP
     */
    public async verifyWhatsAppOTP(req: Request, res: Response): Promise<void> {
        const validated = verifyWhatsAppSchema.parse(req.body);
        const { studentName } = req.body;

        // Verify OTP from Redis
        const isValid = await verifyOTPFromRedis(validated.phoneNumber, validated.otp);

        if (!isValid) {
            throw new UnauthorizedError('Invalid or expired OTP');
        }

        const enrollment = await verifyRegistrationNumber(validated.universityId, validated.registrationNumber, studentName);
        if (enrollment.verified !== true) {
            throw new UnauthorizedError(enrollment.error || 'University enrollment could not be verified');
        }

        // Create user and student if needed
        const email = `${validated.phoneNumber.replace(/\+/g, '')}@student.awoof.com`;
        let studentId: string;
        let userId: string;

        const client = await db.getPool().connect();

        try {
            await client.query('BEGIN');

            const userResult = await client.query(
                `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`,
                [email]
            );

            if (userResult.rows.length === 0) {
                const newUserResult = await client.query(
                    `INSERT INTO users (email, role, verification_status, ndpr_consent, consent_timestamp)
                     VALUES ($1, 'student', 'unverified', true, CURRENT_TIMESTAMP)
                     RETURNING id`,
                    [email]
                );
                userId = newUserResult.rows[0].id;

                const newStudentResult = await client.query(
                    `INSERT INTO students (user_id, name, phone_number, university, status)
                     VALUES ($1, $2, $3, $4, 'active')
                     RETURNING id`,
                    [userId, studentName || 'Student', validated.phoneNumber, '']
                );
                studentId = newStudentResult.rows[0].id;
            } else {
                userId = userResult.rows[0].id;
                const studentResult = await client.query(`SELECT id FROM students WHERE user_id = $1`, [userId]);
                studentId = studentResult.rows[0]?.id || (
                    await client.query(
                        `INSERT INTO students (user_id, name, phone_number, university, status)
                         VALUES ($1, $2, $3, $4, 'active')
                         RETURNING id`,
                        [userId, studentName || 'Student', validated.phoneNumber, '']
                    )
                ).rows[0].id;

                await client.query(
                    `UPDATE users SET ndpr_consent = true, consent_timestamp = CURRENT_TIMESTAMP WHERE id = $1`,
                    [userId]
                );
            }

            // Create verification record
            const expiresAt = new Date();
            expiresAt.setMinutes(expiresAt.getMinutes() + 15);

            await client.query(
                `INSERT INTO verifications (student_id, method, status, otp_code, verified_at, expires_at, ndpr_consent, consent_timestamp)
                 VALUES ($1, 'whatsapp', 'verified', $2, CURRENT_TIMESTAMP, $3, true, CURRENT_TIMESTAMP)`,
                [studentId, validated.otp, expiresAt]
            );

            // Update student and user
            await client.query(
                `UPDATE students SET verification_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [studentId]
            );

            await client.query(
                `UPDATE users SET verification_status = 'verified', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [userId]
            );

            await client.query('COMMIT');

            // Generate tokens
            const userEmailResult = await client.query(`SELECT email FROM users WHERE id = $1`, [userId]);
            const tokens = jwtService.generateTokenPair({
                userId,
                email: userEmailResult.rows[0].email,
                role: 'student',
            });

            // Create verification success notification
            try {
                const { NotificationService } = await import('../services/notification/notification.service.js');
                await NotificationService.notifyVerificationSuccess(studentId);
            } catch (error) {
                // Log error but don't fail the verification
                appLogger.error('Error creating verification notification:', error);
            }

            success(res, {
                message: 'WhatsApp OTP verified successfully',
                data: {
                    verified: true,
                    tokens,
                },
            });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Get verification status
     */
    public async getVerificationStatus(req: Request, res: Response): Promise<void> {
        const studentIdParam = req.params.studentId;
        const studentId = typeof studentIdParam === 'string' ? studentIdParam : studentIdParam?.[0];

        if (!studentId) {
            throw new BadRequestError('Student ID is required');
        }

        const status = await getStudentVerificationStatus(studentId);

        success(res, {
            message: 'Verification status retrieved successfully',
            data: {
                status,
            },
        });
    }

    /**
     * Helper: Get next step for verification method
     */
    private getNextStepForMethod(method: string, data: any): any {
        switch (method) {
            case 'email':
                return {
                    action: 'sendEmail',
                    email: data.email,
                };
            case 'registration':
                return {
                    action: 'verifyRegistration',
                    registrationNumber: data.registrationNumber,
                };
            case 'whatsapp':
                return {
                    action: 'sendOTP',
                    phoneNumber: data.phoneNumber,
                };
            case 'portal':
                return {
                    action: 'redirectToPortal',
                };
            default:
                return {};
        }
    }

    /**
     * Generate verification token for widget (requires authenticated student)
     */
    public async generateWidgetToken(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'student') {
            throw new UnauthorizedError('Only verified students can generate widget tokens');
        }

        // Validate request body
        const validated = generateWidgetTokenSchema.parse(req.body);

        const vendorOrigin = new URL(validated.origin);
        const localDevelopment = config.isDevelopment
            && vendorOrigin.protocol === 'http:'
            && ['localhost', '127.0.0.1', '[::1]'].includes(vendorOrigin.hostname);
        if (vendorOrigin.protocol !== 'https:' && !localDevelopment) {
            throw new BadRequestError('Vendor origin must use HTTPS');
        }

        const widgetConfig = await db.query(
            `SELECT vendor_id
             FROM widget_configs
             WHERE vendor_id = $1
               AND api_key = $2
               AND status = 'active'
               AND $3 = ANY(allowed_domains)`,
            [validated.vendorId, validated.apiKey, vendorOrigin.hostname.toLowerCase()]
        );
        if (widgetConfig.rows.length === 0) {
            throw new ForbiddenError('Vendor origin is not allowed for this widget');
        }

        // Get student ID from user
        const studentResult = await db.query(
            'SELECT id, status FROM students WHERE user_id = $1',
            [req.user.userId]
        );

        if (studentResult.rows.length === 0) {
            throw new BadRequestError('Student profile not found');
        }

        const student = studentResult.rows[0];

        // Check if student is verified
        const userResult = await db.query(
            'SELECT verification_status FROM users WHERE id = $1',
            [req.user.userId]
        );

        if (userResult.rows.length === 0 || userResult.rows[0].verification_status !== 'verified') {
            throw new UnauthorizedError('Student must be verified to generate widget token');
        }

        // Generate verification token
        const { token, expiresAt } = await createVerificationToken(
            student.id,
            validated.vendorId,
            validated.productId
        );

        success(res, {
            message: 'Verification token generated successfully',
            data: {
                token,
                studentId: student.id,
                expiresAt,
                expiresInMinutes: 30,
            },
        });
    }
}
