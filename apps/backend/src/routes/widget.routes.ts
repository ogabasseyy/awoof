/**
 * Widget Routes
 *
 * Public API for the embeddable student verification widget.
 * Domain checks use the public site key and registered origin; merchant context
 * also requires the disabled-by-default pilot gate and merchant allowlist.
 */

import { Router } from 'express';
import { asyncHandler } from '../common/middleware/errorHandler.js';
import * as widgetController from '../controllers/widget.controller.js';

const router = Router();

/**
 * @swagger
 * /api/widget/domain-check:
 *   post:
 *     summary: Check a public widget key against a registered merchant domain and origin
 *     description: The key belongs in the JSON body, never in a URL. The controlled hosted pilot requires an exact registered origin.
 *     tags: [Widget]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [domain, apiKey]
 *             properties:
 *               domain: { type: string, minLength: 1, description: Merchant hostname }
 *               origin: { type: string, description: Exact registered merchant origin; required by the hosted pilot }
 *               apiKey: { type: string, minLength: 1, description: Public widget site key }
 *     responses:
 *       '200':
 *         description: Registered merchant domain and origin
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   required: [allowed, vendorId]
 *                   properties:
 *                     allowed: { type: boolean, enum: [true] }
 *                     vendorId: { type: string, format: uuid }
 *       '400':
 *         description: Invalid domain or origin
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       '403':
 *         description: Domain, origin or public key is unavailable
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 * /api/widget/merchant-context:
 *   post:
 *     summary: Read the registered merchant display context for the controlled hosted pilot
 *     description: Public but disabled by default. Requires an allowlisted merchant and exact registered origin. Returns no student data or secret.
 *     tags: [Widget]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [vendorId, origin]
 *             properties:
 *               vendorId: { type: string, format: uuid }
 *               origin: { type: string, maxLength: 512, description: Exact registered merchant origin including port; HTTPS outside local development }
 *     responses:
 *       '200':
 *         description: Registered display context; Cache-Control no-store
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   additionalProperties: false
 *                   required: [vendorId, origin, merchantName]
 *                   properties:
 *                     vendorId: { type: string, format: uuid }
 *                     origin: { type: string }
 *                     merchantName: { type: string }
 *       '400':
 *         description: Invalid merchant origin
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       '403':
 *         description: Pilot disabled, merchant not allowlisted, or origin not registered
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       '422':
 *         description: Invalid JSON body
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post(
    '/domain-check',
    asyncHandler(widgetController.domainCheck)
);
router.post('/merchant-context', asyncHandler(widgetController.merchantContext));

export default router;
