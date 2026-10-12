/**
 * Student Academic Profile Routes
 *
 * Isolated student-owned academic details. Reads and writes bind strictly to
 * the authenticated student; the path carries no student id and the body must
 * not contain one.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import { StudentAcademicProfileController } from '../controllers/student-academic-profile.controller.js';

/**
 * Catalogue paths that skip the shared global IP-keyed limiter so one NAT
 * address cannot exhaust a shared budget before the student quota matters.
 * They are still quota-bound: the pre-authentication flood ceiling below
 * caps unauthenticated traffic per IP, and the per-student limiter remains
 * the effective quota for authenticated use.
 */
export function isAcademicCataloguePath(method: string, path: string): boolean {
    const normalizedPath = path.toLowerCase();
    if (method === 'GET') {
        return normalizedPath === '/api/students/academic-profile/institutions'
            || normalizedPath === '/api/students/academic-profile/programmes';
    }
    if (method === 'POST') {
        return normalizedPath === '/api/students/academic-profile/estimate';
    }
    return false;
}

export type AcademicProfileRouterOptions = {
    /** Test-only override for the pre-auth flood ceiling (production: 1000). */
    floodCeilingMax?: number;
};

export function createStudentAcademicProfileRouter(
    controller: StudentAcademicProfileController = new StudentAcademicProfileController(),
    options: AcademicProfileRouterOptions = {},
): Router {
    const router = Router();
    // Catalogue and estimate endpoints are suggestion-only and typeahead-hot.
    // Two limiters with two jobs (mirroring the Microsoft flood-ceiling
    // precedent in microsoft-verification.routes.ts):
    // - catalogueFloodCeiling (first): per-IP abuse backstop ahead of
    //   authentication. These paths skip the global limiter, and
    //   unauthenticated traffic never reaches the per-student limiter, so
    //   without this ceiling invalid-token floods would hit JWT processing
    //   unbounded. Successful responses never consume it, so legitimate
    //   bursts behind one NAT pass while only failures accumulate.
    // - catalogueLimiter (after auth): per-student quota, so students
    //   behind one NAT address never spend each other's typeahead budget.
    const catalogueFloodCeiling = rateLimit({
        windowMs: 10 * 60 * 1000,
        max: options.floodCeilingMax ?? 1000,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
    });
    const catalogueLimiter = rateLimit({
        windowMs: 60_000,
        max: 120,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
    });

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

    /**
     * @route   GET /api/students/academic-profile/institutions
     * @desc    Search the institution catalogue scoped to the authenticated student
     * @access  Private (Student only)
     */
    router.get(
        '/academic-profile/institutions',
        catalogueFloodCeiling,
        authenticate,
        requireRole('student'),
        catalogueLimiter,
        asyncHandler(controller.searchAcademicInstitutions.bind(controller)),
    );

    /**
     * @route   GET /api/students/academic-profile/programmes
     * @desc    Search the reviewed programme catalogue scoped to the authenticated student
     * @access  Private (Student only)
     */
    router.get(
        '/academic-profile/programmes',
        catalogueFloodCeiling,
        authenticate,
        requireRole('student'),
        catalogueLimiter,
        asyncHandler(controller.searchAcademicProgrammes.bind(controller)),
    );

    /**
     * @route   POST /api/students/academic-profile/estimate
     * @desc    Compute an advisory graduation-year estimate without persisting it
     * @access  Private (Student only)
     */
    router.post(
        '/academic-profile/estimate',
        catalogueFloodCeiling,
        authenticate,
        requireRole('student'),
        catalogueLimiter,
        asyncHandler(controller.estimateAcademicGraduationYear.bind(controller)),
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
 *       403: { $ref: '#/components/responses/Unauthorized' }
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
 *         description: Stale revision, institution drift, or a changed school claim; reload and reconfirm before retrying
 *         content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }
 *       422: { $ref: '#/components/responses/BadRequest' }
 * /api/students/academic-profile/institutions:
 *   get:
 *     summary: Search the institution catalogue for the authenticated student
 *     description: Bounded, paginated catalogue search scoped to the locked server-side student context. Bound students see their server-bound institution; unbound students search the general active catalogue. Catalogue membership is not a supported-institution claim. Rejected while collection is disabled.
 *     tags: [Students]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: q, in: query, schema: { type: string, maxLength: 128 }, description: 'Case-insensitive name filter.' }
 *       - { name: cursor, in: query, schema: { type: string, maxLength: 512 }, description: 'Opaque page cursor from a previous response.' }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *     responses:
 *       200:
 *         description: Institution catalogue page with display fields only
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AcademicProfileInstitutionCataloguePage' } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Unauthorized' }
 *       422: { $ref: '#/components/responses/BadRequest' }
 *       429: { description: Suggestion quota exhausted for this student; retry after the window resets }
 * /api/students/academic-profile/programmes:
 *   get:
 *     summary: Search the reviewed programme catalogue for the authenticated student
 *     description: Bounded, paginated search over the reviewed programme reference, scoped to the bound institution's national slice when one resolves. Suggestions are programme names, not a confirmed list of courses offered by an institution. Rejected while collection is disabled.
 *     tags: [Students]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: q, in: query, schema: { type: string, maxLength: 128 }, description: 'Case-insensitive label, alias, or id filter.' }
 *       - { name: cursor, in: query, schema: { type: string, maxLength: 512 }, description: 'Opaque page cursor from a previous response.' }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *     responses:
 *       200:
 *         description: Programme catalogue page with display fields only
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AcademicProfileProgrammeCataloguePage' } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Unauthorized' }
 *       422: { $ref: '#/components/responses/BadRequest' }
 *       429: { description: Suggestion quota exhausted for this student; retry after the window resets }
 * /api/students/academic-profile/estimate:
 *   post:
 *     summary: Compute an advisory graduation-year estimate
 *     description: Computes from reviewed route rules only and never persists the result. Unreviewed, conflicting, or cross-country inputs return a reasoned unavailable outcome. Unbound previews narrow by the draft claim when supplied, else by the stored claim. Rejected while collection is disabled.
 *     tags: [Students]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/AcademicProfileEstimateInput' }
 *     responses:
 *       200:
 *         description: Available estimate or reasoned unavailable outcome
 *         content: { application/json: { schema: { $ref: '#/components/schemas/AcademicProfileEstimateResult' } } }
 *       400: { $ref: '#/components/responses/BadRequest' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/BadRequest' }
 *       422: { $ref: '#/components/responses/BadRequest' }
 *       429: { description: Suggestion quota exhausted for this student; retry after the window resets }
 */
