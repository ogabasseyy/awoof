import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { getPool } from '../config/database.js';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import { issueMerchantAssertion, exchangeMerchantAssertion } from '../services/verification/merchant-assertion.service.js';
import {
    claimProductBenefit,
    createMerchantClaimSession,
    readMerchantClaimSession,
    type ClaimSessionInput,
    type ClaimSessionPublic,
    type ClaimSessionResult,
    type ProductClaimInput,
    type ProductClaimResult,
} from '../services/verification/product-claim.service.js';
/**
 * @swagger
 * components:
 *   securitySchemes:
 *     merchantServerKey:
 *       type: http
 *       scheme: Bearer [REDACTED]
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
 *         benefitAuthorizationId:
 *           type: string
 *           format: uuid
 *           description: Present only for product-bound exchanges. Authorizes one discounted transaction report for the bound product; generic campaign receipts never carry it.
 * /api/merchant-verification/assertions:
 *   post:
 *     summary: Create a short-lived merchant-specific eligibility code
 *     description: Requires current eligibility and current explicit merchant disclosure. Code lifetime is at most two minutes and never exceeds evidence expiry. No payment is created. Pass productId to bind the code to one active product of this vendor; exchanging a product-bound code mints a single-transaction benefit authorization.
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
 *               productId: { type: string, format: uuid, description: Optional active product of this vendor. When present, the exchange receipt carries a benefitAuthorizationId for one discounted transaction report. }
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
 *     description: Merchant backend selects the expected campaign. Identical code/campaign/idempotency retries return the immutable committed receipt, including after later consent withdrawal; this is not a new eligibility authorization and mints no new benefit authorization. Product-bound codes add a benefitAuthorizationId for one discounted transaction report. Different idempotency reuse conflicts. Codes minted through a protected product claim additionally require the merchant's browser nonce and checkout binding from its own cookie-derived server state; the claim session is consumed once atomically. No payment, pricing or coupon rules are applied by this endpoint.
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
 *               browserNonce: { type: string, minLength: 16, maxLength: 512, description: Required only for claim-bound codes. The merchant's cookie-derived browser nonce, sent over its authenticated server connection; never place it in a URL. }
 *               merchantCheckoutId: { type: string, minLength: 1, maxLength: 100, description: Required only for claim-bound codes. Must match the checkout the claim session was created for. }
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
 * /api/merchant-verification/claim-sessions:
 *   post:
 *     summary: Create a merchant claim session binding one checkout to one product
 *     description: Merchant server-to-server bootstrap. The merchant sets its own Secure HttpOnly browser nonce cookie, creates this session with the nonce hash, then navigates the browser to Awoof's claim page. Sessions expire after ten minutes and are consumed once at exchange. Exact creation retries return the same session; changed product or nonce bindings conflict. Never put the nonce in a URL.
 *     tags: [Merchant Verification]
 *     security: [{ merchantServerKey: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [productId, merchantCheckoutId, browserNonceHash]
 *             properties:
 *               productId: { type: string, format: uuid, description: Active product of the calling merchant. }
 *               merchantCheckoutId: { type: string, minLength: 1, maxLength: 100, description: Merchant checkout reference. Unique per merchant; one redemption per checkout. }
 *               browserNonceHash: { type: string, pattern: '^[0-9a-f]{64}$', description: Hex SHA-256 of the merchant's browser nonce. }
 *     responses:
 *       '201': { description: Claim session created. }
 *       '200': { description: Exact creation retry; returns the same live session. }
 *       '400': { description: Invalid input or product unavailable to this merchant. }
 *       '401': { description: Private merchant key invalid or merchant inactive. }
 *       '409': { description: Checkout already bound differently, used, or expired. Start a new checkout. }
 * /api/merchant-verification/claim-sessions/{id}:
 *   get:
 *     summary: Read the public projection of one claim session
 *     description: Signed-in students only. Returns the vendor, product, advertised prices and registered handoff origin needed to review and consent to a protected claim. Never contains nonce hashes, codes, or handoff URLs.
 *     tags: [Merchant Verification]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       '200': { description: Public claim-session projection. }
 *       '401': { description: Student authentication required. }
 *       '404': { description: Unknown session or claim no longer available. }
 *       '409': { description: Session expired or redeemed, or merchant integration unavailable. }
 * /api/merchant-verification/product-claims:
 *   post:
 *     summary: Claim a protected product discount for one merchant checkout
 *     description: Signed-in students only. Resolves vendor, product, registered origin and campaign from the claim session and disclosure grant; no vendor, origin or product input is accepted. Requires current enrollment evidence and current merchant disclosure at commit time. Returns an opaque short-lived assertion plus the validated merchant handoff destination; the merchant exchanges the assertion from its backend. Without a deployed merchant integration the claim fails with MERCHANT_INTEGRATION_REQUIRED and only ordinary public merchant navigation remains.
 *     tags: [Merchant Verification]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [merchantClaimSessionId, disclosureGrantId]
 *             properties:
 *               merchantClaimSessionId: { type: string, format: uuid }
 *               disclosureGrantId: { type: string, format: uuid }
 *     responses:
 *       '201':
 *         description: Opaque assertion plus validated merchant handoff destination. No-store; never log or share the handoff URL.
 *         headers:
 *           Cache-Control: { schema: { type: string, enum: [no-store] } }
 *           Referrer-Policy: { schema: { type: string, enum: [no-referrer] } }
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   required: [code, expiresAt, handoffUrl]
 *                   properties:
 *                     code: { type: string, minLength: 43, maxLength: 43 }
 *                     expiresAt: { type: string, format: date-time }
 *                     handoffUrl: { type: string, description: Registered merchant origin plus the fixed /awoof/student-claim path with only the opaque assertion. }
 *       '400': { description: Product no longer available. }
 *       '401': { description: Student authentication required. }
 *       '403': { description: Current enrollment or merchant disclosure unavailable. }
 *       '404': { description: Unknown claim session or disclosure grant. }
 *       '409': { description: Session expired or redeemed, or MERCHANT_INTEGRATION_REQUIRED. }
 */
