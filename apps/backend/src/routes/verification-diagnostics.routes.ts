import { Router } from 'express';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { readVerificationDiagnostics } from '../controllers/admin-verification-diagnostics.controller.js';

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
 *       '401': { description: Authentication required }
 *       '403': { description: Current administrator authority required }
 *       '404': { description: Verification diagnostic not found }
 *       '422': { description: Invalid correlation identifier }
 */
const router = Router();

// This router is mounted only below admin.routes.ts after its authentication,
// role, and current-admin middleware; do not mount it directly at index.ts.
router.get('/:correlationId', asyncHandler(readVerificationDiagnostics));

export default router;
