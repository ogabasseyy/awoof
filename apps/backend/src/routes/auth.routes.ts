/**
 * Authentication Routes
 * 
 * Handles user registration, login, and token refresh
 */

import { Router } from 'express';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { AuthController } from '../controllers/auth.controller.js';
import { BadRequestError } from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import { getPool } from '../config/database.js';
import { config } from '../config/env.js';
import { getRedisClient } from '../config/redis.js';
import { enabledStudentSsoProviders } from '../services/auth/student-oidc.config.js';
import {
    checkDiscoveryQuota,
    createRedisQuotaStore,
    normalizeStudentLoginEmail,
    resolveStudentLoginOptions,
} from '../services/auth/student-login-options.service.js';
import type { LoginOptions } from '../services/auth/student-sso.types.js';

export type StudentLoginOptionsDependencies = {
    resolveLoginOptions: (email: unknown) => Promise<LoginOptions>;
    checkQuota: (clientIp: string) => Promise<void>;
};

function defaultStudentLoginOptions(): StudentLoginOptionsDependencies {
    // Pools open per request only; mounting the router never connects.
    return {
        resolveLoginOptions: (email) => resolveStudentLoginOptions(
            (text, params) => getPool().query(text, params),
            { email, enabledProviders: enabledStudentSsoProviders(config.studentSso) },
        ),
        checkQuota: (clientIp) => checkDiscoveryQuota(createRedisQuotaStore(getRedisClient()), clientIp),
    };
}

function readLoginOptionsEmail(body: unknown): string {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestError('Invalid email address');
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== 'email') throw new BadRequestError('Invalid email address');
    return normalizeStudentLoginEmail((body as { email: unknown }).email);
}

export function createAuthRouter(
    authController: AuthController = new AuthController(),
    loginOptions: StudentLoginOptionsDependencies = defaultStudentLoginOptions(),
): Router {
    const router = Router();

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *               - role
 *               - name
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: student@example.com
 *               password:
 *                 type: string
 *                 minLength: 8
 *                 example: SecurePass123!
 *               role:
 *                 type: string
 *                 enum: [student, vendor]
 *                 example: student
 *               name:
 *                 type: string
 *                 minLength: 2
 *                 example: John Doe
 *     responses:
 *       201:
 *         description: User registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         user:
 *                           $ref: '#/components/schemas/User'
 *                         tokens:
 *                           $ref: '#/components/schemas/Tokens'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       409:
 *         description: User already exists
 */
router.post(
    '/register',
    asyncHandler(authController.register.bind(authController))
);

/**
 * @route   POST /api/auth/login
 * @desc    Login user and get tokens
 * @access  Public
 */
router.post(
    '/login',
    asyncHandler(authController.login.bind(authController))
);

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token
 * @access  Public (but requires refresh token)
 */
router.post(
    '/refresh',
    asyncHandler(authController.refreshToken.bind(authController))
);

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user (invalidate the matching refresh token)
 * @access  Requires a valid refreshToken in the JSON body
 */
router.post(
    '/logout',
    asyncHandler(authController.logout.bind(authController))
);

/**
 * @route   GET /api/auth/me
 * @desc    Get current user
 * @access  Private
 */
router.get(
    '/me',
    authenticate,
    asyncHandler(authController.getCurrentUser.bind(authController))
);

/**
 * @route   POST /api/auth/forgot-password
 * @desc    Send OTP for password reset
 * @access  Public
 */
router.post(
    '/forgot-password',
    asyncHandler(authController.forgotPassword.bind(authController))
);

/**
 * @route   POST /api/auth/verify-reset-otp
 * @desc    Verify OTP for password reset
 * @access  Public
 */
router.post(
    '/verify-reset-otp',
    asyncHandler(authController.verifyResetOTP.bind(authController))
);

/**
 * @route   POST /api/auth/reset-password
 * @desc    Reset password with OTP
 * @access  Public
 */
router.post(
    '/reset-password',
    asyncHandler(authController.resetPassword.bind(authController))
);

/**
 * @route   POST /api/auth/update-password
 * @desc    Update password (requires old password)
 * @access  Private
 */
router.post(
    '/update-password',
    authenticate,
    asyncHandler(authController.updatePassword.bind(authController))
);

/**
 * @route   POST /api/auth/verify-email
 * @desc    Verify email with OTP (for vendor registration)
 * @access  Public
 */
router.post(
    '/verify-email',
    asyncHandler(authController.verifyEmail.bind(authController))
);

/**
 * @route   POST /api/auth/resend-email-verification
 * @desc    Resend email verification OTP
 * @access  Public
 */
router.post(
    '/resend-email-verification',
    asyncHandler(authController.resendEmailVerification.bind(authController))
);

/**
 * @route   POST /api/auth/verify-student-email
 * @desc    Check approved student-domain support and return the current processing notice; does not verify mailbox ownership
 * @access  Public
 */
router.post(
    '/verify-student-email',
    asyncHandler(authController.verifyStudentEmail.bind(authController))
);

/**
 * @route   POST /api/auth/student/register-request
 * @desc    Request a proof-bound signup OTP; no user is created until confirmation succeeds
 * @access  Public
 */
router.post(
    '/student/register-request',
    asyncHandler(authController.studentRegisterRequest.bind(authController))
);

/**
 * @route   POST /api/auth/student/register-confirm
 * @desc    Confirm the bound OTP and atomically create a new student account with eligibility evidence
 * @access  Public
 */
router.post(
    '/student/register-confirm',
    asyncHandler(authController.studentRegisterConfirm.bind(authController))
);

/**
 * @route   POST /api/auth/student/login-options
 * @desc    Resolve approved login methods for an email domain without revealing account existence
 * @access  Public
 */
router.post(
    '/student/login-options',
    asyncHandler(async (req, res) => {
        // Discovery responses are per-domain and privacy-sensitive: never cache.
        // The request body is never logged; the shared logger records method and path only.
        res.setHeader('Cache-Control', 'no-store');
        // Malformed input is a deterministic 400: validation runs before the
        // quota check so outages cannot mask it, and quota failures never
        // reach discovery.
        const email = readLoginOptionsEmail(req.body);
        const clientIp = typeof req.ip === 'string' && req.ip !== '' ? req.ip : 'unknown';
        await loginOptions.checkQuota(clientIp);
        success(res, { data: await loginOptions.resolveLoginOptions(email) });
    })
);

    return router;
}

export default createAuthRouter();
