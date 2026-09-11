/**
 * Checkout Controller — marketplace purchase initialization and status.
 */

import type { Response } from 'express';
import { z } from 'zod';
import { db } from '../config/database.js';
import { getEffectiveEligibility } from '../services/verification/eligibility-read.service.js';
import { config } from '../config/env.js';
import {
    BadRequestError,
    ConflictError,
    ServiceUnavailableError,
    NotFoundError,
    UnauthorizedError,
} from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import {
    calculateMarketplaceCommission,
    completeMarketplaceTransaction,
    getPlatformFeePercent,
} from '../services/payment/checkout.service.js';
import {
    generatePaystackReference,
    PaystackInitializationRejectedError,
    initializePaystackTransaction,
    verifyPaystackPayment,
} from '../services/payment/paystack.service.js';

const createCheckoutSchema = z.object({
    productId: z.string().uuid(),
});

export class CheckoutController {
    public async createCheckout(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'student') {
            throw new UnauthorizedError('Only students can checkout');
        }

        const validated = createCheckoutSchema.parse(req.body);
        const userId = req.user.userId;

        const { student, product, amount, commission, settlementMode, reference, transactionId, existingAuthorizationUrl } = await (async () => {
            const client = await db.getPool().connect();
            try {
                await client.query('BEGIN');
                // Resolve candidates without locks, then acquire all participant
                // users in the same UUID order as merchant disclosure flows.
                const candidate = await client.query(
                    `SELECT p.vendor_id, v.user_id FROM products p
                     JOIN vendors v ON v.id = p.vendor_id WHERE p.id = $1`,
                    [validated.productId]
                );
                const merchant = candidate.rows[0];
                const participants = await client.query(
                    `SELECT id, role, deleted_at FROM users
                     WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
                    [[...new Set([userId, ...(merchant ? [merchant.user_id] : [])])].sort()]
                );
                // Eligibility precedes merchant locks, matching payment settlement.
                // Keep current evidence, identity, policy and consent locks until
                // checkout creation commits. Legacy profile flags grant no authority.
                const eligibility = await getEffectiveEligibility(client, userId);
                if (!eligibility.eligible) throw new BadRequestError('Current student eligibility is required to purchase');
                if (!merchant) throw new NotFoundError('Product not found');
                const owner = participants.rows.find((row) => row.id === merchant.user_id);
                if (!owner || owner.role !== 'vendor' || owner.deleted_at !== null) {
                    throw new BadRequestError('Vendor is not approved to sell');
                }
                const vendor = await client.query(
                    `SELECT id FROM vendors WHERE id = $1 AND user_id = $2
                     AND status = 'active' AND deleted_at IS NULL FOR UPDATE`,
                    [merchant.vendor_id, merchant.user_id]
                );
                if (!vendor.rows.length) throw new BadRequestError('Vendor is not approved to sell');
                const studentRow = await client.query(
                    `SELECT s.id, u.email
                     FROM students s
                     JOIN users u ON u.id = s.user_id
                     WHERE s.user_id = $1 AND u.deleted_at IS NULL
                       AND (s.status IS NULL OR s.status = 'active')`,
                    [userId]
                );

                if (studentRow.rows.length === 0) {
                    throw new NotFoundError('Student profile not found');
                }

                const student = studentRow.rows[0];

                const productRow = await client.query(
                    `SELECT p.*,
                            v.status AS vendor_status,
                            v.paystack_subaccount_code,
                            COALESCE(v.payment_method, 'awoof') AS payment_method
                     FROM products p
                     JOIN vendors v ON v.id = p.vendor_id
                     WHERE p.id = $1 AND p.vendor_id = $2
                       AND p.deleted_at IS NULL AND v.deleted_at IS NULL
                     FOR UPDATE OF p`,
                    [validated.productId, merchant.vendor_id]
                );

                if (productRow.rows.length === 0) {
                    throw new NotFoundError('Product not found');
                }

                const product = productRow.rows[0];

                if (product.status !== 'active') {
                    throw new BadRequestError('Product not available');
                }
                if ((product.deal_type ?? 'product') !== 'product') {
                    throw new BadRequestError('This deal must be purchased on the vendor website');
                }
                if (product.payment_method !== 'awoof') {
                    throw new BadRequestError('This deal must be purchased on the vendor website');
                }
                if (product.vendor_status !== 'active') {
                    throw new BadRequestError('Vendor is not approved to sell');
                }
                if (product.stock <= 0) {
                    throw new BadRequestError('Out of stock');
                }

                // Eligibility locks serialize checkout reservations for this student.
                // A timeout is not proof that Paystack rejected the request.
                const prior = await client.query(
                    `SELECT id, paystack_reference, checkout_authorization_url, amount, commission, settlement_mode
                     FROM transactions WHERE student_id = $1 AND product_id = $2 AND payment_source = 'awoof'
                     AND (status = 'pending' OR (status = 'failed' AND checkout_initialization_state IN ('initializing', 'initialized', 'unknown')))
                     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [student.id, product.id]);
                if (prior.rows.length) {
                    const previous = prior.rows[0];
                    if (!previous.checkout_authorization_url) {
                        throw new ConflictError('Your earlier checkout is awaiting payment reconciliation. Check its status before trying again.',
                            { transactionId: previous.id, reference: previous.paystack_reference });
                    }
                    await client.query('COMMIT');
                    return { student, product, amount: Number(previous.amount), commission: Number(previous.commission),
                        settlementMode: previous.settlement_mode, reference: previous.paystack_reference,
                        transactionId: previous.id, existingAuthorizationUrl: String(previous.checkout_authorization_url) };
                }
                if (!config.paystack.secretKey) throw new ServiceUnavailableError('Payments are not configured');
                const amount = parseFloat(product.student_price);
                const platformFeePercent = await getPlatformFeePercent(client);
                const { commission } = calculateMarketplaceCommission(amount, platformFeePercent);
                const settlementMode = product.paystack_subaccount_code ? 'split' : 'manual';
                const reference = generatePaystackReference();

                const insert = await client.query(
                    `INSERT INTO transactions (
                        student_id, product_id, vendor_id, amount, commission, list_price_snapshot,
                        status, paystack_reference, payment_source, settlement_mode, checkout_initialization_state
                     )
                     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, 'awoof', $8, 'initializing')
                     RETURNING id`,
                    [
                        student.id,
                        product.id,
                        product.vendor_id,
                        amount,
                        commission,
                        parseFloat(product.price),
                        reference,
                        settlementMode,
                    ]
                );

                const transactionId = insert.rows[0].id;
                await client.query('COMMIT');
                return { student, product, amount, commission, settlementMode, reference, transactionId, existingAuthorizationUrl: undefined };
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
        })();

        if (existingAuthorizationUrl) {
            success(res, { message: 'Existing checkout retrieved', data: { authorizationUrl: existingAuthorizationUrl, transactionId, reference } });
            return;
        }

        try {
            const initParams: Parameters<typeof initializePaystackTransaction>[0] = {
                email: student.email,
                amountKobo: Math.round(amount * 100),
                reference,
                callbackUrl: `${config.frontend.url}/marketplace/purchase/callback?tx=${transactionId}`,
                metadata: {
                    transactionId,
                    productId: product.id,
                    studentId: student.id,
                    vendorId: product.vendor_id,
                },
                subaccountCode: product.paystack_subaccount_code,
            };

            if (settlementMode === 'split') {
                initParams.transactionChargeKobo = Math.round(commission * 100);
            }

            const { authorizationUrl } = await initializePaystackTransaction(initParams);

            await db.query(`UPDATE transactions SET checkout_initialization_state = 'initialized',
                checkout_authorization_url = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [transactionId, authorizationUrl]);

            success(res, {
                message: 'Checkout initialized',
                data: {
                    authorizationUrl,
                    transactionId,
                    reference,
                },
            });
        } catch (error) {
            if (error instanceof PaystackInitializationRejectedError) {
                await db.query(`UPDATE transactions SET status = 'failed', checkout_initialization_state = NULL,
                    updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'pending'`, [transactionId]);
                throw error;
            }
            await db.query(
                `UPDATE transactions SET checkout_initialization_state = 'unknown', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status IN ('pending', 'failed')`,
                [transactionId]
            );
            throw new ServiceUnavailableError('Payment initialization could not be confirmed. Check this checkout before retrying.', { transactionId, reference });
        }
    }

    public async getCheckoutStatus(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'student') {
            throw new UnauthorizedError('Only students can view checkout status');
        }

        const { transactionId } = req.params;

        const result = await db.query(
            `SELECT t.id, t.amount, t.commission, t.status, t.paystack_reference,
                    t.settlement_mode, t.created_at, t.updated_at,
                    p.name AS product_name, p.image_url AS product_image
             FROM transactions t
             JOIN products p ON p.id = t.product_id
             JOIN students s ON s.id = t.student_id
             WHERE t.id = $1 AND s.user_id = $2`,
            [transactionId, req.user.userId]
        );

        if (result.rows.length === 0) {
            throw new NotFoundError('Transaction not found');
        }

        const tx = result.rows[0];

        // If webhook hasn't arrived yet, confirm with Paystack and complete (local/tunnel gaps)
        if ((tx.status === 'pending' || tx.status === 'failed') && tx.paystack_reference) {
            const verified = await verifyPaystackPayment(tx.paystack_reference);
            if (verified.verified && verified.amount != null) {
                await completeMarketplaceTransaction(tx.paystack_reference, verified.amount);
                const refreshed = await db.query(
                    `SELECT t.id, t.amount, t.commission, t.status, t.paystack_reference,
                            t.settlement_mode, t.created_at, t.updated_at,
                            p.name AS product_name, p.image_url AS product_image
                     FROM transactions t
                     JOIN products p ON p.id = t.product_id
                     JOIN students s ON s.id = t.student_id
                     WHERE t.id = $1 AND s.user_id = $2`,
                    [transactionId, req.user.userId]
                );
                if (refreshed.rows.length > 0) {
                    Object.assign(tx, refreshed.rows[0]);
                }
            }
        }

        success(res, {
            message: 'Checkout status retrieved',
            data: {
                transaction: {
                    id: tx.id,
                    amount: parseFloat(tx.amount),
                    commission: parseFloat(tx.commission),
                    status: tx.status,
                    paystackReference: tx.paystack_reference,
                    settlementMode: tx.settlement_mode,
                    productName: tx.product_name,
                    productImage: tx.product_image,
                    createdAt: tx.created_at,
                    updatedAt: tx.updated_at,
                },
            },
        });
    }
}

export const checkoutController = new CheckoutController();
