import { Router } from 'express';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { readVerificationDiagnostics, readVerificationDiagnosticsByAttempt } from '../controllers/admin-verification-diagnostics.controller.js';
import { verificationDiagnosticsErrorHandler } from '../middleware/verification-diagnostics-error.middleware.js';

/**
 * @swagger
 * components:
 *   schemas:
 *     VerificationDiagnosticTimelineEvent:
 *       type: object
 *       additionalProperties: false
 *       required: [stage, outcome, reason, httpStatus, durationMs, recordedAt]
 *       properties:
 *         stage: { type: string, enum: [started, callback_received, token_validated, education_response, policy_decision, finished] }
 *         outcome: { type: string, enum: [success, failure, unknown] }
 *         reason: { type: string, enum: [none, permission_required, invalid_identity, missing_data, upstream_unavailable, policy_denied, expired, cancelled] }
 *         httpStatus: { type: integer, nullable: true, minimum: 100, maximum: 599 }
 *         durationMs: { type: number, minimum: 0 }
 *         recordedAt: { type: string, format: date-time }
 *     VerificationDiagnosticFailureCategory:
 *       type: object
 *       additionalProperties: false
 *       required: [category, eventCount]
 *       properties:
 *         category: { type: string, enum: [permission_required, invalid_identity, missing_data, upstream_unavailable, policy_denied, expired, cancelled] }
 *         eventCount: { type: integer, minimum: 0 }
 *     VerificationDiagnosticAggregate:
 *       type: object
 *       additionalProperties: false
 *       required: [institutionId, institutionName, finishedAttemptCount, averageFinishedRequestDurationMs, p95FinishedRequestDurationMs, incompleteAttempts, failureCategories]
 *       properties:
 *         institutionId: { type: string, format: uuid, description: Internal configured institution identifier only. }
 *         institutionName: { type: string, minLength: 1, maxLength: 200, description: Configured institution display name; no student, tenant, or provider identity. }
 *         finishedAttemptCount: { type: integer, minimum: 0, description: Distinct attempts with a durable finished event; missing best-effort diagnostics are not inferred. }
 *         averageFinishedRequestDurationMs: { type: number, nullable: true, minimum: 0, description: Mean duration measured for finished requests only; null when no terminal duration was persisted. Stage durations are never summed. }
 *         p95FinishedRequestDurationMs: { type: number, nullable: true, minimum: 0, description: 95th percentile duration measured for finished requests only; null when no terminal duration was persisted. }
 *         incompleteAttempts: { type: integer, minimum: 0, description: Expired starts without a callback; this is not a denial. }
 *         failureCategories:
 *           type: array
 *           items: { $ref: '#/components/schemas/VerificationDiagnosticFailureCategory' }
 *     VerificationDiagnosticOuterAuthenticationError:
 *       type: object
 *       additionalProperties: false
 *       required: [success, error]
 *       properties:
 *         success: { type: boolean, enum: [false] }
 *         error:
 *           type: object
 *           additionalProperties: false
 *           required: [message, code, statusCode]
 *           properties:
 *             message: { type: string, enum: [Authentication failed, Insufficient permissions] }
 *             code: { type: string, enum: [UNAUTHORIZED] }
 *             statusCode: { type: integer, enum: [401] }
 *     VerificationDiagnosticForbiddenError:
 *       type: object
 *       additionalProperties: false
 *       required: [success, error]
 *       properties:
 *         success: { type: boolean, enum: [false] }
 *         error:
 *           type: object
 *           additionalProperties: false
 *           required: [message, code, statusCode]
 *           properties:
 *             message: { type: string, enum: [Current administrator authority required] }
 *             code: { type: string, enum: [FORBIDDEN] }
 *             statusCode: { type: integer, enum: [403] }
 *     VerificationDiagnosticNotFoundError:
 *       type: object
 *       additionalProperties: false
 *       required: [success, error]
 *       properties:
 *         success: { type: boolean, enum: [false] }
 *         error:
 *           type: object
 *           additionalProperties: false
 *           required: [message, code, statusCode]
 *           properties:
 *             message: { type: string, enum: [Verification diagnostic not found] }
 *             code: { type: string, enum: [NOT_FOUND] }
 *             statusCode: { type: integer, enum: [404] }
 *     VerificationDiagnosticInvalidIdentifierError:
 *       type: object
 *       additionalProperties: false
 *       required: [success, error]
 *       properties:
 *         success: { type: boolean, enum: [false] }
 *         error:
 *           type: object
 *           additionalProperties: false
 *           required: [message, code, statusCode]
 *           properties:
 *             message: { type: string, enum: [Invalid verification diagnostic identifier] }
 *             code: { type: string, enum: [VALIDATION_ERROR] }
 *             statusCode: { type: integer, enum: [422] }
 *     VerificationDiagnosticUnavailableError:
 *       type: object
 *       additionalProperties: false
 *       required: [success, error]
 *       properties:
 *         success: { type: boolean, enum: [false] }
 *         error:
 *           type: object
 *           additionalProperties: false
 *           required: [message, code, statusCode]
 *           properties:
 *             message: { type: string, enum: [Verification diagnostics are temporarily unavailable] }
 *             code: { type: string, enum: [INTERNAL_SERVER_ERROR] }
 *             statusCode: { type: integer, enum: [500] }
 * /api/admin/verification-diagnostics/{correlationId}:
 *   get:
 *     summary: Read a redacted Microsoft verification diagnostic timeline
 *     description: Requires a current administrator. Returns fixed-schema events and a fixed 30-day aggregate only; no student, tenant, provider identity, URLs, credentials or raw responses.
 *     tags: [Admin Verification Diagnostics]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: correlationId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       '200':
 *         description: Redacted timeline and safe aggregate counts and latencies.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   additionalProperties: false
 *                   required: [timeline, aggregateWindow, measuredAt, windowStartedAt, aggregates]
 *                   properties:
 *                     timeline:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/VerificationDiagnosticTimelineEvent' }
 *                     aggregateWindow: { type: string, enum: [last_30_days] }
 *                     measuredAt: { type: string, format: date-time }
 *                     windowStartedAt: { type: string, format: date-time }
 *                     aggregates:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/VerificationDiagnosticAggregate' }
 *       '401':
 *         description: Authentication is missing/invalid, or the signed-in role is not admin. This outer middleware envelope is returned before the diagnostic boundary.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/VerificationDiagnosticOuterAuthenticationError' }
 *       '403':
 *         description: The signed-in administrator no longer has current durable authority.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/VerificationDiagnosticForbiddenError' }
 *       '404':
 *         description: The fixed redacted diagnostic is unavailable.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/VerificationDiagnosticNotFoundError' }
 *       '422':
 *         description: The correlation identifier is invalid without echoing its value.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/VerificationDiagnosticInvalidIdentifierError' }
 *       '500':
 *         description: A diagnostic operational failure was sanitized at the route boundary.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/VerificationDiagnosticUnavailableError' }
 */
const router = Router();

// This router is mounted only below admin.routes.ts after its authentication,
// role, and current-admin middleware; do not mount it directly at index.ts.
/**
 * @swagger
 * /api/admin/verification-diagnostics/by-attempt/{attemptId}:
 *   get:
 *     summary: Read a redacted diagnostic timeline by verification attempt
 *     description: Requires a current administrator. Resolves the attempt to its diagnostic correlation and returns the same redacted timeline as the correlation route, with the same access audit.
 *     tags: [Admin Verification Diagnostics]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: attemptId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       '200':
 *         description: Redacted timeline and safe aggregate counts and latencies.
 */
router.get('/by-attempt/:attemptId', asyncHandler(readVerificationDiagnosticsByAttempt));
router.get('/:correlationId', asyncHandler(readVerificationDiagnostics));
// This route boundary never forwards raw diagnostic/provider/database errors
// into the general development error handler, which can include error detail.
router.use(verificationDiagnosticsErrorHandler);

export default router;
