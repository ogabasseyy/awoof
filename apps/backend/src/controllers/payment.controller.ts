/**
 * Payment Controller
 * 
 * Handles payment settings and history for vendors
 */

import type { Response } from 'express';
import { db } from '../config/database.js';
import {
    BadRequestError,
    NotFoundError,
    UnauthorizedError,
} from '../common/errors/AppError.js';
import { success } from '../common/utils/response.js';
import { appLogger } from '../common/logger.js';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import { z } from 'zod';
import crypto from 'crypto';
import { validateAndConsumeToken } from '../services/verification/verification-token.service.js';
import {
    createPaystackSubaccount,
    listPaystackBanks,
    resolvePaystackAccount,
    updatePaystackSubaccount,
    verifyPaystackPayment,
} from '../services/payment/paystack.service.js';
import { getPlatformFeePercent } from '../services/payment/checkout.service.js';
import { NotificationService } from '../services/notification/notification.service.js';

/**
 * Validation schemas
 */
const updatePayoutSettingsSchema = z.object({
    bankName: z.string().min(1, 'Bank name is required'),
    accountNumber: z
        .string()
        .min(10, 'Account number must be at least 10 digits')
        .max(20, 'Account number is too long')
        .regex(/^\d+$/, 'Account number must be digits only'),
    bankCode: z.string().min(1, 'Bank code is required'),
});

const updatePaymentMethodSchema = z.object({
    paymentMethod: z.enum(['awoof', 'vendor_website'], {
        errorMap: () => ({ message: 'Payment method must be either "awoof" or "vendor_website"' }),
    }),
});

const updatePaystackSubaccountSchema = z.object({
    paystackSubaccountCode: z.string().min(1, 'Paystack subaccount code is required'),
});

const reportTransactionSchema = z.object({
    verificationToken: z.string().min(1, 'Verification token is required'),
    paymentReference: z.string().min(1, 'Payment reference is required'),
    amount: z.coerce.number().positive('Amount must be positive'),
    productId: z.string().uuid('Invalid product ID'),
    paymentGateway: z.string().min(1, 'Payment gateway is required'),
});

/**
 * Payment Controller
 */
export class PaymentController {
    /**
     * Get payment settings and summary
     */
    public async getPaymentSettings(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can view payment settings');
        }

        // Get vendor ID
        const vendorResult = await db.query(
            `SELECT id, commission_rate, paystack_subaccount_code,
                    COALESCE(payment_method, 'awoof') as payment_method,
                    bank_name, bank_code, account_number, account_name
             FROM vendors 
             WHERE user_id = $1 AND deleted_at IS NULL`,
            [req.user.userId]
        );

        if (vendorResult.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        const vendor = vendorResult.rows[0];
        const vendorId = vendor.id;

        // Marketplace checkout uses platform_fee_percent; vendor.commission_rate may be unset (0)
        const platformFeePercent = await getPlatformFeePercent();
        const vendorRate = parseFloat(vendor.commission_rate || '0');
        const commissionRate = vendorRate > 0 ? vendorRate : platformFeePercent;

        // Get payment statistics
        const statsResult = await db.query(
            `SELECT 
                COUNT(*) as total_orders,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0) as total_revenue,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN commission ELSE 0 END), 0) as total_commission,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN (amount - commission) ELSE 0 END), 0) as total_earnings
             FROM transactions
             WHERE vendor_id = $1`,
            [vendorId]
        );

        const stats = statsResult.rows[0];

        const payoutSettings = {
            bankName: vendor.bank_name || null,
            accountNumber: vendor.account_number || null,
            accountName: vendor.account_name || null,
            bankCode: vendor.bank_code || null,
        };

        success(res, {
            message: 'Payment settings retrieved successfully',
            data: {
                settings: {
                    commissionRate,
                    paystackSubaccountCode: vendor.paystack_subaccount_code,
                    paymentMethod: vendor.payment_method as 'awoof' | 'vendor_website' | null,
                    payoutSettings,
                },
                statistics: {
                    totalOrders: parseInt(stats.total_orders || '0'),
                    completedOrders: parseInt(stats.completed_orders || '0'),
                    totalRevenue: parseFloat(stats.total_revenue || '0'),
                    totalCommission: parseFloat(stats.total_commission || '0'),
                    totalEarnings: parseFloat(stats.total_earnings || '0'),
                },
            },
        });
    }

    /**
     * List Nigerian banks from Paystack (for payout bank picker)
     */
    public async listBanks(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can list banks');
        }

