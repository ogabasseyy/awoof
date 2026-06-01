/**
 * Admin Routes
 * 
 * Handles admin-only endpoints
 */

import { Router } from 'express';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { requireRole } from '../middleware/auth.middleware.js';
import { adminController } from '../controllers/admin.controller.js';
import { adminUniversityController } from '../controllers/admin-university.controller.js';
import { adminStudentController } from '../controllers/admin-student.controller.js';
import { adminVendorController } from '../controllers/admin-vendor.controller.js';
import { adminAnalyticsController } from '../controllers/admin-analytics.controller.js';
import { getPlatformSettings, updatePlatformSettings } from '../controllers/admin-platform-settings.controller.js';
import { csvUpload } from '../config/upload.js';

const router = Router();

// All admin routes require authentication and admin role
router.use(authenticate);
router.use(requireRole('admin'));

// Admin universities - order matters: segment-stats and csv-sample before :id
router.get('/universities', asyncHandler(adminUniversityController.getUniversities.bind(adminUniversityController)));
router.get('/universities/segment-stats', asyncHandler(adminUniversityController.getSegmentStats.bind(adminUniversityController)));
router.get('/universities/csv-sample', asyncHandler(adminUniversityController.getCsvSample.bind(adminUniversityController)));
router.post('/universities/import-csv', csvUpload.single('file'), asyncHandler(adminUniversityController.importCsv.bind(adminUniversityController)));
router.get('/universities/:id', asyncHandler(adminUniversityController.getUniversity.bind(adminUniversityController)));
router.post('/universities', asyncHandler(adminUniversityController.createUniversity.bind(adminUniversityController)));
router.put('/universities/:id', asyncHandler(adminUniversityController.updateUniversity.bind(adminUniversityController)));
router.delete('/universities/:id', asyncHandler(adminUniversityController.deleteUniversity.bind(adminUniversityController)));

router.get('/students', asyncHandler(adminStudentController.getStudents.bind(adminStudentController)));
router.get('/vendors', asyncHandler(adminVendorController.getVendors.bind(adminVendorController)));
router.get('/analytics', asyncHandler(adminAnalyticsController.getAnalytics.bind(adminAnalyticsController)));

/**
 * @route   GET /api/admin/settings/platform
 * @desc    Get platform settings (e.g. platform fee %)
 * @access  Admin
 */
router.get('/settings/platform', asyncHandler(getPlatformSettings));

/**
 * @route   PUT /api/admin/settings/platform
 * @desc    Update platform settings
 * @access  Admin
 */
router.put('/settings/platform', asyncHandler(updatePlatformSettings));

/**
 * @route   GET /api/admin/categories
 * @desc    Get all categories (admin view)
 * @access  Admin
 */
router.get(
    '/categories',
    asyncHandler(adminController.getCategories.bind(adminController))
);

/**
 * @route   GET /api/admin/categories/:id
 * @desc    Get a single category by ID
 * @access  Admin
 */
router.get(
    '/categories/:id',
    asyncHandler(adminController.getCategory.bind(adminController))
);

/**
 * @route   POST /api/admin/categories
 * @desc    Create a new category
 * @access  Admin
 */
router.post(
    '/categories',
    asyncHandler(adminController.createCategory.bind(adminController))
);

/**
 * @route   PUT /api/admin/categories/:id
 * @desc    Update a category
 * @access  Admin
 */
router.put(
    '/categories/:id',
    asyncHandler(adminController.updateCategory.bind(adminController))
);

/**
 * @route   DELETE /api/admin/categories/:id
 * @desc    Delete a category
 * @access  Admin
 */
router.delete(
    '/categories/:id',
    asyncHandler(adminController.deleteCategory.bind(adminController))
);

export default router;


