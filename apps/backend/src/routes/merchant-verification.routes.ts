import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../config/database.js';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import { issueMerchantAssertion, exchangeMerchantAssertion } from '../services/verification/merchant-assertion.service.js';
/**
 * @swagger
 * components:
 *   securitySchemes:
 *     merchantServerKey:
 *       type: http
 *       scheme: bearer
 *       description: Private awoof_ reporting server key. Never send this key to a browser. JWTs and public widget keys are not accepted.
 *   schemas:
 *     MerchantVerificationReceipt:
 *       type: object
 *       additionalProperties: false
 *       required: [receiptId, merchantSubject, eligible, assuranceMethod, institutionId, verifiedAt, validUntil, campaignId]
 *       properties:
 *         receiptId: { type: string, format: uuid }
 *         merchantSubject:
 *           type: string
 *           format: uuid
 *           description: Stable pseudonym scoped to this merchant, not an Awoof user ID.
 *         eligible: { type: boolean, enum: [true] }
 *         assuranceMethod: { type: string, enum: [student_email, enrollment] }
 *         institutionId: { type: string, format: uuid }
 *         verifiedAt: { type: string, format: date-time }
 *         validUntil: { type: string, format: date-time }
 *         campaignId: { type: string }
 * /api/merchant-verification/assertions:
 *   post:
 *     summary: Create a short-lived merchant-specific eligibility code
 *     description: Requires current eligibility and current explicit merchant disclosure. Code lifetime is at most two minutes and never exceeds evidence expiry. No payment is created.
 *     tags: [Merchant Verification]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [vendorId, origin, purpose, campaignId, disclosureGrantId]
 *             properties:
 *               vendorId: { type: string, format: uuid }
 *               origin: { type: string, maxLength: 512, description: Exact registered merchant origin including port. HTTPS outside local development. }
 *               purpose: { type: string, minLength: 1, maxLength: 200 }
 *               campaignId: { type: string, minLength: 1, maxLength: 100 }
 *               disclosureGrantId: { type: string, format: uuid }
 *     responses:
 *       '201':
 *         description: Pass this opaque code only to the intended merchant backend; it is not an eligibility receipt.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   required: [code, expiresAt]
 *                   properties:
 *                     code: { type: string, minLength: 43, maxLength: 43 }
 *                     expiresAt: { type: string, format: date-time }
 *       '400': { description: Invalid input or merchant origin }
 *       '401': { description: Student authentication required }
 *       '403': { description: Current eligibility or merchant consent unavailable }
 * /api/merchant-verification/exchange:
 *   post:
 *     summary: Atomically exchange a code for a merchant-scoped eligibility receipt
 *     description: Merchant backend selects the expected campaign. Identical code/campaign/idempotency retries return the immutable committed receipt, including after later consent withdrawal; this is not a new eligibility authorization. Different idempotency reuse conflicts. No payment, pricing or coupon rules are applied by this endpoint.
 *     tags: [Merchant Verification]
 *     security: [{ merchantServerKey: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [code, campaignId, idempotencyKey]
 *             properties:
 *               code: { type: string, pattern: '^[A-Za-z0-9_-]{43}$' }
 *               campaignId: { type: string, minLength: 1, maxLength: 100 }
 *               idempotencyKey: { type: string, minLength: 1, maxLength: 100 }
 *     responses:
 *       '200':
 *         description: Merchant-scoped receipt; no email, matric number or global student ID.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data: { $ref: '#/components/schemas/MerchantVerificationReceipt' }
 *       '400': { description: Invalid input, code or campaign mismatch }
 *       '401': { description: Private merchant key invalid or merchant inactive }
 *       '403': { description: Eligibility or disclosure no longer current }
 *       '409': { description: Code expired, consumed by another operation or conflicting idempotency key }
 *       '429': { description: Merchant key hourly quota exhausted or key unavailable }
 */
const bounded = z.string().trim().min(1).max(100);
const issuance = z.object({ vendorId:z.string().uuid(), origin:z.string().max(512),
    purpose:z.string().min(1).max(200), campaignId:bounded, disclosureGrantId:z.string().uuid() }).strict();
const exchange = z.object({ code:z.string().regex(/^[A-Za-z0-9_-]{43}$/), campaignId:bounded,
    idempotencyKey:bounded }).strict();
const router = Router();
router.post('/assertions', authenticate, requireRole('student'), asyncHandler(async (req,res) => {
    const data = await issueMerchantAssertion(getPool(), req.user!.id, issuance.parse(req.body));
    res.status(201).json({ success:true, data });
}));
router.post('/exchange', asyncHandler(async (req,res) => {
    const header = req.headers.authorization;
    const key = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    const data = await exchangeMerchantAssertion(getPool(),key,exchange.parse(req.body));
    res.json({ success:true, data });
}));
export default router;
