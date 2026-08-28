/**
 * Checkout Routes — marketplace purchase flow.
 */

import { Router } from 'express';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import { checkoutController } from '../controllers/checkout.controller.js';

const router = Router();

router.post(
    '/',
    authenticate,
    requireRole('student'),
    asyncHandler(checkoutController.createCheckout.bind(checkoutController))
);

router.get(
    '/:transactionId',
    authenticate,
    requireRole('student'),
    asyncHandler(checkoutController.getCheckoutStatus.bind(checkoutController))
);

export default router;
