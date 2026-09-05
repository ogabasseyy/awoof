/** Operator recovery: reapply a pending payout to its confirmed Paystack subaccount. */
import { db } from '../config/database.js';
import { updatePaystackSubaccount } from '../services/payment/paystack.service.js';
import { getPlatformFeePercent } from '../services/payment/checkout.service.js';
import { z } from 'zod';

async function main() {
    const requestId = z.string().uuid().parse(process.argv[2]);
    const confirmedCode = z.string().regex(/^ACCT_[a-zA-Z0-9]+$/).parse(process.argv[3]);
    const fee = await getPlatformFeePercent();
    const client = await db.getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `SELECT r.*, v.paystack_subaccount_code
             FROM payout_change_requests r JOIN vendors v ON v.id = r.vendor_id
             WHERE r.id = $1 AND r.status = 'pending'
               AND r.updated_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes'
             FOR UPDATE OF r, v`, [requestId]);
        const request = result.rows[0];
        if (!request) throw new Error('Request is missing, already resolved, or too recent to reconcile');
        if (request.paystack_subaccount_code && request.paystack_subaccount_code !== confirmedCode) {
            throw new Error('Confirmed subaccount does not match the vendor');
        }
        await updatePaystackSubaccount(confirmedCode, {
            businessName: request.account_name.slice(0, 100),
            bankCode: request.bank_code,
            accountNumber: request.account_number,
            percentageCharge: fee,
        });
        await client.query(
            `UPDATE vendors SET bank_name=$1, bank_code=$2, account_number=$3,
             account_name=$4, paystack_subaccount_code=$5, updated_at=CURRENT_TIMESTAMP WHERE id=$6`,
            [request.bank_name, request.bank_code, request.account_number, request.account_name, confirmedCode, request.vendor_id]);
        await client.query(
            `UPDATE payout_change_requests SET status='applied', error=NULL,
             updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [requestId]);
        await client.query('COMMIT');
        console.log('Payout change reconciled');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

main().catch(() => {
    console.error('Reconciliation failed; the pending change is retained. Check the request and provider configuration.');
    process.exitCode = 1;
}).finally(() => db.close());
