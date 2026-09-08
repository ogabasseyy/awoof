/**
 * Authentication Controller
 * 
 * Handles authentication business logic
 * Follows Single Responsibility Principle - only handles auth operations
 */

import type { Request, Response } from 'express';
import { db } from '../config/database.js';
import { redis } from '../config/redis.js';
import { jwtService } from '../services/auth/jwt.service.js';
import { issueSession, refreshSession, revokeSessionByRefreshToken } from '../services/auth/session.service.js';
import { passwordService } from '../services/auth/password.service.js';
import { generateOTP, getOTPExpiryDate, isOTPExpired } from '../services/auth/otp.service.js';
import { isEmailConfigured, sendPasswordResetOTP, sendEmailVerificationOTP } from '../services/email/email.service.js';
import { preflightStudentEmail, type StudentEmailPreflight } from '../services/verification/student-email-verification.service.js';
import {
    createStudentSignupService,
    StudentSignupRateLimitError,
    type StudentSignupService,
} from '../services/auth/student-signup.service.js';
import { normalizeMailbox } from '../services/verification/eligibility-policy.service.js';
import { VERIFICATION_NOTICE_TEXT, VERIFICATION_NOTICE_VERSION } from '../services/verification/verification-notices.js';
import {
    AppError,
    BadRequestError,
    UnauthorizedError,
    ConflictError,
} from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import { appLogger } from '../common/logger.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import { z } from 'zod';

/**
 * Validation schemas
 */
const registerSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    role: z.enum(['student', 'vendor'], {
        errorMap: () => ({ message: 'Role must be student or vendor' }),
    }),
    name: z.string().min(2, 'Name must be at least 2 characters'),
    // Required for students, optional for vendors
    university: z.string().uuid('Invalid university ID').optional().or(z.literal('')),
    matricNumber: z.string().optional().or(z.literal('')),
}).refine((data) => {
    // University is required for students
    if (data.role === 'student') {
        return data.university && data.university.trim() !== '';
    }
    return true;
}, {
    message: 'University is required for student registration',
    path: ['university'],
});

const loginSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
    role: z.enum(['admin', 'vendor', 'student']).optional(), // Optional role check for route-specific logins
    rememberMe: z.boolean().optional().default(false), // Remember me checkbox
});

const refreshTokenSchema = z.object({
    refreshToken: z.string().min(1, 'Refresh token is required'),
});

/**
 * Authentication Controller
 */
export class AuthController {
    private readonly studentSignupService: StudentSignupService;
    private readonly studentEmailPreflight: (universityId: string, email: string) => Promise<StudentEmailPreflight>;
    private readonly sendVendorVerification: typeof sendEmailVerificationOTP;
    private readonly issueStudentSession: typeof issueSession;

    constructor(dependencies: {
        studentSignupService?: StudentSignupService;
        studentEmailPreflight?: (universityId: string, email: string) => Promise<StudentEmailPreflight>;
        issueSession?: typeof issueSession;
        sendVendorVerification?: typeof sendEmailVerificationOTP;
    } = {}) {
        this.studentSignupService = dependencies.studentSignupService ?? createStudentSignupService({
            pool: { connect: () => db.getPool().connect() },
            isEmailConfigured,
            deliverOtp: async (email, code, name) => {
                const result = await sendEmailVerificationOTP(email, code, name, 'student');
                return { success: result.success };
            },
        });
        this.studentEmailPreflight = dependencies.studentEmailPreflight ?? preflightStudentEmail;
        this.issueStudentSession = dependencies.issueSession ?? issueSession;
        this.sendVendorVerification = dependencies.sendVendorVerification ?? sendEmailVerificationOTP;
    }

