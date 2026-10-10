/**
 * Student Academic Profile Routes
 *
 * Isolated student-owned academic details. Reads and writes bind strictly to
 * the authenticated student; the path carries no student id and the body must
 * not contain one.
 */

import { Router } from 'express';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import { StudentAcademicProfileController } from '../controllers/student-academic-profile.controller.js';

export function createStudentAcademicProfileRouter(
    controller: StudentAcademicProfileController = new StudentAcademicProfileController(),
): Router {
    const router = Router();

    /**
     * @route   GET /api/students/academic-profile
     * @desc    Get the authenticated student's academic profile projection
     * @access  Private (Student only)
     */
    router.get(
        '/academic-profile',
        authenticate,
        requireRole('student'),
        asyncHandler(controller.getAcademicProfile.bind(controller)),
    );

    /**
     * @route   PUT /api/students/academic-profile
     * @desc    Save the authenticated student's academic profile patch
     * @access  Private (Student only)
     */
    router.put(
        '/academic-profile',
        authenticate,
        requireRole('student'),
        asyncHandler(controller.updateAcademicProfile.bind(controller)),
    );

    return router;
}

export default createStudentAcademicProfileRouter();

/**
 * @swagger
 * /api/students/academic-profile:
 *   get:
 *     summary: Read the authenticated student's academic profile
 *     description: Returns saved academic details, the effective institution label, current assurance or an unavailable discriminator, and the server-computed prompt decision. Completing this profile never verifies enrollment or changes eligibility. Available to the owning student while collection is disabled.
 *     tags: [Students]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Academic profile projection for the authenticated student
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AcademicProfileProjectionResponse' } } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/BadRequest' }
 *   put:
 *     summary: Save the authenticated student's academic profile patch
 *     description: Commits a validated partial update with optimistic revisioning and returns the recalculated projection. Rejected while collection is disabled. Accepted estimates are recomputed server-side; the browser cannot set calculation origin, rule references, or provenance.
 *     tags: [Students]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AcademicProfileInput' }
 *     responses:
 *       200:
 *         description: Committed profile revision with the recalculated projection
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AcademicProfileProjectionResponse' } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/BadRequest' }
 *       409:
 *         description: Stale revision or institution drift; reload before retrying
 *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
 *       422: { $ref: '#/components/responses/BadRequest' }
 */
