/**
 * University Routes
 * 
 * Handles university listing and verification methods
 */

import { Router } from 'express';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { UniversityController } from '../controllers/university.controller.js';

const router = Router();
const universityController = new UniversityController();

/**
 * @route   GET /api/universities
 * @desc    List all active universities
 * @access  Public
 */
router.get(
    '/',
    asyncHandler(universityController.listUniversities.bind(universityController))
);

/**
 * @route   GET /api/universities/:id/verification-methods
 * @desc    Retired (410); use /api/verification/methods/:universityId
 * @access  Public
 */
router.get(
    '/:id/verification-methods',
    asyncHandler(universityController.getVerificationMethods.bind(universityController))
);

export default router;