    /**
     * Register a new user
     */
    public async register(req: Request, res: Response): Promise<void> {
        if (req.body?.role === 'student') {
            throw new AppError(
                'Student registration now requires school-email proof. Use /auth/student/register-request.',
                410,
                'STUDENT_SIGNUP_RETIRED',
            );
        }
        // Validate input
        const validated = registerSchema.parse(req.body);
        const normalizedEmail = normalizeMailbox(validated.email);

        // Validate password strength
        const passwordValidation = passwordService.validatePassword(
            validated.password
        );
        if (!passwordValidation.valid) {
            throw new BadRequestError(
                passwordValidation.errors.join(', ')
            );
        }

        // Check if user already exists
        const existingUser = await db.query(
            'SELECT id FROM users WHERE lower(btrim(email)) = $1',
            [normalizedEmail]
        );

        if (existingUser.rows.length > 0) {
            throw new ConflictError('User with this email already exists');
        }

        // Hash password
        const passwordHash = await passwordService.hashPassword(validated.password);

        // Start transaction (in case we need to rollback)
        let committed = false;
        let released = false;
        const client = await db.getPool().connect();

        try {
            await client.query('BEGIN');

            // Create user
            const userResult = await client.query(
                `INSERT INTO users (email, password_hash, role, verification_status)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id, email, role, verification_status, created_at`,
                [normalizedEmail, passwordHash, validated.role, 'unverified']
            );

            const user = userResult.rows[0];

            if (validated.role === 'vendor') {
                await client.query(
                    `INSERT INTO vendors (user_id, name, status)
                     VALUES ($1, $2, 'pending')`,
                    [user.id, validated.name]
                );
            }

            // Vendor verification remains on its established route. Student signup returns above.
            if (validated.role === 'vendor') {
                const emailOTP = generateOTP(6);
                const otpExpiresAt = getOTPExpiryDate();

                // Store OTP in database
                await client.query(
                    `UPDATE users 
                     SET email_verification_otp = $1, email_verification_otp_expires_at = $2
                     WHERE id = $3`,
                    [emailOTP, otpExpiresAt, user.id]
                );

                // Send verification email (don't await to avoid blocking response)
                this.sendVendorVerification(normalizedEmail, emailOTP, validated.name, validated.role)
                    .then((result) => {
                        if (!result.success) {
                            appLogger.error('Failed to send email verification OTP:', result.error);
                        }
                    })
                    .catch((error) => {
                        appLogger.error('Error sending email verification OTP:', error);
                    });
            }

            await client.query('COMMIT');
            committed = true;
            client.release();
            released = true;

            let tokens;
            try {
                tokens = await this.issueStudentSession({
                    userId: user.id,
                    email: user.email,
                    role: user.role,
                }, false, passwordHash);
            } catch {
                throw new AppError('Your account was created, but we could not start a session. Please sign in with your email and password.', 503, 'SESSION_ISSUANCE_UNAVAILABLE');
            }

            success(res, {
                message: validated.role === 'vendor'
                    ? 'User registered successfully. Please check your email for verification code.'
                    : 'User registered successfully',
                data: {
                    user: {
                        id: user.id,
                        email: user.email,
                        role: user.role,
                        verificationStatus: user.verification_status,
                    },
                    tokens,
                    requiresEmailVerification: validated.role === 'vendor',
                },
            }, 201);
        } catch (error) {
            if (!committed) await client.query('ROLLBACK');
            throw error;
        } finally {
            if (!released) client.release();
        }
    }

    /**
     * Login user
     */
    public async login(req: Request, res: Response): Promise<void> {
        // Validate input
        const validated = loginSchema.parse(req.body);
        const normalizedEmail = normalizeMailbox(validated.email);

        // Find user
        const userResult = await db.query(
            `SELECT id, email, password_hash, role, verification_status, deleted_at
             FROM users
             WHERE lower(btrim(email)) = $1`,
            [normalizedEmail]
        );

        if (userResult.rows.length === 0) {
            throw new UnauthorizedError('Invalid email or password');
        }

        const user = userResult.rows[0];

        // Check if user is deleted
        if (user.deleted_at) {
            throw new UnauthorizedError('Account has been deleted');
        }

        // Verify password
        const isPasswordValid = await passwordService.comparePassword(
            validated.password,
            user.password_hash
        );

        if (!isPasswordValid) {
            throw new UnauthorizedError('Invalid email or password');
        }

        // If role is specified in login request, verify user has that role
        if (validated.role && user.role !== validated.role) {
            throw new UnauthorizedError(`Access denied. This login is restricted to ${validated.role} users only.`);
        }

        // Generate tokens (with rememberMe option)
        const rememberMe = validated.rememberMe ?? false;
        const tokens = await issueSession({
            userId: user.id,
            email: user.email,
            role: user.role,
        }, rememberMe, user.password_hash);

        success(res, {
            message: 'Login successful',
            data: {
                user: {
                    id: user.id,
                    email: user.email,
                    role: user.role,
                    verificationStatus: user.verification_status,
                },
                tokens,
            },
        });
    }

