/**
 * One-off: settle a pending marketplace tx after Paystack success (webhook miss).
 * Usage: npx tsx scripts/settle-pending-tx.ts <paystack_reference>
 */
import dotenv from 'dotenv';
dotenv.config();

import { db } from '../src/config/database.js';
import { completeMarketplaceTransaction } from '../src/services/payment/checkout.service.js';
import { verifyPaystackPayment } from '../src/services/payment/paystack.service.js';

async function main() {
    const ref = process.argv[2];
    if (!ref) {
        console.error('Usage: npx tsx scripts/settle-pending-tx.ts <paystack_reference>');
        process.exit(1);
    }

    const verified = await verifyPaystackPayment(ref);
    console.log('verify:', verified);
    if (!verified.verified || verified.amount == null) {
        console.error('Payment not verified as success; aborting');
        process.exit(1);
    }

    const result = await completeMarketplaceTransaction(ref, verified.amount);
    console.log('complete:', result);

    const r = await db.query(
        'SELECT id, status, amount, updated_at FROM transactions WHERE paystack_reference = $1',
        [ref]
    );
    console.log('tx:', r.rows[0]);
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
