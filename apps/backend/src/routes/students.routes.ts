/**
 * Student Routes
 * 
 * Handles student profile and verification endpoints
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { authenticate, requireRole, type AuthRequest } from '../middleware/auth.middleware.js';
import { StudentController } from '../controllers/student.controller.js';

const router = Router();
const studentController = new StudentController();

/**
 * @route   GET /api/students/profile
 * @desc    Get current student profile
 * @access  Private (Student only)
 */
router.get(
    '/profile',
    authenticate,
    requireRole('student'),
    asyncHandler(studentController.getProfile.bind(studentController))
);

/**
 * @route   PUT /api/students/profile
 * @desc    Update student profile
 * @access  Private (Student only)
 */
router.put(
    '/profile',
    authenticate,
    requireRole('student'),
    asyncHandler(studentController.updateProfile.bind(studentController))
);

/**
 * @route   DELETE /api/students/account
 * @desc    Close the caller's own student account (soft delete; sessions revoked)
 * @access  Private (Student only)
 */
// Failed closure proofs are budgeted per account, not per IP: a stolen
// access token must not turn this endpoint into an unbounded offline
// password oracle (each attempt also pays a bcrypt comparison under the
// user row lock). Successful closures do not consume the budget.
const accountClosureProofLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    // Only an actual proof failure (401) consumes the budget: retention
    // outages (503), already-closed conflicts (409), and limiter responses
    // must not burn a student's attempts.
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    keyGenerator: (req) => {
        const userId = (req as AuthRequest).user?.userId;
        return userId ? `account:${userId}` : `ip:${req.ip ?? 'unknown'}`;
    },
});

router.delete(
    '/account',
    authenticate,
    requireRole('student'),
    accountClosureProofLimiter,
    asyncHandler(studentController.closeAccount.bind(studentController))
);

/**
 * @route   GET /api/students/purchases
 * @desc    Get student purchase history
 * @access  Private (Student only)
 */
router.get(
    '/purchases',
    authenticate,
    requireRole('student'),
    asyncHandler(studentController.getPurchases.bind(studentController))
);

/**
 * @route   GET /api/students/savings
 * @desc    Get student savings statistics
 * @access  Private (Student only)
 */
router.get(
    '/savings',
    authenticate,
    requireRole('student'),
    asyncHandler(studentController.getSavings.bind(studentController))
);

// Import additional controllers
import { notificationController } from '../controllers/notification.controller.js';
import { WebsiteVisitController } from '../controllers/website-visit.controller.js';
import { ticketController } from '../controllers/ticket.controller.js';

const websiteVisitController = new WebsiteVisitController();

/**
 * @route   GET /api/students/notifications
 * @desc    Get student notifications (alias of /api/support/notifications)
 * @access  Private (Student only)
 */
router.get(
    '/notifications',
    authenticate,
    requireRole('student'),
    asyncHandler(notificationController.list.bind(notificationController))
);

/**
 * @route   PUT /api/students/notifications/read
 * @desc    Mark notifications as read
 * @access  Private (Student only)
 */
router.put(
    '/notifications/read',
    authenticate,
    requireRole('student'),
    asyncHandler(notificationController.markRead.bind(notificationController))
);

/**
 * @route   DELETE /api/students/notifications/:id
 * @desc    Delete a notification
 * @access  Private (Student only)
 */
router.delete(
    '/notifications/:id',
    authenticate,
    requireRole('student'),
    asyncHandler(notificationController.remove.bind(notificationController))
);

/**
 * @route   POST /api/students/website-visits
 * @desc    Track a website visit
 * @access  Private (Student only)
 */
router.post(
    '/website-visits',
    authenticate,
    requireRole('student'),
    asyncHandler(websiteVisitController.trackVisit.bind(websiteVisitController))
);

/**
 * @route   GET /api/students/website-visits
 * @desc    Get website visits history
 * @access  Private (Student only)
 */
router.get(
    '/website-visits',
    authenticate,
    requireRole('student'),
    asyncHandler(websiteVisitController.getVisits.bind(websiteVisitController))
);

/**
 * Support tickets (aliases → unified ticket controller)
 */
router.post(
    '/support-tickets',
    authenticate,
    requireRole('student'),
    asyncHandler(ticketController.create.bind(ticketController))
);

router.get(
    '/support-tickets',
    authenticate,
    requireRole('student'),
    asyncHandler(ticketController.listOwn.bind(ticketController))
);

router.get(
    '/support-tickets/:id',
    authenticate,
    requireRole('student'),
    asyncHandler(ticketController.getOwn.bind(ticketController))
);

router.post(
    '/support-tickets/:id/responses',
    authenticate,
    requireRole('student'),
    asyncHandler(ticketController.replyOwn.bind(ticketController))
);

router.post(
    '/support-tickets/:id/messages',
    authenticate,
    requireRole('student'),
    asyncHandler(ticketController.replyOwn.bind(ticketController))
);

export default router;