    /**
     * Refresh access token
     */
    public async refreshToken(req: Request, res: Response): Promise<void> {
        // Validate input
        const validated = refreshTokenSchema.parse(req.body);

        const accessToken = await refreshSession(validated.refreshToken);

        success(res, {
            message: 'Token refreshed successfully',
            data: {
                accessToken,
            },
        });
    }

    /**
     * Logout user
     */
    public async logout(req: AuthRequest, res: Response): Promise<void> {
        const body = z.object({ refreshToken: z.string().min(1).max(4096) }).strict().parse(req.body);
        await revokeSessionByRefreshToken(body.refreshToken);

        success(res, {
            message: 'Logged out successfully',
            data: {},
        });
    }

    /**
     * Get current user
     */
    public async getCurrentUser(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) {
            throw new UnauthorizedError('User not authenticated');
        }

        // Get user details
        const userResult = await db.query(
            `SELECT id, email, role, verification_status, created_at
             FROM users
             WHERE id = $1 AND deleted_at IS NULL`,
            [req.user.userId]
        );

        if (userResult.rows.length === 0) {
            throw new UnauthorizedError('User not found');
        }

        const user = userResult.rows[0];

        // Get additional profile data based on role
        let profile = null;
        if (user.role === 'student') {
            const studentResult = await db.query(
                'SELECT name, university, registration_number FROM students WHERE user_id = $1',
                [user.id]
            );
            profile = studentResult.rows[0] || null;
        } else if (user.role === 'vendor') {
            const vendorResult = await db.query(
                'SELECT name, status FROM vendors WHERE user_id = $1',
                [user.id]
            );
            profile = vendorResult.rows[0] || null;
        }