        const banks = await listPaystackBanks();
        success(res, {
            message: 'Banks retrieved successfully',
            data: { banks },
        });
    }

    /**
     * Resolve bank account name via Paystack
     */
    public async resolveAccount(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can resolve accounts');
        }

        const bankCode = String(req.query.bankCode || '').trim();
        const accountNumber = String(req.query.accountNumber || '').trim();

        if (!bankCode || !accountNumber) {
            throw new BadRequestError('bankCode and accountNumber are required');
        }
        if (!/^\d{10,20}$/.test(accountNumber)) {
            throw new BadRequestError('Account number must be 10–20 digits');
        }

        const resolved = await resolvePaystackAccount(bankCode, accountNumber);
        success(res, {
            message: 'Account resolved successfully',
            data: resolved,
        });
    }

    /**
     * Update payout settings — resolve account, create/update Paystack subaccount, persist
     */
    public async updatePayoutSettings(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can update payment settings');
        }

        const vendorResult = await db.query(
            `SELECT id, name, company_name, paystack_subaccount_code
             FROM vendors WHERE user_id = $1 AND deleted_at IS NULL`,
            [req.user.userId]
        );

        if (vendorResult.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        const vendor = vendorResult.rows[0];
        const validated = updatePayoutSettingsSchema.parse(req.body);

        const resolved = await resolvePaystackAccount(validated.bankCode, validated.accountNumber);
        const percentageCharge = await getPlatformFeePercent();
        // Paystack subaccount display name = bank account holder (resolved NUBAN name)
        const businessName = (resolved.accountName || vendor.company_name || vendor.name || 'Vendor').slice(
            0,
            100
        );

        const subaccountParams = {
            businessName,
            bankCode: validated.bankCode,
            accountNumber: validated.accountNumber,
            percentageCharge,
        };

        let subaccountCode: string;
        if (vendor.paystack_subaccount_code) {
            const updated = await updatePaystackSubaccount(
                vendor.paystack_subaccount_code,
                subaccountParams
            );
            subaccountCode = updated.subaccountCode;
        } else {
            const created = await createPaystackSubaccount(subaccountParams);
            subaccountCode = created.subaccountCode;
        }

        await db.query(
            `UPDATE vendors
             SET bank_name = $1,
                 bank_code = $2,
                 account_number = $3,
                 account_name = $4,
                 paystack_subaccount_code = $5,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $6`,
            [
                validated.bankName,
                validated.bankCode,
                validated.accountNumber,
                resolved.accountName,
                subaccountCode,
                vendor.id,
            ]
        );

        try {
            await NotificationService.notifyVendorPayoutEnabled(req.user.userId);
        } catch (error) {
            appLogger.error('Payout enabled notification failed', error);
        }

        success(res, {
            message: 'Payout settings updated successfully',
            data: {
                payoutSettings: {
                    bankName: validated.bankName,
                    bankCode: validated.bankCode,
                    accountNumber: validated.accountNumber,
                    accountName: resolved.accountName,
                },
                paystackSubaccountCode: subaccountCode,
            },
        });
    }

    /**
     * Get payment history
     */
    public async getPaymentHistory(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can view payment history');
        }

        // Get vendor ID
        const vendorResult = await db.query(
            'SELECT id FROM vendors WHERE user_id = $1 AND deleted_at IS NULL',
            [req.user.userId]
        );

        if (vendorResult.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        const vendorId = vendorResult.rows[0].id;

        // Get query parameters
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;
        const status = req.query.status as string | undefined;

        // Build query
        let query = `
            SELECT 
                t.id,
                t.amount,
                t.commission,
                t.status,
                t.paystack_reference,
                t.created_at,
                p.name as product_name
            FROM transactions t
            JOIN products p ON t.product_id = p.id
            WHERE t.vendor_id = $1
        `;
        const values: (string | number)[] = [vendorId];
        let paramCount = 2;

        if (status) {
            query += ` AND t.status = $${paramCount}`;
            values.push(status);
            paramCount++;
        }

        query += ` ORDER BY t.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        values.push(limit, offset);

        const result = await db.query(query, values);

        // Get total count
        let countQuery = `
            SELECT COUNT(*) as total
            FROM transactions t
            WHERE t.vendor_id = $1
        `;
        const countValues: (string | number)[] = [vendorId];
        let countParamCount = 2;

        if (status) {
            countQuery += ` AND t.status = $${countParamCount}`;
            countValues.push(status);
        }

        const countResult = await db.query(countQuery, countValues);
        const total = parseInt(countResult.rows[0].total);
        const totalPages = Math.ceil(total / limit);

        // Format payments
        const payments = result.rows.map((row) => ({
            id: row.id,
            amount: parseFloat(row.amount),
            commission: parseFloat(row.commission),
            earnings: parseFloat(row.amount) - parseFloat(row.commission),
            status: row.status,
            paystackReference: row.paystack_reference,
            productName: row.product_name,
            createdAt: row.created_at,
        }));

        success(res, {
            message: 'Payment history retrieved successfully',
            data: {
                payments,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages,
                },
            },
        });
    }

    /**
     * Get commission summary
     */
    public async getCommissionSummary(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can view commission summary');
        }

        // Get vendor ID
        const vendorResult = await db.query(
            `SELECT id, commission_rate
             FROM vendors 
             WHERE user_id = $1 AND deleted_at IS NULL`,
            [req.user.userId]
        );

        if (vendorResult.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        const vendorId = vendorResult.rows[0].id;
        const vendorRate = parseFloat(vendorResult.rows[0].commission_rate || '0');
        const platformFeePercent = await getPlatformFeePercent();
        const commissionRate = vendorRate > 0 ? vendorRate : platformFeePercent;

        // Get commission breakdown by status
        const breakdownResult = await db.query(
            `SELECT 
                status,
                COUNT(*) as count,
                COALESCE(SUM(amount), 0) as total_amount,
                COALESCE(SUM(commission), 0) as total_commission,
                COALESCE(SUM(amount - commission), 0) as total_earnings
             FROM transactions
             WHERE vendor_id = $1
             GROUP BY status
             ORDER BY status`,
            [vendorId]
        );

        // Get monthly summary (last 6 months)
        const monthlyResult = await db.query(
            `SELECT 
                DATE_TRUNC('month', created_at) as month,
                COUNT(*) as count,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0) as revenue,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN commission ELSE 0 END), 0) as commission,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN (amount - commission) ELSE 0 END), 0) as earnings
             FROM transactions
             WHERE vendor_id = $1
             AND created_at >= NOW() - INTERVAL '6 months'
             GROUP BY DATE_TRUNC('month', created_at)
             ORDER BY month DESC`,
            [vendorId]
        );

        success(res, {
            message: 'Commission summary retrieved successfully',
            data: {
                commissionRate,
                breakdown: breakdownResult.rows.map((row) => ({
                    status: row.status,
                    count: parseInt(row.count),
                    totalAmount: parseFloat(row.total_amount),
                    totalCommission: parseFloat(row.total_commission),
                    totalEarnings: parseFloat(row.total_earnings),
                })),
                monthlySummary: monthlyResult.rows.map((row) => ({
                    month: row.month,
                    count: parseInt(row.count),
                    revenue: parseFloat(row.revenue),
                    commission: parseFloat(row.commission),
                    earnings: parseFloat(row.earnings),
                })),
            },
        });
    }

    /**
     * Update payment method
     */
    public async updatePaymentMethod(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can update payment method');
        }

        // Get vendor ID
        const vendorResult = await db.query(
            'SELECT id FROM vendors WHERE user_id = $1 AND deleted_at IS NULL',
            [req.user.userId]
        );

        if (vendorResult.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        const vendorId = vendorResult.rows[0].id;

        // Validate request body
        const validated = updatePaymentMethodSchema.parse(req.body);

        // Update payment method in vendors table
        // Note: We'll need to add payment_method column if it doesn't exist
        await db.query(
            `UPDATE vendors 
             SET payment_method = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [validated.paymentMethod, vendorId]
        );

        success(res, {
            message: 'Payment method updated successfully',
            data: {
                paymentMethod: validated.paymentMethod,
            },
        });
    }

    /**
     * Update Paystack subaccount code
     */
    public async updatePaystackSubaccount(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can update Paystack subaccount');
        }

        // Get vendor ID
        const vendorResult = await db.query(
            'SELECT id FROM vendors WHERE user_id = $1 AND deleted_at IS NULL',
            [req.user.userId]
        );

        if (vendorResult.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        const vendorId = vendorResult.rows[0].id;

        // Validate request body
        const validated = updatePaystackSubaccountSchema.parse(req.body);

        // Update Paystack subaccount code
        await db.query(
            `UPDATE vendors 
             SET paystack_subaccount_code = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [validated.paystackSubaccountCode, vendorId]
        );

        success(res, {
            message: 'Paystack subaccount updated successfully',
            data: {
                paystackSubaccountCode: validated.paystackSubaccountCode,
            },
        });
    }

    /**
     * Generate API key for transaction reporting
     */
    public async generateApiKey(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can generate API keys');
        }

        // Get vendor ID
        const vendorResult = await db.query(
            'SELECT id FROM vendors WHERE user_id = $1 AND deleted_at IS NULL',
            [req.user.userId]
        );

        if (vendorResult.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        const vendorId = vendorResult.rows[0].id;

        // Check if vendor already has an active API key
        const existingKeyResult = await db.query(
            `SELECT id, key_hash FROM api_keys 
             WHERE vendor_id = $1 AND status = 'active' 
             ORDER BY created_at DESC LIMIT 1`,
            [vendorId]
        );

        // Generate new API key and hash with high computational cost (CodeQL: sufficient effort)
        const apiKey = `awoof_${crypto.randomBytes(32).toString('hex')}`;
        const salt = crypto.randomBytes(16);
        const hashHex = crypto.pbkdf2Sync(apiKey, salt, 100000, 32, 'sha256').toString('hex');
        const saltHex = salt.toString('hex');
        const keyHashStored = `${hashHex}:${saltHex}`;

        // If there's an existing key, revoke it
        if (existingKeyResult.rows.length > 0) {
            await db.query(
                `UPDATE api_keys 
                 SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [existingKeyResult.rows[0].id]
            );
        }

        // Create new API key (key_hash stores "hash:salt" for verification)
        await db.query(
            `INSERT INTO api_keys (vendor_id, key_hash, name, rate_limit, status)
             VALUES ($1, $2, $3, $4, 'active')`,
            [vendorId, keyHashStored, 'Transaction Reporting API Key', 1000]
        );

        // Return the API key (only shown once)
        success(res, {
            message: 'API key generated successfully',
            data: {
                apiKey,
                note: 'Store this key securely. It will not be shown again.',
            },
        }, 201);
    }

    /**
     * Get vendor API key (if exists)
     */
    public async getApiKey(req: AuthRequest, res: Response): Promise<void> {
        if (!req.user || req.user.role !== 'vendor') {
            throw new UnauthorizedError('Only vendors can view API keys');
        }

        // Get vendor ID
        const vendorResult = await db.query(
            'SELECT id FROM vendors WHERE user_id = $1 AND deleted_at IS NULL',
            [req.user.userId]
        );

        if (vendorResult.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        const vendorId = vendorResult.rows[0].id;

        // Get active API key
        const keyResult = await db.query(
            `SELECT id, name, rate_limit, usage_count, created_at, expires_at, status
             FROM api_keys 
             WHERE vendor_id = $1 AND status = 'active' 
             ORDER BY created_at DESC LIMIT 1`,
            [vendorId]
        );

        if (keyResult.rows.length === 0) {
            success(res, {
                message: 'No API key found',
                data: {
                    hasApiKey: false,
                },
            });
            return;
        }

        const key = keyResult.rows[0];
        success(res, {
            message: 'API key retrieved successfully',
            data: {
                hasApiKey: true,
                keyInfo: {
                    name: key.name,
                    rateLimit: parseInt(key.rate_limit),
                    usageCount: parseInt(key.usage_count),
                    createdAt: key.created_at,
                    expiresAt: key.expires_at,
                    status: key.status,
                },
            },
        });
    }

    /**
     * Report transaction (for vendor website payments)
     */
    public async reportTransaction(req: AuthRequest, res: Response): Promise<void> {
        // This endpoint can be called with API key authentication
        // For now, we'll support both JWT and API key auth
        // API key auth will be handled by middleware later

        // Validate request body
        const validated = reportTransactionSchema.parse(req.body);

        // Get vendor ID
        const vendorResult = await db.query(
            'SELECT id FROM vendors WHERE user_id = $1 AND deleted_at IS NULL',
            [req.user?.userId]
        );

        if (vendorResult.rows.length === 0) {
            throw new NotFoundError('Vendor profile not found');
        }

        const vendorId = vendorResult.rows[0].id;

        // 1. Validate and consume verification token
        const tokenData = await validateAndConsumeToken(validated.verificationToken, vendorId);

        // 2. Verify product exists and belongs to vendor
        const productResult = await db.query(
            `SELECT id, price, student_price, vendor_id
             FROM products
             WHERE id = $1 AND vendor_id = $2 AND deleted_at IS NULL`,
            [validated.productId, vendorId]
        );

        if (productResult.rows.length === 0) {
            throw new NotFoundError('Product not found or does not belong to vendor');
        }

        const product = productResult.rows[0];

        // 3. Validate payment amount matches product price (allow small variance for rounding)
        const expectedAmount = parseFloat(product.student_price.toString());
        const reportedAmount = validated.amount / 100; // Convert from kobo to naira
        const variance = Math.abs(expectedAmount - reportedAmount);
        const allowedVariance = 0.01; // Allow 1 kobo variance

        if (variance > allowedVariance) {
            throw new BadRequestError(
                `Payment amount (${reportedAmount}) does not match product price (${expectedAmount})`
            );
        }

        // 4. Validate payment reference (if Paystack)
        if (validated.paymentGateway === 'paystack') {
            const paymentVerification = await verifyPaystackPayment(validated.paymentReference);

            if (!paymentVerification.verified) {
                throw new BadRequestError(
                    paymentVerification.error || 'Payment verification failed'
                );
            }

            // Verify payment amount matches
            if (paymentVerification.amount && Math.abs(paymentVerification.amount - reportedAmount) > allowedVariance) {
                throw new BadRequestError(
                    `Paystack payment amount (${paymentVerification.amount}) does not match reported amount (${reportedAmount})`
                );
            }
        }

        // 5. Check for duplicate payment reference
        const duplicateCheck = await db.query(
            `SELECT id FROM transactions
             WHERE vendor_payment_reference = $1 AND vendor_id = $2`,
            [validated.paymentReference, vendorId]
        );

        if (duplicateCheck.rows.length > 0) {
            throw new BadRequestError('Payment reference has already been used');
        }

        // 6. Get vendor commission rate
        const vendorInfo = await db.query(
            'SELECT commission_rate FROM vendors WHERE id = $1',
            [vendorId]
        );

        const commissionRate = parseFloat(vendorInfo.rows[0]?.commission_rate || '0');
        const commission = (reportedAmount * commissionRate) / 100;
        const earnings = reportedAmount - commission;

        // 7. Create transaction record
        const transactionResult = await db.query(
            `INSERT INTO transactions (
                student_id, product_id, vendor_id, amount, commission,
                status, verification_token, payment_source, vendor_payment_reference, verified_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
            RETURNING id, status, created_at`,
            [
                tokenData.studentId,
                validated.productId,
                vendorId,
                reportedAmount,
                commission,
                'completed',
                validated.verificationToken,
                validated.paymentGateway === 'paystack' ? 'vendor_paystack' : 'vendor_other',
                validated.paymentReference,
            ]
        );

        const transaction = transactionResult.rows[0];

        // 8. Update savings stats for student
        const discountAmount = parseFloat(product.price.toString()) - reportedAmount;
        await db.query(
            `INSERT INTO savings_stats (student_id, total_savings, total_purchases, last_updated)
             VALUES ($1, $2, 1, CURRENT_TIMESTAMP)
             ON CONFLICT (student_id)
             DO UPDATE SET
                 total_savings = savings_stats.total_savings + $2,
                 total_purchases = savings_stats.total_purchases + 1,
                 last_updated = CURRENT_TIMESTAMP`,
            [tokenData.studentId, discountAmount]
        );

        // 9. Get updated savings total for milestone check
        const savingsResult = await db.query(
            'SELECT total_savings FROM savings_stats WHERE student_id = $1',
            [tokenData.studentId]
        );
        const totalSavings = savingsResult.rows[0]?.total_savings || 0;

        // 10. Create purchase confirmation notification
        try {
            await NotificationService.notifyPurchaseConfirmation(
                tokenData.studentId,
                product.name,
                parseFloat(product.price.toString()),
                discountAmount,
                transaction.id
            );

            // Check for savings milestone
            await NotificationService.notifySavingsMilestone(
                tokenData.studentId,
                parseFloat(totalSavings.toString())
            );
        } catch (error) {
            appLogger.error('Error creating notification:', error);
        }

        success(res, {
            message: 'Transaction reported successfully',
            data: {
                transactionId: transaction.id,
                status: transaction.status,
                amount: reportedAmount,
                commission,
                earnings,
                createdAt: transaction.created_at,
            },
        }, 201);
    }
}

