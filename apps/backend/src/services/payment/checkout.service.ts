/**
 * Marketplace checkout helpers — commission math and transaction completion.
 */

import { db } from '../../config/database.js';
import { BadRequestError } from '../../common/errors/AppError.js';
import { appLogger } from '../../common/logger.js';
import { NotificationService } from '../notification/notification.service.js';
import {
    sendPurchaseConfirmationEmail,
    sendVendorNewOrderEmail,
} from '../email/email.service.js';

export function calculateMarketplaceCommission(
    amount: number,
    platformFeePercent: number
): { commission: number; vendorNet: number } {
    const commission = Math.round(amount * platformFeePercent) / 100;
    const vendorNet = Math.round((amount - commission) * 100) / 100;
    return { commission, vendorNet };
}

export async function getPlatformFeePercent(): Promise<number> {
    const result = await db.query(
        `SELECT value FROM platform_settings WHERE key = 'platform_fee_percent'`
    );
    if (result.rows.length === 0) {
        return 10;
    }
    return parseFloat(result.rows[0].value) || 10;
}

async function emitCommerceNotifications(transactionId: string): Promise<void> {
    try {
        const result = await db.query(
            `SELECT t.id, t.amount, t.student_id, t.vendor_id,
                    p.name AS product_name, p.price AS list_price,
                    s.user_id AS student_user_id, su.email AS student_email,
                    v.user_id AS vendor_user_id, vu.email AS vendor_email,
                    ss.total_savings
             FROM transactions t
             JOIN products p ON p.id = t.product_id
             JOIN students s ON s.id = t.student_id
             JOIN users su ON su.id = s.user_id
             JOIN vendors v ON v.id = t.vendor_id
             JOIN users vu ON vu.id = v.user_id
             LEFT JOIN savings_stats ss ON ss.student_id = t.student_id
             WHERE t.id = $1`,
            [transactionId]
        );
        if (result.rows.length === 0) return;
        const row = result.rows[0];
        const amount = parseFloat(row.amount);
        const productName = row.product_name as string;
        const discount = parseFloat(row.list_price) - amount;

        await NotificationService.notifyPurchaseConfirmation(
            row.student_id,
            productName,
            amount,
            discount,
            row.id
        );
        if (row.total_savings != null) {
            await NotificationService.notifySavingsMilestone(
                row.student_id,
                parseFloat(row.total_savings)
            );
        }
        if (row.student_email) {
            await sendPurchaseConfirmationEmail(
                row.student_email,
                productName,
                amount,
                row.id
            );
        }

        await NotificationService.notifyVendorNewOrder({
            vendorUserId: row.vendor_user_id,
            productName,
            amount,
            transactionId: row.id,
        });
        if (row.vendor_email) {
            await sendVendorNewOrderEmail(
                row.vendor_email,
                productName,
                amount,
                row.id
            );
        }
    } catch (error) {
        appLogger.error('Commerce notification/email failed', error);
    }
}

export async function completeMarketplaceTransaction(
    paystackReference: string,
    paidAmountNaira: number
): Promise<{ completed: boolean; transactionId?: string; newlyCompleted?: boolean }> {
    await db.query('BEGIN');
    let newlyCompleted = false;
    let transactionId: string | undefined;
    try {
        const txResult = await db.query(
            `SELECT t.*, p.price AS list_price
             FROM transactions t
             JOIN products p ON p.id = t.product_id
             WHERE t.paystack_reference = $1
             FOR UPDATE OF t`,
            [paystackReference]
        );

        if (txResult.rows.length === 0) {
            await db.query('ROLLBACK');
            return { completed: false };
        }

        const tx = txResult.rows[0];
        transactionId = tx.id;

        if (tx.status === 'completed') {
            await db.query('COMMIT');
            return { completed: true, transactionId: tx.id, newlyCompleted: false };
        }

        if (tx.status === 'failed' || tx.status === 'refunded') {
            await db.query('COMMIT');
            return { completed: false, transactionId: tx.id };
        }

        const expectedKobo = Math.round(parseFloat(tx.amount) * 100);
        const paidKobo = Math.round(paidAmountNaira * 100);
        // Allow paid >= expected (Paystack may add gateway fees on top of our charge)
        if (paidKobo < expectedKobo) {
            await db.query('ROLLBACK');
            throw new BadRequestError('Payment amount mismatch');
        }

        const stockUpdate = await db.query(
            `UPDATE products
             SET stock = stock - 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND stock > 0 AND deleted_at IS NULL
             RETURNING id`,
            [tx.product_id]
        );

        if (stockUpdate.rows.length === 0) {
            // Only mark failed if still pending — never overwrite completed
            await db.query(
                `UPDATE transactions
                 SET status = 'failed', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1 AND status = 'pending'`,
                [tx.id]
            );
            await db.query('COMMIT');
            return { completed: false, transactionId: tx.id };
        }

        const completed = await db.query(
            `UPDATE transactions
             SET status = 'completed', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND status = 'pending'
             RETURNING id`,
            [tx.id]
        );

        if (completed.rows.length === 0) {
            // Another worker completed it (or status changed) — restore stock
            await db.query(
                `UPDATE products
                 SET stock = stock + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [tx.product_id]
            );
            await db.query('COMMIT');
            return { completed: true, transactionId: tx.id, newlyCompleted: false };
        }

        const savingsDelta = parseFloat(tx.list_price) - parseFloat(tx.amount);
        await db.query(
            `INSERT INTO savings_stats (student_id, total_savings, total_purchases, last_updated)
             VALUES ($1, $2, 1, CURRENT_TIMESTAMP)
             ON CONFLICT (student_id) DO UPDATE SET
               total_savings = savings_stats.total_savings + $2,
               total_purchases = savings_stats.total_purchases + 1,
               last_updated = CURRENT_TIMESTAMP`,
            [tx.student_id, savingsDelta]
        );

        await db.query('COMMIT');
        newlyCompleted = true;
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    }

    if (newlyCompleted && transactionId) {
        // Outside the DB transaction — failures must not roll back payment
        void emitCommerceNotifications(transactionId);
        return { completed: true, transactionId, newlyCompleted: true };
    }

    return { completed: true, ...(transactionId ? { transactionId } : {}), newlyCompleted: false };
}
