/**
 * Marketplace checkout helpers — commission math and transaction completion.
 */

import { db } from '../../config/database.js';
import { BadRequestError } from '../../common/errors/AppError.js';

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

export async function completeMarketplaceTransaction(
    paystackReference: string,
    paidAmountNaira: number
): Promise<{ completed: boolean; transactionId?: string }> {
    const txResult = await db.query(
        `SELECT t.*, p.price AS list_price, p.stock
         FROM transactions t
         JOIN products p ON p.id = t.product_id
         WHERE t.paystack_reference = $1`,
        [paystackReference]
    );

    if (txResult.rows.length === 0) {
        return { completed: false };
    }

    const tx = txResult.rows[0];

    if (tx.status === 'completed') {
        return { completed: true, transactionId: tx.id };
    }

    const expectedKobo = Math.round(parseFloat(tx.amount) * 100);
    const paidKobo = Math.round(paidAmountNaira * 100);
    if (expectedKobo !== paidKobo) {
        throw new BadRequestError('Payment amount mismatch');
    }

    await db.query('BEGIN');
    try {
        const stockUpdate = await db.query(
            `UPDATE products
             SET stock = stock - 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND stock > 0 AND deleted_at IS NULL
             RETURNING id`,
            [tx.product_id]
        );

        if (stockUpdate.rows.length === 0) {
            await db.query(
                `UPDATE transactions
                 SET status = 'failed', updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [tx.id]
            );
            await db.query('COMMIT');
            return { completed: false };
        }

        await db.query(
            `UPDATE transactions
             SET status = 'completed', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [tx.id]
        );

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
        return { completed: true, transactionId: tx.id };
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    }
}
