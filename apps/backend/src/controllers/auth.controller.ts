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
import { passwordService } from '../services/auth/password.service.js';
import { generateOTP, getOTPExpiryDate, isOTPExpired } from '../services/auth/otp.service.js';
import { sendPasswordResetOTP, sendEmailVerificationOTP, sendWelcomeEmail } from '../services/email/email.service.js';
import { verifyStudentEmail as verifyStudentEmailService } from '../services/verification/student-email-verification.service.js';
import { storeStudentSignupOTP, verifyStudentSignupOTP } from '../services/verification/student-signup-otp.service.js';
import {
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
    /**
     * Register a new user
     */
    public async register(req: Request, res: Response): Promise<void> {
        // Validate input
        const validated = registerSchema.parse(req.body);

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
            'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL',
            [validated.email]
        );

        if (existingUser.rows.length > 0) {
            throw new ConflictError('User with this email already exists');
        }

        // For students, verify email against university database before registration
        if (validated.role === 'student') {
            const universityId = validated.university && validated.university.trim() !== '' ? validated.university : null;
            if (!universityId) {
                throw new BadRequestError('University is required for student registration');
            }

            const emailVerification = await verifyStudentEmailService(universityId, validated.email);
            if (!emailVerification.verified) {
                throw new BadRequestError(
                    emailVerification.error || 'Email verification failed. Please ensure you are using your official university email.'
                );
            }
        }

        // Hash password
        const passwordHash = await passwordService.hashPassword(validated.password);

        // Start transaction (in case we need to rollback)
        const client = await db.getPool().connect();

        try {
            await client.query('BEGIN');

            // Create user
            const userResult = await client.query(
                `INSERT INTO users (email, password_hash, role, verification_status)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id, email, role, verification_status, created_at`,
                [validated.email, passwordHash, validated.role, 'unverified']
            );

            const user = userResult.rows[0];

            // Create student or vendor profile if needed
            if (validated.role === 'student') {
                // Get university name if university ID is provided
                let universityName: string | null = null;
                const universityId = validated.university && validated.university.trim() !== '' ? validated.university : null;
                if (universityId) {
                    const universityResult = await client.query(
                        `SELECT name FROM universities WHERE id = $1 AND is_active = true`,
                        [universityId]
                    );
                    if (universityResult.rows.length > 0) {
                        universityName = universityResult.rows[0].name;
                    }
                }

                const matricNumber = validated.matricNumber && validated.matricNumber.trim() !== '' ? validated.matricNumber : null;

                await client.query(
                    `INSERT INTO students (user_id, name, university, registration_number, status)
                     VALUES ($1, $2, $3, $4, 'active')`,
                    [user.id, validated.name, universityName, matricNumber]
                );
            } else if (validated.role === 'vendor') {
                await client.query(
                    `INSERT INTO vendors (user_id, name, status)
                     VALUES ($1, $2, 'pending')`,
                    [user.id, validated.name]
                );
            }

            // For vendors and students, generate and send email verification OTP
            if (validated.role === 'vendor' || validated.role === 'student') {
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
                sendEmailVerificationOTP(validated.email, emailOTP, validated.name, validated.role)
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

            // Generate tokens
            const tokens = jwtService.generateTokenPair({
                userId: user.id,
                email: user.email,
                role: user.role,
            });

            // Store refresh token in Redis (optional, for token invalidation)
            const redisClient = redis.getClient();
            if (redis.isConnected()) {
                await redisClient.setex(
                    `refresh_token:${user.id}`,
                    7 * 24 * 60 * 60, // 7 days in seconds
                    tokens.refreshToken
                );
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
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Login user
     */
    public async login(req: Request, res: Response): Promise<void> {
        // Validate input
        const validated = loginSchema.parse(req.body);

        // Find user
        const userResult = await db.query(
            `SELECT id, email, password_hash, role, verification_status, deleted_at
             FROM users
             WHERE email = $1`,
            [validated.email]
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
        const tokens = jwtService.generateTokenPair({
            userId: user.id,
            email: user.email,
            role: user.role,
        }, rememberMe);

        // Store refresh token in Redis
        // If remember me is checked, store for 30 days, otherwise 7 days
        const redisExpiry = rememberMe ? 30 * 24 * 60 * 60 : 7 * 24 * 60 * 60;
        const redisClient = redis.getClient();
        if (redis.isConnected()) {
            await redisClient.setex(
                `refresh_token:${user.id}`,
                redisExpiry,
                tokens.refreshToken
            );
        }

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

        // Verify refresh token
        let decoded;
        try {
            decoded = jwtService.verifyRefreshToken(validated.refreshToken);
        } catch (error) {
            throw new UnauthorizedError('Invalid or expired refresh token');
        }

        // Check if refresh token exists in Redis (optional validation)
        const redisClient = redis.getClient();
        if (redis.isConnected()) {
            const storedToken = await redisClient.get(`refresh_token:${decoded.userId}`);
            if (storedToken !== validated.refreshToken) {
                throw new UnauthorizedError('Refresh token not found or invalid');
            }
        }

        // Generate new access token
        const accessToken = jwtService.generateAccessToken({
            userId: decoded.userId,
            email: decoded.email,
            role: decoded.role,
        });

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
        if (!req.user) {
            throw new UnauthorizedError('User not authenticated');
        }

        // Remove refresh token from Redis
        const redisClient = redis.getClient();
        if (redis.isConnected()) {
            await redisClient.del(`refresh_token:${req.user.userId}`);
        }

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

        // Find user
        const userResult = await db.query(
            `SELECT id, email, role FROM users WHERE email = $1 AND deleted_at IS NULL`,
            [email]
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

        // Find user with valid OTP
        const userResult = await db.query(
            `SELECT id, email, password_reset_otp, password_reset_otp_expires_at
             FROM users 
             WHERE email = $1 
               AND password_reset_otp = $2 
               AND deleted_at IS NULL`,
            [validated.email, validated.otp]
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

        // Validate password strength
        const passwordValidation = passwordService.validatePassword(validated.newPassword);
        if (!passwordValidation.valid) {
            throw new BadRequestError(passwordValidation.errors.join(', '));
        }

        // Find user with valid OTP
        const userResult = await db.query(
            `SELECT id, email, password_reset_otp, password_reset_otp_expires_at
             FROM users 
             WHERE email = $1 
               AND password_reset_otp = $2 
               AND deleted_at IS NULL`,
            [validated.email, validated.otp]
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
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [passwordHash, user.id]
        );

        // Invalidate all refresh tokens (force re-login)
        const redisClient = redis.getClient();
        if (redis.isConnected()) {
            await redisClient.del(`refresh_token:${user.id}`);
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
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [passwordHash, user.id]
        );

        // Invalidate all refresh tokens (force re-login with new password)
        const redisClient = redis.getClient();
        if (redis.isConnected()) {
            await redisClient.del(`refresh_token:${req.user.userId}`);
        }

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

        // Get user by email
        const userResult = await db.query(
            `SELECT id, email, email_verification_otp, email_verification_otp_expires_at, 
                    verification_status, role
             FROM users 
             WHERE email = $1 AND deleted_at IS NULL`,
            [validated.email]
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

        // Get user by email
        const userResult = await db.query(
            `SELECT id, email, verification_status, role
             FROM users 
             WHERE email = $1 AND deleted_at IS NULL`,
            [validated.email]
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

    /**
     * Student register request - validate data, verify email domain, send OTP (no user created)
     */
    public async studentRegisterRequest(req: Request, res: Response): Promise<void> {
        const schema = z.object({
            email: z.string().email('Invalid email address'),
            password: z.string().min(8, 'Password must be at least 8 characters'),
            name: z.string().min(2, 'Name must be at least 2 characters'),
            universityId: z.string().uuid('Invalid university ID'),
            matricNumber: z.string().optional().or(z.literal('')),
        });

        const validated = schema.parse(req.body);

        const passwordValidation = passwordService.validatePassword(validated.password);
        if (!passwordValidation.valid) {
            throw new BadRequestError(passwordValidation.errors.join(', '));
        }

        const existingUser = await db.query(
            'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL',
            [validated.email]
        );
        if (existingUser.rows.length > 0) {
            throw new ConflictError('User with this email already exists');
        }

        const emailVerification = await verifyStudentEmailService(validated.universityId, validated.email);
        if (!emailVerification.verified) {
            throw new BadRequestError(
                emailVerification.error || 'Email verification failed. Please ensure you are using your official university email.'
            );
        }

        const otp = await storeStudentSignupOTP(validated.email, {
            universityId: validated.universityId,
            name: validated.name,
            matricNumber: validated.matricNumber ?? '',
        });
        const emailResult = await sendEmailVerificationOTP(validated.email, otp, validated.name, 'student');
        if (!emailResult.success) {
            throw new BadRequestError(`Failed to send verification email: ${emailResult.error}`);
        }

        success(res, {
            message: 'OTP sent to your email. Please enter it to complete registration.',
            data: { email: validated.email },
        });
    }

    /**
     * Student register confirm - verify OTP, create user + student, return JWT, send welcome email
     */
    public async studentRegisterConfirm(req: Request, res: Response): Promise<void> {
        const schema = z.object({
            email: z.string().email('Invalid email address'),
            otp: z.string().length(6, 'OTP must be 6 digits'),
            password: z.string().min(8, 'Password must be at least 8 characters'),
            name: z.string().min(2, 'Name must be at least 2 characters'),
            universityId: z.string().uuid('Invalid university ID'),
            matricNumber: z.string().optional().or(z.literal('')),
        });

        const validated = schema.parse(req.body);

        const passwordValidation = passwordService.validatePassword(validated.password);
        if (!passwordValidation.valid) {
            throw new BadRequestError(passwordValidation.errors.join(', '));
        }

        const claim = await verifyStudentSignupOTP(validated.email, validated.otp);
        if (!claim) {
            throw new UnauthorizedError('Invalid or expired OTP. Please request a new one.');
        }
        if (
            claim.universityId !== validated.universityId
            || claim.name !== validated.name
            || (claim.matricNumber || '') !== (validated.matricNumber || '')
        ) {
            throw new BadRequestError('Signup details do not match the verified request. Please request a new OTP.');
        }

        const emailVerification = await verifyStudentEmailService(validated.universityId, validated.email);
        if (!emailVerification.verified) {
            throw new BadRequestError(
                emailVerification.error || 'Email verification failed. Please ensure you are using your official university email.'
            );
        }

        const existingUser = await db.query(
            'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL',
            [validated.email]
        );
        if (existingUser.rows.length > 0) {
            throw new ConflictError('User with this email already exists');
        }

        const passwordHash = await passwordService.hashPassword(validated.password);

        const client = await db.getPool().connect();
        try {
            await client.query('BEGIN');

            const userResult = await client.query(
                `INSERT INTO users (email, password_hash, role, verification_status)
                 VALUES ($1, $2, 'student', 'verified')
                 RETURNING id, email, role, verification_status, created_at`,
                [validated.email, passwordHash]
            );
            const user = userResult.rows[0];

            const universityResult = await client.query(
                'SELECT name FROM universities WHERE id = $1 AND is_active = true',
                [validated.universityId]
            );
            const universityName = universityResult.rows[0]?.name || null;
            const matricNumber = validated.matricNumber?.trim() || null;

            await client.query(
                `INSERT INTO students (user_id, name, university, university_id, registration_number, status)
                 VALUES ($1, $2, $3, $4, $5, 'active')`,
                [user.id, validated.name, universityName, validated.universityId, matricNumber]
            );

            await client.query('COMMIT');

            const tokens = jwtService.generateTokenPair({
                userId: user.id,
                email: user.email,
                role: user.role,
            });

            const redisClient = redis.getClient();
            if (redis.isConnected()) {
                await redisClient.setex(
                    `refresh_token:${user.id}`,
                    7 * 24 * 60 * 60,
                    tokens.refreshToken
                );
            }

            sendWelcomeEmail(validated.email, validated.name).catch((err) =>
                appLogger.error('Failed to send welcome email:', err)
            );

            success(res, {
                message: 'Registration successful',
                data: {
                    user: { id: user.id, email: user.email, role: user.role, verificationStatus: user.verification_status },
                    tokens,
                    redirectTo: '/marketplace',
                },
            }, 201);
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Verify student email against university database
     * Used during registration to ensure email belongs to the selected university
     */
    public async verifyStudentEmail(req: Request, res: Response): Promise<void> {
        const schema = z.object({
            universityId: z.string().uuid('Invalid university ID'),
            email: z.string().email('Invalid email address'),
        });

        const validated = schema.parse(req.body);

        const verification = await verifyStudentEmailService(validated.universityId, validated.email);

        if (!verification.verified) {
            throw new BadRequestError(
                verification.error || 'Email verification failed. Please ensure you are using your official university email.'
            );
        }

        success(res, {
            message: 'Email verified successfully',
            data: {
                verified: true,
                studentData: verification.studentData,
            },
        });
    }
}

