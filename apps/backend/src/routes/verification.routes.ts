import { Router } from 'express';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { VerificationController } from '../controllers/verification.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';

export function createVerificationRouter(controller: VerificationController = new VerificationController()): Router {
    const router = Router();

    // Availability is public; it makes no account, eligibility, or identity claim.
    router.get('/methods/:universityId', asyncHandler(controller.getVerificationMethods.bind(controller)));

    router.post('/initiate', authenticate, asyncHandler(controller.initiateVerification.bind(controller)));
    router.post('/email/request', authenticate, asyncHandler(controller.requestEmailVerification.bind(controller)));
    router.post('/email/confirm', authenticate, asyncHandler(controller.confirmEmailVerification.bind(controller)));
    router.get('/status', authenticate, asyncHandler(controller.getCurrentStatus.bind(controller)));
    router.post('/disclosures', authenticate, asyncHandler(controller.grantMerchantDisclosure.bind(controller)));
    router.delete('/consents/:id', authenticate, asyncHandler(controller.withdrawConsent.bind(controller)));

    // Task 2 owns the only registration adapter. Authentication prevents the
    // public account-creation bypass while this honest-unavailable response is mounted.
    router.post('/registration', authenticate, asyncHandler(controller.registrationUnavailable.bind(controller)));

    // Permanently retired public identity-grant routes. These handlers never
    // read the caller body, token, query string, or requested student ID.
    router.post('/email', asyncHandler(controller.retiredLegacyRoute.bind(controller)));
    router.get('/email/verify', asyncHandler(controller.retiredLegacyRoute.bind(controller)));
    router.post('/whatsapp/request', asyncHandler(controller.retiredLegacyRoute.bind(controller)));
    router.post('/whatsapp/verify', asyncHandler(controller.retiredLegacyRoute.bind(controller)));
    router.get('/status/:studentId', asyncHandler(controller.retiredLegacyRoute.bind(controller)));

    router.post('/widget/token', authenticate, asyncHandler(controller.widgetUnavailable.bind(controller)));

    return router;
}

export default createVerificationRouter();
