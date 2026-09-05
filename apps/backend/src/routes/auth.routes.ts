/**
 * Authentication Routes
 * 
 * Handles user registration, login, and token refresh
 */

import { Router } from 'express';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { AuthController } from '../controllers/auth.controller.js';

export function createAuthRouter(authController: AuthController = new AuthController()): Router {
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
 * @desc    Logout user (invalidate refresh token)
 * @access  Private
 */
router.post(
    '/logout',
    authenticate,
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

    return router;
}

export default createAuthRouter();