        success(res, {
            message: 'User retrieved successfully',
            data: {
                id: user.id,
                email: user.email,
                role: user.role,
                verificationStatus: user.verification_status,
                profile,
            },
        }, 200);
    }

    /**
     * Forgot password - Send OTP
     */
    public async forgotPassword(req: Request, res: Response): Promise<void> {
        // Validate input
        const { email, role } = req.body;

        if (!email) {
            throw new BadRequestError('Email is required');
        }
        const normalizedEmail = normalizeMailbox(email);

        // Find user
        const userResult = await db.query(
            `SELECT id, email, role FROM users WHERE lower(btrim(email)) = $1 AND deleted_at IS NULL`,
            [normalizedEmail]
        );

        // Don't reveal if email exists (security best practice)
        if (userResult.rows.length === 0) {
            success(res, {
                message: 'If the email exists, an OTP has been sent',
                data: {},
            });
            return;
        }

        const user = userResult.rows[0];

        // If role is specified in request, verify user has that role
        if (role && user.role !== role) {
            // Still return success to not reveal if email exists (security best practice)
            success(res, {
                message: 'If the email exists, an OTP has been sent',
                data: {},
            });
            return;
        }

        // Generate OTP
        const otp = generateOTP();
        const expiresAt = getOTPExpiryDate();

        // Store OTP in database
        await db.query(
            `UPDATE users 
             SET password_reset_otp = $1, password_reset_otp_expires_at = $2 
             WHERE id = $3`,
            [otp, expiresAt, user.id]
        );

        // Send OTP via email
        const emailResult = await sendPasswordResetOTP(user.email, otp);

        if (!emailResult.success) {
            appLogger.error('Failed to send OTP email:', emailResult.error);
            // Still return success to user (security - don't reveal if email failed)
        }

        success(res, {
            message: 'If the email exists, an OTP has been sent',
            data: {},
        });
    }

    /**
     * Verify OTP for password reset
     */
    public async verifyResetOTP(req: Request, res: Response): Promise<void> {
        // Validate input
        const schema = z.object({
            email: z.string().email('Invalid email address'),
            otp: z.string().length(6, 'OTP must be 6 digits'),
        });

        const validated = schema.parse(req.body);
        const normalizedEmail = normalizeMailbox(validated.email);

        // Find user with valid OTP
        const userResult = await db.query(
            `SELECT id, email, password_reset_otp, password_reset_otp_expires_at
             FROM users 
             WHERE lower(btrim(email)) = $1
               AND password_reset_otp = $2 
               AND deleted_at IS NULL`,
            [normalizedEmail, validated.otp]
        );

        if (userResult.rows.length === 0) {
            throw new UnauthorizedError('Invalid OTP');
        }

        const user = userResult.rows[0];

        // Check if OTP is expired
        if (isOTPExpired(user.password_reset_otp_expires_at)) {
            throw new UnauthorizedError('OTP has expired. Please request a new one.');
        }

        // OTP is valid - generate a reset token (JWT) for password reset
        const resetToken = jwtService.generateAccessToken({
            userId: user.id,
            email: user.email,
            role: 'student', // Default, will be verified when resetting
        });

        // Store reset token in Redis (optional, for additional security)
        const redisClient = redis.getClient();
        if (redis.isConnected()) {
            await redisClient.setex(
                `password_reset:${user.id}`,
                10 * 60, // 10 minutes
                resetToken
            );
        }

        success(res, {
            message: 'OTP verified successfully',
            data: {
                resetToken,
            },
        });
    }

    /**
     * Reset password with OTP
     */
    public async resetPassword(req: Request, res: Response): Promise<void> {
        // Validate input
        const schema = z.object({
            email: z.string().email('Invalid email address'),
            otp: z.string().length(6, 'OTP must be 6 digits'),
            newPassword: z.string().min(8, 'Password must be at least 8 characters'),
        });

        const validated = schema.parse(req.body);
        const normalizedEmail = normalizeMailbox(validated.email);

        // Validate password strength
        const passwordValidation = passwordService.validatePassword(validated.newPassword);
        if (!passwordValidation.valid) {
            throw new BadRequestError(passwordValidation.errors.join(', '));
        }

        // Find user with valid OTP
        const userResult = await db.query(
            `SELECT id, email, password_reset_otp, password_reset_otp_expires_at
             FROM users 
             WHERE lower(btrim(email)) = $1
               AND password_reset_otp = $2 
               AND deleted_at IS NULL`,
            [normalizedEmail, validated.otp]
        );

        if (userResult.rows.length === 0) {
            throw new UnauthorizedError('Invalid OTP');
        }

        const user = userResult.rows[0];

        // Check if OTP is expired
        if (isOTPExpired(user.password_reset_otp_expires_at)) {
            throw new UnauthorizedError('OTP has expired. Please request a new one.');
        }

        // Hash new password
        const passwordHash = await passwordService.hashPassword(validated.newPassword);

        // Update password and clear OTP
        await db.query(
            `UPDATE users 
             SET password_hash = $1, 
                 password_reset_otp = NULL, 
                 password_reset_otp_expires_at = NULL,
                 refresh_token_hash = NULL,
                 refresh_token_expires_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [passwordHash, user.id]
        );

        // Clear the password-reset cache entry; refresh-session authority is durable.
        const redisClient = redis.getClient();
        if (redis.isConnected()) {
            await redisClient.del(`password_reset:${user.id}`);
        }

        success(res, {
            message: 'Password reset successfully',
            data: {},
        });
    }

    /**
     * Update password (requires old password)
     */
    public async updatePassword(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user) {
            throw new UnauthorizedError('User not authenticated');
        }

        // Validate input
        const schema = z.object({
            oldPassword: z.string().min(1, 'Old password is required'),
            newPassword: z.string().min(8, 'Password must be at least 8 characters'),
        });

        const validated = schema.parse(req.body);

        // Validate new password strength
        const passwordValidation = passwordService.validatePassword(validated.newPassword);
        if (!passwordValidation.valid) {
            throw new BadRequestError(passwordValidation.errors.join(', '));
        }

        // Get user with password hash
        const userResult = await db.query(
            `SELECT id, password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
            [req.user.userId]
        );

        if (userResult.rows.length === 0) {
            throw new UnauthorizedError('User not found');
        }

        const user = userResult.rows[0];

        // Verify old password
        const isPasswordValid = await passwordService.comparePassword(
            validated.oldPassword,
            user.password_hash
        );

        if (!isPasswordValid) {
            throw new UnauthorizedError('Old password is incorrect');
        }

        // Hash new password
        const passwordHash = await passwordService.hashPassword(validated.newPassword);

        // Update password
        await db.query(
            `UPDATE users 
             SET password_hash = $1, 
                 refresh_token_hash = NULL,
                 refresh_token_expires_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [passwordHash, user.id]
        );

        success(res, {
            message: 'Password updated successfully',
            data: {},
        });
    }

    /**
     * Verify email with OTP (for vendor and student registration)
     */
    public async verifyEmail(req: Request, res: Response): Promise<void> {
        const schema = z.object({
            email: z.string().email('Invalid email address'),
            otp: z.string().length(6, 'OTP must be 6 digits'),
        });

        const validated = schema.parse(req.body);
        const normalizedEmail = normalizeMailbox(validated.email);

        // Get user by email
        const userResult = await db.query(
            `SELECT id, email, email_verification_otp, email_verification_otp_expires_at, 
                    verification_status, role
             FROM users 
             WHERE lower(btrim(email)) = $1 AND deleted_at IS NULL`,
            [normalizedEmail]
        );

        if (userResult.rows.length === 0) {
            throw new UnauthorizedError('User not found');
        }

        const user = userResult.rows[0];

        // Check if user is a vendor or student
        if (user.role !== 'vendor' && user.role !== 'student') {
            throw new BadRequestError('Email verification is only available for vendors and students');
        }

        // Check if email is already verified
        if (user.verification_status === 'verified') {
            throw new BadRequestError('Email is already verified');
        }

        // Check if OTP exists
        if (!user.email_verification_otp) {
            throw new BadRequestError('No verification OTP found. Please request a new one.');
        }

        // Check if OTP is expired
        if (isOTPExpired(user.email_verification_otp_expires_at)) {
            throw new BadRequestError('Verification OTP has expired. Please request a new one.');
        }

        // Verify OTP
        if (user.email_verification_otp !== validated.otp) {
            throw new UnauthorizedError('Invalid verification OTP');
        }

        // Update user verification status and clear OTP
        await db.query(
            `UPDATE users 
             SET verification_status = 'verified',
                 email_verification_otp = NULL,
                 email_verification_otp_expires_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [user.id]
        );

        success(res, {
            message: 'Email verified successfully',
            data: {
                verified: true,
            },
        });
    }

    /**
     * Resend email verification OTP
     */
    public async resendEmailVerification(req: Request, res: Response): Promise<void> {
        const schema = z.object({
            email: z.string().email('Invalid email address'),
        });

        const validated = schema.parse(req.body);
        const normalizedEmail = normalizeMailbox(validated.email);

        // Get user by email
        const userResult = await db.query(
            `SELECT id, email, verification_status, role
             FROM users 
             WHERE lower(btrim(email)) = $1 AND deleted_at IS NULL`,
            [normalizedEmail]
        );

        if (userResult.rows.length === 0) {
            throw new UnauthorizedError('User not found');
        }

        const user = userResult.rows[0];

        // Check if user is a vendor or student
        if (user.role !== 'vendor' && user.role !== 'student') {
            throw new BadRequestError('Email verification is only available for vendors and students');
        }

        // Check if email is already verified
        if (user.verification_status === 'verified') {
            throw new BadRequestError('Email is already verified');
        }

        // Generate new OTP
        const emailOTP = generateOTP(6);
        const otpExpiresAt = getOTPExpiryDate();

        // Store OTP in database
        await db.query(
            `UPDATE users 
             SET email_verification_otp = $1, email_verification_otp_expires_at = $2,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [emailOTP, otpExpiresAt, user.id]
        );

        // Send verification email
        const emailResult = await sendEmailVerificationOTP(validated.email, emailOTP, undefined, user.role);

        if (!emailResult.success) {
            throw new BadRequestError(`Failed to send verification email: ${emailResult.error}`);
        }

        success(res, {
            message: 'Verification OTP sent successfully. Please check your email.',
            data: {},
        });
    }

    public async studentRegisterRequest(req: Request, res: Response): Promise<void> {
        const schema = z.object({
            email: z.string().email('Invalid email address'),
            name: z.string().min(2, 'Name must be at least 2 characters'),
            universityId: z.string().uuid('Invalid university ID'),
            matricNumber: z.string().max(100, 'Matric number must be at most 100 characters').nullable().optional(),
            verificationConsent: z.literal(true),
            noticeVersion: z.literal(VERIFICATION_NOTICE_VERSION),
        }).strict();

        const validated = schema.parse(req.body);

        try {
            const request = await this.studentSignupService.request({
                email: validated.email,
                name: validated.name,
                universityId: validated.universityId,
                matricNumber: validated.matricNumber ?? null,
                verificationConsent: validated.verificationConsent,
                noticeVersion: validated.noticeVersion,
            });
            success(res, {
                message: 'Signup code sent. Please enter it to complete registration.',
                data: {
                    email: request.email,
                    challengeId: request.challengeId,
                    expiresAt: request.expiresAt.toISOString(),
                    resendAvailableAt: request.resendAvailableAt.toISOString(),
                },
            });
        } catch (error) {
            if (error instanceof StudentSignupRateLimitError) {
                res.setHeader('Retry-After', String(Math.max(1, Math.ceil((error.retryAt.getTime() - Date.now()) / 1000))));
            }
            throw error;
        }
    }

    public async studentRegisterConfirm(req: Request, res: Response): Promise<void> {
        const schema = z.object({
            email: z.string().email('Invalid email address'),
            otp: z.string().regex(/^\d{6}$/, 'OTP must be six digits'),
            password: z.string().min(8, 'Password must be at least 8 characters'),
            name: z.string().min(2, 'Name must be at least 2 characters'),
            universityId: z.string().uuid('Invalid university ID'),
            matricNumber: z.string().max(100, 'Matric number must be at most 100 characters').nullable().optional(),
            challengeId: z.string().uuid('Invalid signup challenge ID'),
            verificationConsent: z.literal(true),
            noticeVersion: z.literal(VERIFICATION_NOTICE_VERSION),
        }).strict();

        const validated = schema.parse(req.body);

        const passwordValidation = passwordService.validatePassword(validated.password);
        if (!passwordValidation.valid) {
            throw new BadRequestError(passwordValidation.errors.join(', '));
        }

        const completion = await this.studentSignupService.confirm({
                email: validated.email,
                name: validated.name,
                universityId: validated.universityId,
                matricNumber: validated.matricNumber ?? null,
                verificationConsent: validated.verificationConsent,
                noticeVersion: validated.noticeVersion,
                challengeId: validated.challengeId,
                otp: validated.otp,
                password: validated.password,
            });
        let tokens;
        try {
            tokens = await this.issueStudentSession({
                userId: completion.user.id,
                email: completion.user.email,
                role: completion.user.role,
            }, false, completion.expectedPasswordHash);
        } catch {
            throw new AppError(
                'Your account was created, but we could not start a session. Please sign in with your email and password.',
                503,
                'SESSION_ISSUANCE_UNAVAILABLE',
            );
        }
        success(res, {
            message: 'Registration successful',
            data: {
                user: { ...completion.user, eligibility: completion.eligibility },
                tokens,
                redirectTo: '/marketplace',
            },
        }, 201);
    }

    public async verifyStudentEmail(req: Request, res: Response): Promise<void> {
        const schema = z.object({
            universityId: z.string().uuid('Invalid university ID'),
            email: z.string().email('Invalid email address'),
        }).strict();

        const validated = schema.parse(req.body);
        const preflight = await this.studentEmailPreflight(validated.universityId, validated.email);
        success(res, {
            data: {
                ...preflight,
                verificationNotice: {
                    version: VERIFICATION_NOTICE_VERSION,
                    text: VERIFICATION_NOTICE_TEXT,
                },
            },
        });
    }
}