const bounded = z.string().trim().min(1).max(100);
const issuance = z.object({ vendorId:z.string().uuid(), origin:z.string().max(512),
    purpose:z.string().min(1).max(200), campaignId:bounded, disclosureGrantId:z.string().uuid(),
    productId:z.string().uuid().optional() }).strict();
const exchange = z.object({ code:z.string().regex(/^[A-Za-z0-9_-]{43}$/), campaignId:bounded,
    idempotencyKey:bounded, browserNonce:z.string().min(16).max(512).optional(),
    merchantCheckoutId:bounded.optional() }).strict();
const claimSessionCreation = z.object({ productId:z.string().uuid(), merchantCheckoutId:bounded,
    browserNonceHash:z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const productClaim = z.object({ merchantClaimSessionId:z.string().uuid(),
    disclosureGrantId:z.string().uuid() }).strict();
const sessionIdParam = z.object({ id:z.string().uuid() }).strict();

export type IssueAssertion = (userId: string, input: {
    vendorId: string; origin: string; purpose: string; campaignId: string;
    disclosureGrantId: string; productId?: string;
}) => Promise<{ code: string; expiresAt: string }>;
export type ExchangeAssertion = (merchantKey: string, input: {
    code: string; campaignId: string; idempotencyKey: string;
    browserNonce?: string | undefined; merchantCheckoutId?: string | undefined;
}) => Promise<{
    receiptId: string; merchantSubject: string; eligible: true; assuranceMethod: string;
    institutionId: string; verifiedAt: string; validUntil: string; campaignId: string;
    benefitAuthorizationId?: string;
}>;
export type CreateClaimSession = (merchantKey: string, input: ClaimSessionInput) => Promise<ClaimSessionResult>;
export type ReadClaimSession = (sessionId: string) => Promise<ClaimSessionPublic>;
export type ClaimProduct = (userId: string, input: ProductClaimInput) => Promise<ProductClaimResult>;

export type MerchantVerificationRouterDeps = {
    pool?: Pool;
    issue?: IssueAssertion;
    exchange?: ExchangeAssertion;
    createClaimSession?: CreateClaimSession;
    readClaimSession?: ReadClaimSession;
    claimProduct?: ClaimProduct;
};

function merchantKeyFrom(req: { headers: { authorization?: unknown } }): string {
    const header = req.headers.authorization;
    return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
}

export function createMerchantVerificationRouter(deps: MerchantVerificationRouterDeps = {}): Router {
    const router = Router();
    const pool = (): Pool => deps.pool ?? getPool();
    const issue: IssueAssertion = deps.issue ?? ((userId, input) => issueMerchantAssertion(pool(), userId, input));
    const exchangeAssertion: ExchangeAssertion = deps.exchange ?? ((key, input) => exchangeMerchantAssertion(pool(), key, input));
    const createSession: CreateClaimSession = deps.createClaimSession
        ?? ((key, input) => createMerchantClaimSession(pool(), key, input));
    const readSession: ReadClaimSession = deps.readClaimSession
        ?? ((sessionId) => readMerchantClaimSession(pool(), sessionId));
    const claim: ClaimProduct = deps.claimProduct
        ?? ((userId, input) => claimProductBenefit(pool(), userId, input));

    router.post('/assertions', authenticate, requireRole('student'), asyncHandler(async (req,res) => {
        const parsed = issuance.parse(req.body);
        const data = await issue(req.user!.id, {
            vendorId: parsed.vendorId, origin: parsed.origin, purpose: parsed.purpose,
            campaignId: parsed.campaignId, disclosureGrantId: parsed.disclosureGrantId,
            ...(parsed.productId !== undefined ? { productId: parsed.productId } : {}),
        });
        res.status(201).json({ success:true, data });
    }));
    router.post('/exchange', asyncHandler(async (req,res) => {
        const data = await exchangeAssertion(merchantKeyFrom(req), exchange.parse(req.body));
        res.json({ success:true, data });
    }));
    router.post('/claim-sessions', asyncHandler(async (req,res) => {
        const data = await createSession(merchantKeyFrom(req), claimSessionCreation.parse(req.body));
        res.status(data.created ? 201 : 200).json({ success:true, data: { claimSessionId: data.claimSessionId, expiresAt: data.expiresAt } });
    }));
    router.get('/claim-sessions/:id', authenticate, requireRole('student'), asyncHandler(async (req,res) => {
        const data = await readSession(sessionIdParam.parse(req.params).id);
        res.set('Cache-Control', 'no-store');
        res.json({ success:true, data });
    }));
    router.post('/product-claims', authenticate, requireRole('student'), asyncHandler(async (req,res) => {
        const data = await claim(req.user!.id, productClaim.parse(req.body));
        res.set('Cache-Control', 'no-store');
        res.set('Referrer-Policy', 'no-referrer');
        res.status(201).json({ success:true, data });
    }));
    return router;
}

export default createMerchantVerificationRouter();
