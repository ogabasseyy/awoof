/**
 * Checkout Controller — marketplace purchase initialization and status.
 */

import type { Response } from 'express';
import { z } from 'zod';
import { db } from '../config/database.js';
import { config } from '../config/env.js';
import {
    BadRequestError,
    NotFoundError,
    UnauthorizedError,
} from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import {
    calculateMarketplaceCommission,
    getPlatformFeePercent,
} from '../services/payment/checkout.service.js';
import {
    generatePaystackReference,
    initializePaystackTransaction,
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

        const studentRow = await db.query(
            `SELECT s.id, u.email, u.verification_status
             FROM students s
             JOIN users u ON u.id = s.user_id
             WHERE s.user_id = $1 AND u.deleted_at IS NULL`,
            [req.user.userId]
        );

        if (studentRow.rows.length === 0) {
            throw new NotFoundError('Student profile not found');
        }

        const student = studentRow.rows[0];
        if (student.verification_status !== 'verified') {
            throw new BadRequestError('Student must be verified to purchase');
        }

        const productRow = await db.query(
            `SELECT p.*,
                    v.status AS vendor_status,
                    v.paystack_subaccount_code,
                    COALESCE(v.payment_method, 'awoof') AS payment_method
             FROM products p
             JOIN vendors v ON v.id = p.vendor_id
             WHERE p.id = $1 AND p.deleted_at IS NULL AND v.deleted_at IS NULL`,
            [validated.productId]
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

        const amount = parseFloat(product.student_price);
        const platformFeePercent = await getPlatformFeePercent();
        const { commission } = calculateMarketplaceCommission(amount, platformFeePercent);
        const settlementMode = product.paystack_subaccount_code ? 'split' : 'manual';
        const reference = generatePaystackReference();

        const insert = await db.query(
            `INSERT INTO transactions (
                student_id, product_id, vendor_id, amount, commission,
                status, paystack_reference, payment_source, settlement_mode
             )
             VALUES ($1, $2, $3, $4, $5, 'pending', $6, 'awoof', $7)
             RETURNING id`,
            [
                student.id,
                product.id,
                product.vendor_id,
                amount,
                commission,
                reference,
                settlementMode,
            ]
        );

        const transactionId = insert.rows[0].id;

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

            success(res, {
                message: 'Checkout initialized',
                data: {
                    authorizationUrl,
                    transactionId,
                    reference,
                },
            });
        } catch (error) {
            await db.query(
                `UPDATE transactions SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [transactionId]
            );
            throw error;
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
