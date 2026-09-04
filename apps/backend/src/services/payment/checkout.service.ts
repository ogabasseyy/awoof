/**
 * Marketplace checkout helpers — commission math and transaction completion.
 */

import { db } from '../../config/database.js';
import type { PoolClient } from 'pg';
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
    const configuredFee = Number.parseFloat(result.rows[0].value);
    return Number.isFinite(configuredFee) ? configuredFee : 10;
}

async function emitCommerceNotifications(transactionId: string): Promise<void> {
    try {
        const claimed = await db.query(
            `UPDATE commerce_notification_outbox
         SET status = 'processing', attempts = attempts + 1,
             processing_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
             last_error = NULL
         WHERE transaction_id = $1
           AND (status IN ('pending', 'failed')
                OR (status = 'processing' AND processing_started_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes'))
         RETURNING transaction_id`,
            [transactionId]
        );
        if (claimed.rows.length === 0) return;

        const result = await db.query(
            `SELECT t.id, t.amount, t.student_id, t.vendor_id,
                    p.name AS product_name, p.price AS list_price,
                    s.user_id AS student_user_id, su.email AS student_email,
                    v.user_id AS vendor_user_id, vu.email AS vendor_email,
                    ss.total_savings, o.student_notified, o.savings_notified,
                    o.student_emailed, o.vendor_notified, o.vendor_emailed
             FROM transactions t
             JOIN commerce_notification_outbox o ON o.transaction_id = t.id
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

        if (!row.student_notified) {
            await NotificationService.notifyPurchaseConfirmation(
                row.student_id, productName, amount, discount, row.id
            );
            await db.query('UPDATE commerce_notification_outbox SET student_notified = true WHERE transaction_id = $1', [row.id]);
        }
        if (!row.savings_notified && row.total_savings != null) {
            await NotificationService.notifySavingsMilestone(
                row.student_id,
                parseFloat(row.total_savings)
            );
            await db.query('UPDATE commerce_notification_outbox SET savings_notified = true WHERE transaction_id = $1', [row.id]);
        }
        if (!row.student_emailed && row.student_email) {
            const result = await sendPurchaseConfirmationEmail(
                row.student_email,
                productName,
                amount,
                row.id
            );
            if (!result.success) throw new Error(result.error || 'Student receipt email failed');
            await db.query('UPDATE commerce_notification_outbox SET student_emailed = true WHERE transaction_id = $1', [row.id]);
        }

        if (!row.vendor_notified) {
            await NotificationService.notifyVendorNewOrder({
                vendorUserId: row.vendor_user_id,
                productName,
                amount,
                transactionId: row.id,
            });
            await db.query('UPDATE commerce_notification_outbox SET vendor_notified = true WHERE transaction_id = $1', [row.id]);
        }
        if (!row.vendor_emailed && row.vendor_email) {
            const result = await sendVendorNewOrderEmail(
                row.vendor_email,
                productName,
                amount,
                row.id
            );
            if (!result.success) throw new Error(result.error || 'Vendor order email failed');
            await db.query('UPDATE commerce_notification_outbox SET vendor_emailed = true WHERE transaction_id = $1', [row.id]);
        }
        await db.query(
            `UPDATE commerce_notification_outbox
             SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP, last_error = NULL
             WHERE transaction_id = $1`,
            [transactionId]
        );
    } catch (error) {
        await db.query(
            `UPDATE commerce_notification_outbox
             SET status = 'failed', updated_at = CURRENT_TIMESTAMP,
                 last_error = $2
             WHERE transaction_id = $1`,
            [transactionId, error instanceof Error ? error.message.slice(0, 500) : 'Unknown delivery error']
        );
        appLogger.error('Commerce notification/email failed', error);
    }
}

export async function drainCommerceNotificationOutbox(limit = 25): Promise<void> {
    const pending = await db.query(
        `SELECT transaction_id FROM commerce_notification_outbox
         WHERE status IN ('pending', 'failed')
            OR (status = 'processing' AND processing_started_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes')
         ORDER BY created_at
         LIMIT $1`,
        [limit]
    );
    for (const row of pending.rows) {
        await emitCommerceNotifications(row.transaction_id);
    }
}

export function startCommerceNotificationDispatcher(): void {
    const run = () => {
        void drainCommerceNotificationOutbox().catch((error) => {
            appLogger.error('Commerce notification outbox dispatcher failed', error);
        });
    };
    run();
    const timer = setInterval(run, 60_000);
    timer.unref();
}

export async function completeMarketplaceTransaction(
    paystackReference: string,
    paidAmountNaira: number
): Promise<{ completed: boolean; transactionId?: string; newlyCompleted?: boolean }> {
    // A transaction is connection-scoped in PostgreSQL. Keep every statement on
    // one checked-out client so stock, payment, and savings updates are atomic.
    const client = await db.getPool().connect();
    try {
        const result = await completeMarketplaceTransactionWithClient(
            client,
            paystackReference,
            paidAmountNaira
        );

        if (result.completed && result.transactionId) {
            // Outside the DB transaction — failures must not roll back payment.
            void emitCommerceNotifications(result.transactionId).catch((error) => {
                appLogger.error('Commerce notification dispatch failed', error);
            });
        }

        return result;
    } finally {
        client.release();
    }
}

/**
 * Transactional core exported for deterministic tests. Callers must supply one
 * checked-out client; using Pool.query here would break transaction isolation.
 */
export async function completeMarketplaceTransactionWithClient(
    client: Pick<PoolClient, 'query'>,
    paystackReference: string,
    paidAmountNaira: number
): Promise<{ completed: boolean; transactionId?: string; newlyCompleted?: boolean }> {
    let transactionOpen = false;
    try {
        await client.query('BEGIN');
        transactionOpen = true;

        const txResult = await client.query(
            `SELECT t.*, p.price AS list_price
             FROM transactions t
             JOIN products p ON p.id = t.product_id
             WHERE t.paystack_reference = $1
             FOR UPDATE OF t`,
            [paystackReference]
        );

        if (txResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return { completed: false };
        }

        const tx = txResult.rows[0];

        if (tx.status === 'completed') {
            await client.query('COMMIT');
            return { completed: true, transactionId: tx.id, newlyCompleted: false };
        }

        if (tx.status === 'failed' || tx.status === 'refunded' || tx.status === 'requires_refund') {
            await client.query('COMMIT');
            return { completed: false, transactionId: tx.id };
        }

        const expectedKobo = Math.round(parseFloat(tx.amount) * 100);
        const paidKobo = Math.round(paidAmountNaira * 100);
        // Allow paid >= expected (Paystack may add gateway fees on top of our charge).
        // A successful but insufficient charge requires operator reconciliation.
        if (paidKobo < expectedKobo) {
            await client.query(
                `UPDATE transactions
                 SET status = 'requires_refund', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1 AND status = 'pending'`,
                [tx.id]
            );
            await client.query(
                `INSERT INTO payment_reconciliation_queue
                    (transaction_id, paystack_reference, paid_amount, reason)
                 VALUES ($1, $2, $3, 'amount_mismatch')
                 ON CONFLICT (transaction_id) DO NOTHING`,
                [tx.id, paystackReference, paidAmountNaira]
            );
            await client.query('COMMIT');
            return { completed: false, transactionId: tx.id };
        }

        const stockUpdate = await client.query(
            `UPDATE products
             SET stock = stock - 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND stock > 0 AND deleted_at IS NULL
             RETURNING id`,
            [tx.product_id]
        );

        if (stockUpdate.rows.length === 0) {
            // The charge has succeeded but fulfillment cannot continue. Record
            // this durably in the same transaction so an operator can refund it.
            await client.query(
                `UPDATE transactions
                 SET status = 'requires_refund', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1 AND status = 'pending'`,
                [tx.id]
            );
            await client.query(
                `INSERT INTO payment_reconciliation_queue
                    (transaction_id, paystack_reference, paid_amount, reason)
                 VALUES ($1, $2, $3, 'stock_unavailable')
                 ON CONFLICT (transaction_id) DO NOTHING`,
                [tx.id, paystackReference, paidAmountNaira]
            );
            await client.query('COMMIT');
            return { completed: false, transactionId: tx.id };
        }

        const completed = await client.query(
            `UPDATE transactions
             SET status = 'completed', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND status = 'pending'
             RETURNING id`,
            [tx.id]
        );

        if (completed.rows.length === 0) {
            // Another worker completed it (or status changed) — restore stock
            await client.query(
                `UPDATE products
                 SET stock = stock + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [tx.product_id]
            );
            await client.query('COMMIT');
            return { completed: true, transactionId: tx.id, newlyCompleted: false };
        }

        const savingsDelta = parseFloat(tx.list_price) - parseFloat(tx.amount);
        await client.query(
            `INSERT INTO savings_stats (student_id, total_savings, total_purchases, last_updated)
             VALUES ($1, $2, 1, CURRENT_TIMESTAMP)
             ON CONFLICT (student_id) DO UPDATE SET
               total_savings = savings_stats.total_savings + $2,
               total_purchases = savings_stats.total_purchases + 1,
               last_updated = CURRENT_TIMESTAMP`,
            [tx.student_id, savingsDelta]
        );

        await client.query(
            `INSERT INTO commerce_notification_outbox (transaction_id)
             VALUES ($1)
             ON CONFLICT (transaction_id) DO NOTHING`,
            [tx.id]
        );

        await client.query('COMMIT');
        return { completed: true, transactionId: tx.id, newlyCompleted: true };
    } catch (error) {
        if (transactionOpen) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                appLogger.error('Marketplace transaction rollback failed', rollbackError);
            }
        }
        throw error;
    }
}
